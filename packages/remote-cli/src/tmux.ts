/**
 * tmux-backed session management.
 *
 * Two uses, one battle-tested multiplexer:
 *  - LOCAL sessions: `remote run <profile>` starts the CLI inside a local tmux
 *    session (`remote-<slug>`), so `remote ls`/`attach`/`stop` manage local and
 *    remote sessions uniformly, and detach/reattach is native.
 *  - REMOTE attach via exec: `remote attach <id> --exec` runs
 *    `kubectl exec -it … tmux attach` straight into the Pod's tmux session, so
 *    the LOCAL terminal owns scrollback + copy (OSC52) with no WS proxy in the
 *    middle — this is what fixes "I can't copy the code claude printed".
 */

import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type { TunnelConfig } from "./config.js";

const TMUX = "tmux";

/** tmux session-name prefix marking a remote-managed local session. */
export const LOCAL_PREFIX = "remote-";

/** Pod tmux session the session-agent runs the CLI in (see agent.ts). */
export const POD_TMUX_SESSION = "main";

/**
 * Persistent-box wrapper (local twin of the Pod one): run the CLI, and when it
 * exits drop into a login shell on the workdir instead of ending the tmux
 * session. `$0` is a label, `$1` is the CLI, the rest are its args.
 */
const LOCAL_WRAPPER = `cli="$1"; shift
"$cli" "$@"; code=$?
printf '\\n[remote] %s exited (code %s) — shell on %s. Re-run it or Ctrl-D to end this session.\\n' "$cli" "$code" "$PWD"
exec /bin/bash -l`;

/**
 * Same drop-to-shell contract for SIDE windows (h2a, …), but the command is a
 * single configured shell line (quoting preserved via eval), not cli+args.
 * `$0` is a label, `$1` is the command line.
 */
const WINDOW_WRAPPER = `cmd="$1"
eval "$cmd"; code=$?
printf '\\n[remote] %s exited (code %s) — shell on %s. Re-run it or Ctrl-D to end this window.\\n' "$cmd" "$code" "$PWD"
exec /bin/bash -l`;

/**
 * Window name for the h2a MCP server side window — the a2a launcher contract:
 * agents live in NAMED tmux windows, with `h2a mcp-serve` running next to them
 * so the agent is reachable/wakeable through ~/h2a-workspace/.h2a.
 */
export const H2A_WINDOW_NAME = "h2a";

export type LocalSession = {
  /** full tmux session name, e.g. `remote-surch` */
  name: string;
  /** short name shown to the user, e.g. `surch` */
  slug: string;
  /** profile recorded on the session (claude/codex/…), or "?" if unknown */
  profile: string;
  /** working directory */
  path: string;
  /** is a client currently attached */
  attached: boolean;
};

export function tmuxAvailable(): boolean {
  try {
    return spawnSync(TMUX, ["-V"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function slugify(p: string): string {
  const base = basename(p).replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  return base || "session";
}

/** tmux session name for a workdir slug. */
export function localSessionName(slug: string): string {
  return slug.startsWith(LOCAL_PREFIX) ? slug : `${LOCAL_PREFIX}${slug}`;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** List remote-managed local tmux sessions (best-effort; [] if no server). */
export function listLocalSessions(): LocalSession[] {
  if (!tmuxAvailable()) return [];
  const r = spawnSync(
    TMUX,
    [
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_attached}\t#{session_path}\t#{@profile}",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) return [];
  const out: LocalSession[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [name, attached, path, profile] = line.split("\t");
    if (!name || !name.startsWith(LOCAL_PREFIX)) continue;
    out.push({
      name,
      slug: name.slice(LOCAL_PREFIX.length),
      profile: profile || "?",
      path: path || "",
      attached: attached === "1",
    });
  }
  return out;
}

/** Find a local session by its full name or its slug. */
export function findLocalSession(target: string): LocalSession | undefined {
  const sessions = listLocalSessions();
  return sessions.find((s) => s.name === target || s.slug === target);
}

export type StartLocalResult = { name: string; slug: string };

/**
 * First clipboard CLI found on PATH, or undefined. With `mouse on`, a mouse
 * drag is captured by tmux (copy-mode) instead of the terminal's NATIVE
 * selection, so Ctrl+Shift+C / right-click-Copy see nothing. tmux's own copy
 * goes through OSC52 (set-clipboard) — but VTE/gnome-terminal silently DROP
 * OSC52 clipboard writes, so the copy lands nowhere. Piping copy-mode to a real
 * clipboard tool (copy-command, tmux ≥3.2) is the reliable local fix; Wayland
 * first, then X11.
 */
function detectClipboardCommand(): string | undefined {
  const candidates = process.env.WAYLAND_DISPLAY
    ? ["wl-copy", "xclip -selection clipboard", "xsel -ib"]
    : ["xclip -selection clipboard", "xsel -ib", "wl-copy"];
  for (const c of candidates) {
    const bin = c.split(" ")[0]!;
    if (spawnSync("command", ["-v", bin], { shell: true, stdio: "ignore" }).status === 0) {
      return c;
    }
  }
  return undefined;
}

/**
 * Make the LOCAL tmux server scroll the conversation on the wheel AND copy
 * selections to the system clipboard — same scroll settings the Pod image bakes
 * into /etc/tmux.conf. Without `mouse on`, the terminal falls back to
 * alternateScroll (wheel → arrow keys → the CLI's input history), which reads as
 * "scrolling scrolls the input history". With mouse on, a drag is tmux's
 * selection: `copy-command` pipes it to wl-copy/xclip so Ctrl+Shift+V / paste
 * works (VTE drops OSC52, so set-clipboard alone is not enough). Native
 * selection (for Ctrl+Shift+C) stays available via Shift+drag. Global,
 * idempotent, applied at every run/attach so it works even without ~/.tmux.conf.
 */
export function ensureScrollConfig(): void {
  const cmds: Array<ReadonlyArray<string>> = [
    ["set", "-g", "mouse", "on"],
    ["set", "-g", "set-clipboard", "on"],
    ["set", "-g", "focus-events", "on"],
    [
      "bind",
      "-n",
      "WheelUpPane",
      "if",
      "-Ft=",
      "#{pane_in_mode}",
      "send-keys -M",
      "copy-mode -e; send-keys -M",
    ],
    ["bind", "-n", "WheelDownPane", "send-keys", "-M"],
    ["bind", "-n", "PPage", "copy-mode", "-eu"],
  ];
  // copy-command makes every copy-pipe-and-cancel (mouse drag, double/triple
  // click) land in the real system clipboard. tmux's defaults already use
  // copy-pipe-and-cancel with no argument → they honour copy-command.
  const clip = detectClipboardCommand();
  if (clip) cmds.push(["set", "-g", "copy-command", clip]);
  for (const args of cmds) {
    // Best-effort: no server yet / old tmux must never fail the caller.
    spawnSync(TMUX, [...args], { stdio: "ignore" });
  }
}

/**
 * Start a CLI in a detached local tmux session. Idempotent on name: if a
 * session with the same slug already exists it is reused (returns it). The slug
 * defaults to the workdir basename; pass `label` to override it (e.g. to keep
 * several sessions of the same project distinct: "sentropic#2").
 */
export function startLocalSession(
  profile: string,
  command: string,
  cwd: string,
  args: ReadonlyArray<string> = [],
  label?: string,
): StartLocalResult {
  const slug = slugify(label ?? cwd);
  const name = localSessionName(slug);
  ensureScrollConfig();
  if (findLocalSession(name)) return { name, slug };

  const r = spawnSync(
    TMUX,
    [
      "new-session",
      "-d",
      "-s",
      name,
      // Launcher contract (a2a): the agent's window is NAMED after the profile
      // (claude/codex/…). One-shot name at creation only — we never touch the
      // automatic-rename option, so live titles elsewhere keep working.
      "-n",
      profile,
      "-c",
      cwd,
      "/bin/bash",
      "-lc",
      LOCAL_WRAPPER,
      "remote-session",
      command,
      ...args,
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) {
    throw new Error(`tmux new-session failed (exit ${r.status ?? "?"})`);
  }
  // Record the profile as a session option so `remote ls` can show it.
  spawnSync(TMUX, ["set-option", "-t", name, "@profile", profile], {
    stdio: "ignore",
  });
  return { name, slug };
}

/**
 * tmux args adding a detached NAMED window to an existing session, running
 * `commandLine` (a shell line, quoting preserved) under the drop-to-shell
 * wrapper. Pure — exported for tests.
 */
export function buildSessionWindowArgs(
  session: string,
  windowName: string,
  cwd: string,
  commandLine: string,
): string[] {
  return [
    "new-window",
    "-d",
    "-t",
    session,
    "-n",
    windowName,
    "-c",
    cwd,
    "/bin/bash",
    "-lc",
    WINDOW_WRAPPER,
    "remote-window",
    commandLine,
  ];
}

/** Window names of a session (best-effort; [] if tmux/session is gone). */
export function sessionWindowNames(session: string): string[] {
  const r = spawnSync(
    TMUX,
    ["list-windows", "-t", session, "-F", "#{window_name}"],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split("\n").filter(Boolean);
}

/** Add a detached named window running `commandLine` to an existing session. */
export function addSessionWindow(
  session: string,
  windowName: string,
  cwd: string,
  commandLine: string,
): boolean {
  const r = spawnSync(
    TMUX,
    buildSessionWindowArgs(session, windowName, cwd, commandLine),
    { stdio: "ignore" },
  );
  return r.status === 0;
}

/** Is `cmd` resolvable in PATH (login shell, same as the tmux windows use)? */
export function commandAvailable(cmd: string): boolean {
  try {
    return (
      spawnSync("bash", ["-lc", `command -v -- ${cmd}`], { stdio: "ignore" })
        .status === 0
    );
  } catch {
    return false;
  }
}

/**
 * Opt-in launcher contract: start `h2a mcp-serve …` in a side window named
 * "h2a" of the agent's tmux session, so the agent is reachable/wakeable by the
 * h2a file-based network. Never fails the run: a missing h2a binary (or tmux
 * error) is a warning, and an already-present "h2a" window is reused as-is.
 */
export function startH2aWindow(
  session: string,
  cwd: string,
  commandLine: string,
  stderr: { write(chunk: string): unknown } = process.stderr,
): boolean {
  const bin = commandLine.trim().split(/\s+/)[0] ?? "";
  if (!bin || !commandAvailable(bin)) {
    stderr.write(
      `[remote] h2a window skipped: \`${bin || commandLine}\` not found in PATH — install h2a (or fix the h2a.command config) and re-run with --h2a.\n`,
    );
    return false;
  }
  if (sessionWindowNames(session).includes(H2A_WINDOW_NAME)) return true;
  if (!addSessionWindow(session, H2A_WINDOW_NAME, cwd, commandLine)) {
    stderr.write(
      `[remote] h2a window failed to start (tmux new-window error on ${session})\n`,
    );
    return false;
  }
  return true;
}

/**
 * Attach the real terminal to a local tmux session. Blocks until the user
 * detaches (Ctrl-b d) or the session ends. Returns the tmux exit status.
 */
export function attachLocalSession(name: string): number {
  ensureScrollConfig();
  const r = spawnSync(TMUX, ["attach", "-t", name], { stdio: "inherit" });
  return r.status ?? 0;
}

/** Kill a local tmux session. */
export function killLocalSession(name: string): boolean {
  const r = spawnSync(TMUX, ["kill-session", "-t", name], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * Attach the real terminal straight into the Pod's tmux session via
 * `kubectl exec -it`. The local terminal talks to tmux directly (no WS proxy),
 * so scrollback + copy-to-local-clipboard (OSC52) work natively. Requires a
 * tmux-backed session (Pod started by the tmux-wrapping agent). Blocks until
 * detach/exit; returns the kubectl exit status.
 */
export function attachPodTmux(
  tunnel: TunnelConfig,
  sessionId: string,
): number {
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  // The attach CLIENT must be UTF-8 or tmux transcodes accented output to "_"
  // for it: the Pod's default locale is empty (ASCII), so we force it on the
  // exec'd tmux client — `env LANG=C.UTF-8` (so tmux detects UTF-8) + `tmux -u`
  // (force UTF-8 regardless of detection). (capture-pane never transcodes, which
  // is why a capture test looked fine while the interactive attach showed "_".)
  const r = spawnSync(
    "kubectl",
    [
      "-n",
      tunnel.namespace,
      "exec",
      "-it",
      `session-${sessionId}`,
      "-c",
      "session-agent",
      "--",
      "env",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "tmux",
      "-u",
      "new-session",
      "-A",
      "-s",
      POD_TMUX_SESSION,
    ],
    { stdio: "inherit", env },
  );
  return r.status ?? 0;
}
