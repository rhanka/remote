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

import { getTmuxProfileConfig } from "./config.js";
import { readFileSync } from "node:fs";
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
 * session. Invoked as `bash -lc WRAPPER <relaunch> <cli> <args…>`, so the FIRST
 * positional lands in `$0` (the relaunch hint), the CLI in `$1`, args in `$2…`.
 */
export const LOCAL_WRAPPER = `relaunch="$0"; cli="$1"; shift
"$cli" "$@"; code=$?
printf '\\n[remote] %s exited (code %s) — shell on %s.\\n' "$cli" "$code" "$PWD"
printf '[remote] relaunch: %s   (or Ctrl-D to end this session)\\n' "$relaunch"
if [ -t 0 ]; then exec /bin/bash -l; else exit "$code"; fi`;

/**
 * Run-once-exit wrapper for HEADLESS delegated jobs — the OPPOSITE of
 * LOCAL_WRAPPER's drop-to-shell. Redirects the CLI's stdout+stderr to an output
 * log, writes a result.json with the final state + exit code, then lets the
 * tmux session END (no `exec bash`). Invoked as
 * `bash -lc HEADLESS_WRAPPER <resultJson> <outputLog> <cli> <args…>`:
 * `$0`=result.json path, `$1`=output.log path, `$2`=cli, `$3…`=cli args.
 */
export const HEADLESS_WRAPPER = `result="$0"; log="$1"; cli="$2"; shift 2
"$cli" "$@" >"$log" 2>&1; code=$?
if [ "$code" -eq 0 ]; then state=done; else state=failed; fi
printf '{"state":"%s","exitCode":%s}\\n' "$state" "$code" >"$result"`;

/**
 * The `remote run …` line that recreates this exact local session — shown when
 * the CLI exits so the user can copy-paste it. Pure, exported for tests.
 */
export function localRelaunchCommand(
  profile: string,
  cwd: string,
  label: string | undefined,
  resumeArgs: ReadonlyArray<string> = [],
): string {
  // resumeArgs is the CLI-native resume argv (e.g. ["--resume", id] /
  // ["resume", id]); the conversation id is its last token, surfaced as `-r`.
  const convId =
    resumeArgs.length > 0 ? resumeArgs[resumeArgs.length - 1] : undefined;
  let cmd = `remote run ${profile} ${cwd}`;
  if (label) cmd += ` --name ${label}`;
  if (convId && convId !== resumeArgs[0]) cmd += ` -r ${convId}`;
  return cmd;
}

/**
 * Distinct session labels for a fan-out of `count` parallel agents on one base.
 * `count <= 1` → just the base (the normal single-session case). `#k` suffixes
 * keep each tmux session distinct (the slug derives from the label), so you can
 * run more than the per-project layout cap of parallel claude/codex agents.
 */
export function fanoutLabels(base: string, count: number): string[] {
  if (count <= 1) return [base];
  return Array.from({ length: count }, (_v, i) => `${base}#${i + 1}`);
}

/**
 * Same drop-to-shell contract for SIDE windows (h2a, …), but the command is a
 * single configured shell line (quoting preserved via eval), not cli+args.
 * `$0` is a label, `$1` is the optional agent pane wake target, `$2` is the
 * command line. When present, `TMUX_PANE` is deliberately overridden before
 * `eval` so h2a's local-tmux wake driver targets the agent pane, not the h2a
 * side-window process.
 */
const WINDOW_WRAPPER = `agent_pane="$1"; cmd="$2"
if [ -n "$agent_pane" ]; then export TMUX_PANE="$agent_pane"; fi
eval "$cmd"; code=$?
printf '\\n[remote] %s exited (code %s) — shell on %s. Re-run it or Ctrl-D to end this window.\\n' "$cmd" "$code" "$PWD"
if [ -t 0 ]; then exec /bin/bash -l; else exit "$code"; fi`;

/**
 * Window name for the h2a MCP server side window — the a2a launcher contract:
 * agents live in NAMED tmux windows, with `h2a mcp-serve` running next to them
 * so the agent is reachable/wakeable through ~/h2a-workspace/.h2a.
 */
export const H2A_WINDOW_NAME = "h2a";
const AGENT_PANE_OPTION = "@remote_agent_pane";
const AGENT_HOST_OPTION = "@remote_agent_host";
const AGENT_CWD_OPTION = "@remote_agent_cwd";

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
  /** custom display name set via `remote rename`, if any */
  displayName?: string;
};

export function tmuxAvailable(): boolean {
  try {
    return spawnSync(TMUX, ["-V"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export function slugify(p: string): string {
  const base = basename(p)
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "session";
}

/** tmux session name for a workdir slug. */
export function localSessionName(slug: string): string {
  return slug.startsWith(LOCAL_PREFIX) ? slug : `${LOCAL_PREFIX}${slug}`;
}

const ANTHROPIC_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

function tmuxEnvironmentArgs(): string[] {
  const args: string[] = [];
  for (const key of ANTHROPIC_ENV_KEYS) {
    const value = process.env[key];
    if (value) args.push("-e", `${key}=${value}`);
  }
  return args;
}

function anthopicEnvUnsetCommandPrefix(): string[] {
  // tmux sessions inherit the tmux *server* environment too. If remote deliberately
  // launches direct/default with no Anthropic env in its own process, scrub stale
  // gateway/API-key variables that an older tmux server may still carry.
  return ANTHROPIC_ENV_KEYS.some((key) => Boolean(process.env[key]))
    ? []
    : ["env", ...ANTHROPIC_ENV_KEYS.flatMap((key) => ["-u", key])];
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** List remote-managed local tmux sessions (best-effort; [] if no server). */
export function listLocalSessions(): LocalSession[] {
  if (!tmuxAvailable()) return [];
  const r = spawnSync(
    TMUX,
    [
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_attached}\t#{session_path}\t#{@profile}\t#{@display_name}",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) return [];
  const out: LocalSession[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [name, attached, path, profile, displayName] = line.split("\t");
    if (!name || !name.startsWith(LOCAL_PREFIX)) continue;
    const session: LocalSession = {
      name,
      slug: name.slice(LOCAL_PREFIX.length),
      profile: profile || "?",
      path: path || "",
      attached: Number(attached) > 0,
    };
    if (displayName && displayName.trim()) {
      session.displayName = displayName.trim();
    }
    out.push(session);
  }
  return out;
}

/** Find a local session by its full name or its slug. */
export function findLocalSession(target: string): LocalSession | undefined {
  const sessions = listLocalSessions();
  return sessions.find((s) => s.name === target || s.slug === target);
}

/**
 * Store a custom display name on a local tmux session WITHOUT calling
 * `rename-window`. This avoids tmux's per-window `allow-rename off` side-effect
 * that an explicit `rename-window` triggers — keeping the window name free to
 * follow the agent's live OSC title (activity status). The name is persisted as a
 * tmux session option `@display_name` and surfaced by `listLocalSessions` /
 * `remote ls`.
 */
export function setLocalSessionDisplayName(
  session: string,
  displayName: string,
): boolean {
  const r = spawnSync(
    TMUX,
    [
      "set-option",
      "-t",
      exactSessionTarget(session),
      "@display_name",
      displayName,
    ],
    { stdio: "ignore" },
  );
  return r.status === 0;
}

/**
 * Read the custom display name stored on a local tmux session via
 * `setLocalSessionDisplayName`, if any. Returns `undefined` when no display name
 * has been set or the session cannot be reached.
 */
export function getLocalSessionDisplayName(
  session: string,
): string | undefined {
  const r = spawnSync(
    TMUX,
    ["show-options", "-qv", "-t", exactSessionTarget(session), "@display_name"],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || r.stdout === undefined) return undefined;
  const v = r.stdout.trim();
  return v || undefined;
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
    if (
      spawnSync("command", ["-v", bin], { shell: true, stdio: "ignore" })
        .status === 0
    ) {
      return c;
    }
  }
  return undefined;
}

/**
 * Pure builder for the global tmux options applied at every run/attach. Split
 * out of `ensureScrollConfig` so the option set (scroll/clipboard AND the
 * title-following options for the GNOME tab) is unit-testable without a tmux
 * server. `clip` is the detected clipboard command (undefined → no copy-command).
 *
 * Title chain (bug #1 — "the tab name doesn't follow the agent"): the agent
 * (claude/codex) emits its live title as an OSC sequence, which tmux records as
 * `pane_title`. tmux only RE-EMITS that title to the OUTER terminal (the GNOME
 * tab) when `set-titles on`; it is OFF by default, so the OSC title was trapped
 * inside tmux and the GNOME tab kept the static launcher `--title`. We turn
 * `set-titles on` and point `set-titles-string` at `#{pane_title}` (the agent's
 * live title) with a friendly fallback (the window name, then the session name)
 * when the agent has not set a title yet. `allow-rename on` lets the window NAME
 * track the OSC title too. We deliberately NEVER touch `automatic-rename`
 * (project rule); it stays at its default `on`, which is what lets the window
 * follow the title.
 */
export function buildTmuxGlobalOptions(
  clip: string | undefined,
  profile = "remote",
): Array<ReadonlyArray<string>> {
  const cmds: Array<ReadonlyArray<string>> = [
    // Mark this server as remote-managed so diagnostics can tell user config
    // apart from the embedded profile remote applies idempotently.
    ["set", "-g", "@remote_profile", profile],
    // Match the proven old-PC tmux baseline used by Antoine's remote sessions.
    ["set", "-g", "allow-passthrough", "on"],
    ["set", "-g", "history-limit", "50000"],
    ["set", "-g", "default-terminal", "tmux-256color"],
    ["set", "-g", "terminal-overrides", ",*256col*:Tc,xterm*:Tc,gnome*:Tc"],
    ["set", "-g", "mouse", "on"],
    ["set", "-g", "set-clipboard", "on"],
    ["set", "-g", "focus-events", "on"],
    ["set", "-g", "set-titles", "on"],
    ["set", "-g", "set-titles-string", "#{pane_title}"],
    ["set", "-g", "status-interval", "1"],
    ["setw", "-g", "automatic-rename", "on"],
    [
      "setw",
      "-g",
      "automatic-rename-format",
      "#{?pane_title,#{pane_title},#{pane_current_command}}",
    ],
    // Ignore \033k manual renames so OSC pane_title keeps driving live names.
    ["setw", "-g", "allow-rename", "off"],
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
    buildCodexImagePasteBinding(),
  ];
  // copy-command makes every copy-pipe-and-cancel (mouse drag, double/triple
  // click) land in the real system clipboard. tmux's defaults already use
  // copy-pipe-and-cancel with no argument → they honour copy-command.
  if (clip) cmds.push(["set", "-g", "copy-command", clip]);
  return cmds;
}

/**
 * Wayland image paste bridge for Codex panes. Terminals/tmux cannot paste image
 * bytes into a TTY, so the reliable path is: read the clipboard image with
 * wl-paste, save it under the pane cwd, then paste the resulting file path into
 * Codex. The binding is guarded by the current tmux session/window profile and
 * clipboard MIME type; when the guard fails, Ctrl+V is forwarded unchanged.
 */
export function buildCodexImagePasteBinding(): ReadonlyArray<string> {
  const condition = [
    "command -v wl-paste >/dev/null 2>&1",
    'wl-paste --list-types 2>/dev/null | grep -Eq "^(image/png|image/jpeg)$"',
    // Check @profile (set by remote run) OR window_name OR pane_current_command.
    // pane_current_command is often "node" for Codex (not "codex"), so @profile
    // is the reliable discriminant when the session was started via `remote run`.
    'tmux display-message -p "#{@profile}:#{window_name}:#{pane_current_command}" | grep -Eqi "(^|:)codex(:|$)"',
  ].join(" && ");
  // #{pane_id} is expanded by tmux at binding-fire time before the shell runs,
  // so the send-keys always targets the pane that triggered C-v even when the
  // run-shell -b shell is scheduled after a focus change.
  const script = [
    'PANE_TARGET="#{pane_id}"',
    'pane_cwd=$(tmux display-message -p -t "$PANE_TARGET" "#{pane_current_path}")',
    'dir="$pane_cwd/.remote/images"',
    'mkdir -p "$dir"',
    "mime=$(wl-paste --list-types | awk '/^image\\/png$/{print; exit} /^image\\/jpeg$/{print; exit}')",
    'case "$mime" in image/png) ext=png ;; image/jpeg) ext=jpg ;; *) exit 1 ;; esac',
    'file="$dir/paste-$(date +%Y%m%d-%H%M%S)-$$.$ext"',
    'wl-paste -t "$mime" > "$file"',
    'tmux send-keys -t "$PANE_TARGET" -l "$file"',
  ].join("; ");
  return [
    "bind",
    "-n",
    "C-v",
    "if-shell",
    "-b",
    condition,
    `run-shell -b ${shellSingleQuote(script)}`,
    "send-keys C-v",
  ];
}

/**
 * Make the LOCAL tmux server scroll the conversation on the wheel AND copy
 * selections to the system clipboard — same scroll settings the Pod image bakes
 * into /etc/tmux.conf. Without `mouse on`, the terminal falls back to
 * alternateScroll (wheel → arrow keys → the CLI's input history), which reads as
 * "scrolling scrolls the input history". With mouse on, a drag is tmux's
 * selection: `copy-command` pipes it to wl-copy/xclip so Ctrl+Shift+V / paste
 * works (VTE drops OSC52, so set-clipboard alone is not enough). Wheel events
 * follow the proven old-PC baseline: enter copy-mode on wheel-up and forward the
 * real mouse event (`send-keys -M`) instead of synthetic copy-mode scroll
 * commands. Native selection (for Ctrl+Shift+C) stays available via Shift+drag.
 * ALSO turns on the
 * title-following options (see buildTmuxGlobalOptions) so the GNOME tab tracks
 * the agent's live title. Global, idempotent, applied at every run/attach so it
 * works even without ~/.tmux.conf.
 */
export function ensureScrollConfig(
  profile = getTmuxProfileConfig().profile,
): void {
  const cmds = buildTmuxGlobalOptions(detectClipboardCommand(), profile);
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
  tmuxProfile = "remote",
): StartLocalResult {
  const slug = slugify(label ?? cwd);
  const name = localSessionName(slug);
  ensureScrollConfig(tmuxProfile);
  if (findLocalSession(name)) {
    persistAgentPaneMetadata(name, profile, cwd);
    return { name, slug };
  }

  const r = spawnSync(
    TMUX,
    [
      "new-session",
      "-d",
      ...tmuxEnvironmentArgs(),
      "-s",
      name,
      // Launcher contract (a2a): the agent's window is NAMED after the profile
      // (claude/codex/…). One-shot name at creation only — we never touch the
      // automatic-rename option, so live titles elsewhere keep working.
      "-n",
      profile,
      "-c",
      cwd,
      ...anthopicEnvUnsetCommandPrefix(),
      "/bin/bash",
      "-lc",
      LOCAL_WRAPPER,
      localRelaunchCommand(profile, cwd, label, args),
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
  persistAgentPaneMetadata(name, profile, cwd);
  return { name, slug };
}

/**
 * Start a HEADLESS delegated job in a detached local tmux session under the
 * run-once-exit wrapper: the CLI runs, its output is captured to `outputLog`,
 * a `resultJson` is written, then the session ENDS. The task lands as a single
 * argv token inside `args` (no shell concat). Idempotent on slug like
 * startLocalSession. Returns the session name + slug.
 */
export function startHeadlessSession(
  profile: string,
  command: string,
  cwd: string,
  args: ReadonlyArray<string>,
  resultJson: string,
  outputLog: string,
  label: string,
  tmuxProfile = "remote",
): StartLocalResult {
  const slug = slugify(label);
  const name = localSessionName(slug);
  ensureScrollConfig(tmuxProfile);
  if (findLocalSession(name)) return { name, slug };

  const r = spawnSync(
    TMUX,
    [
      "new-session",
      "-d",
      ...tmuxEnvironmentArgs(),
      "-s",
      name,
      "-n",
      profile,
      "-c",
      cwd,
      "/bin/bash",
      "-lc",
      HEADLESS_WRAPPER,
      resultJson,
      outputLog,
      command,
      ...args,
    ],
    { stdio: "ignore" },
  );
  if (r.status !== 0) {
    throw new Error(`tmux new-session failed (exit ${r.status ?? "?"})`);
  }
  spawnSync(TMUX, ["set-option", "-t", name, "@profile", profile], {
    stdio: "ignore",
  });
  return { name, slug };
}

/**
 * The raw tmux `#{session_attached}` count for a session: 0 = DETACHED (no client
 * attached), ≥1 = a client (a human terminal) is attached. `undefined` when the
 * session is gone / tmux can't be reached. The interactive throttle auto-resume
 * uses this as its HARD guard — it only ever nudges a pane whose count is 0, so
 * we never send keys into a session a human is driving. Best-effort.
 */
export function sessionAttachedCount(name: string): number | undefined {
  const r = spawnSync(
    TMUX,
    ["display", "-p", "-t", `=${name}`, "#{session_attached}"],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || r.stdout === undefined) return undefined;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Last `lines` of a session's main pane (interactive job logs). "" if gone. */
export function capturePane(name: string, lines = 200): string {
  const r = spawnSync(
    TMUX,
    ["capture-pane", "-p", "-t", name, "-S", `-${lines}`],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) return "";
  return r.stdout;
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
  agentPane?: string,
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
    agentPane ?? "",
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
  agentPane?: string,
): boolean {
  const r = spawnSync(
    TMUX,
    buildSessionWindowArgs(session, windowName, cwd, commandLine, agentPane),
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

function validTmuxPaneId(value: string | undefined): value is string {
  return value !== undefined && /^%\d+$/.test(value);
}

function exactSessionTarget(session: string): string {
  return session.startsWith("=") ? session : `=${session}`;
}

function readSessionOption(
  session: string,
  option: string,
): string | undefined {
  const r = spawnSync(
    TMUX,
    ["show-options", "-qv", "-t", exactSessionTarget(session), option],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || r.stdout === undefined) return undefined;
  const value = r.stdout.trim();
  return value || undefined;
}

function setSessionOption(
  session: string,
  option: string,
  value: string,
): void {
  spawnSync(
    TMUX,
    ["set-option", "-t", exactSessionTarget(session), option, value],
    {
      stdio: "ignore",
    },
  );
}

function firstNonH2aPane(session: string): string | undefined {
  const r = spawnSync(
    TMUX,
    [
      "list-panes",
      "-s",
      "-t",
      exactSessionTarget(session),
      "-F",
      "#{window_name}\t#{pane_id}",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) return undefined;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [windowName, paneId] = line.split("\t");
    if (windowName !== H2A_WINDOW_NAME && validTmuxPaneId(paneId)) {
      return paneId;
    }
  }
  return undefined;
}

/**
 * Resolve the durable agent pane for a given h2a instance.
 * Parses host:label[:uuid] → finds the matching managed tmux session
 * (remote-<label>, @remote_agent_host === host) → returns its @remote_agent_pane.
 * Returns undefined if no pane is known for this instance.
 */
export function resolveAgentPaneForInstance(
  instance: string,
): string | undefined {
  const parts = instance.split(":");
  if (parts.length < 2) return undefined;
  const host = parts[0];
  const label = parts[1];
  if (!host || !label) return undefined;
  const sessionName = localSessionName(label);
  const sessions = listLocalSessions();
  const match = sessions.find(
    (s) =>
      s.name === sessionName &&
      readSessionOption(s.name, AGENT_HOST_OPTION) === host,
  );
  if (!match) return undefined;
  return resolveAgentPane(match.name);
}

/** Agent pane used as h2a local-tmux wake target, persisted on the tmux session. */
export function resolveAgentPane(session: string): string | undefined {
  const stored = readSessionOption(session, AGENT_PANE_OPTION);
  if (validTmuxPaneId(stored)) return stored;
  const pane = firstNonH2aPane(session);
  if (pane) setSessionOption(session, AGENT_PANE_OPTION, pane);
  return pane;
}

function persistAgentPaneMetadata(
  session: string,
  profile: string,
  cwd: string,
): string | undefined {
  const pane = resolveAgentPane(session);
  if (!pane) return undefined;
  setSessionOption(session, AGENT_HOST_OPTION, profile);
  setSessionOption(session, AGENT_CWD_OPTION, cwd);
  return pane;
}

function commandNeedsLocalTmuxWake(commandLine: string): boolean {
  return /(?:^|\s)--wake(?:=|\s+)local-tmux(?:\s|$)/.test(commandLine);
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
  const needsLocalTmuxWake = commandNeedsLocalTmuxWake(commandLine);
  if (sessionWindowNames(session).includes(H2A_WINDOW_NAME)) {
    if (needsLocalTmuxWake) {
      stderr.write(
        `[remote] h2a window already exists in ${session}; wake target may be stale/wrong. Restart that window/session to pick up the agent pane target.\n`,
      );
    }
    return true;
  }
  const agentPane = resolveAgentPane(session);
  if (needsLocalTmuxWake && !agentPane) {
    stderr.write(
      `[remote] h2a window skipped: agent pane could not be resolved for ${session}; refusing to publish a false --wake local-tmux target.\n`,
    );
    return false;
  }
  if (
    !addSessionWindow(session, H2A_WINDOW_NAME, cwd, commandLine, agentPane)
  ) {
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
  const args = process.env.TMUX
    ? ["switch-client", "-t", `=${name}`]
    : ["attach-session", "-t", `=${name}`];
  const r = spawnSync(TMUX, args, { stdio: "inherit" });
  return r.status ?? 0;
}

export function currentTmuxSessionIs(name: string): boolean {
  if (!process.env.TMUX) return false;
  const r = spawnSync(TMUX, ["display-message", "-p", "#S"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 && r.stdout.trim() === name;
}

export function runLocalCliForeground(command: string, args: string[]): number {
  const r = spawnSync(command, args, { stdio: "inherit" });
  return r.status ?? 0;
}

/** Kill a local tmux session. */
export function killLocalSession(name: string): boolean {
  const r = spawnSync(TMUX, ["kill-session", "-t", name], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * M3 — is a `remote jobs conduct` conductor process running right now? Used by
 * `jobs ls` to warn when there are queued jobs but nothing to drain them. Matches
 * the conductor's command line via pgrep, NOT a tmux marker (the conductor may run
 * in any window/shell). Best-effort: any error (no pgrep, etc.) returns false so
 * we err toward SHOWING the advisory rather than hiding a real stall. Excludes the
 * current pid so a `conduct` process that itself shells out to `jobs ls` for
 * status doesn't self-detect.
 */
export function conductorRunning(): boolean {
  try {
    const r = spawnSync("pgrep", ["-f", "jobs +conduct"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status !== 0 || !r.stdout) return false;
    const pids = r.stdout
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    return pids.length > 0;
  } catch {
    return false;
  }
}

/**
 * True when a session's main pane is an IDLE shell (its CLI exited and dropped
 * to the wrapper's `bash -l`). Idle = pane command is bash/sh AND that pane
 * process has no child — the relaunch wrapper keeps the CLI as a child of bash,
 * so `pane_current_command` alone reads "bash" even with a live CLI; the child
 * count disambiguates. `/proc` scan because the relaunch wrapper context may
 * lack ps; falls back to ps when /proc is unavailable. Best-effort: on any
 * doubt returns false (treat as live → never disturbed).
 */
export function localSessionIdle(name: string): boolean {
  const disp = spawnSync(
    TMUX,
    ["display", "-p", "-t", name, "#{pane_pid} #{pane_current_command}"],
    { encoding: "utf8" },
  );
  if (disp.status !== 0 || !disp.stdout) return false;
  const [pidStr, cmd = ""] = disp.stdout.trim().split(/\s+/);
  if (cmd !== "bash" && cmd !== "sh") return false;
  const pid = Number(pidStr);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Count children of the pane shell.
  const children = spawnSync(
    "bash",
    [
      "-lc",
      `awk -v p="${pid}" '$1=="PPid:" && $2==p {c++} END{print c+0}' /proc/[0-9]*/status 2>/dev/null || ps --ppid ${pid} -o pid= 2>/dev/null | grep -c .`,
    ],
    { encoding: "utf8" },
  );
  const kids = Number((children.stdout ?? "").trim());
  return Number.isInteger(kids) && kids === 0;
}

export type LocalSessionGatewayEnvStatus =
  | "current"
  | "missing"
  | "stale"
  | "unknown";

function directChildPids(pid: number): number[] {
  const children = spawnSync("ps", ["--ppid", String(pid), "-o", "pid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (children.status !== 0 || !children.stdout) return [];
  return children.stdout
    .split("\n")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function readProcessEnvironment(pid: number): Record<string, string> | null {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    const env: Record<string, string> = {};
    for (const part of raw.split("\0")) {
      const i = part.indexOf("=");
      if (i > 0) env[part.slice(0, i)] = part.slice(i + 1);
    }
    return env;
  } catch {
    return null;
  }
}

/**
 * Inspect the real CLI child process under the tmux wrapper and compare its
 * Anthropic gateway env with the token remote is about to use. Unknown is
 * deliberately non-actionable; callers should only repair missing/stale.
 */
export function localSessionGatewayEnvStatus(
  name: string,
  expected: { baseUrl: string; authToken: string },
): LocalSessionGatewayEnvStatus {
  const disp = spawnSync(TMUX, ["display", "-p", "-t", name, "#{pane_pid}"], {
    encoding: "utf8",
  });
  if (disp.status !== 0 || !disp.stdout) return "unknown";
  const panePid = Number.parseInt(disp.stdout.trim(), 10);
  if (!Number.isInteger(panePid) || panePid <= 0) return "unknown";
  const [childPid] = directChildPids(panePid);
  const env = readProcessEnvironment(childPid ?? panePid);
  if (!env) return "unknown";
  const baseUrl = env.ANTHROPIC_BASE_URL;
  const authToken = env.ANTHROPIC_AUTH_TOKEN;
  if (!baseUrl || !authToken) return "missing";
  if (baseUrl !== expected.baseUrl || authToken !== expected.authToken) {
    return "stale";
  }
  return "current";
}

/**
 * Relaunch a CLI inside an EXISTING session's main pane, in situ: send the
 * command to the idle shell (it runs at the prompt; when it exits the shell is
 * still there). Does NOT recreate windows or go through `remote run`/the guard.
 */
export function relaunchInSession(name: string, command: string): boolean {
  const r = spawnSync(TMUX, ["send-keys", "-t", name, command, "Enter"], {
    stdio: "ignore",
  });
  return r.status === 0;
}

/**
 * Is a tmux session ATTACHED right now (a client is connected)? Reads
 * `#{session_attached}` for the EXACT session ("=" prefix → no prefix match).
 * Returns true (CONSERVATIVE) on ANY doubt — missing/erroring tmux, unparseable
 * count — so the interactive throttle resume NEVER types into a pane we cannot
 * prove is detached. The throttle-phase-2 HARD GUARD lives here AND in the pure
 * planner; this is the live, last-line-of-defence re-check.
 */
export function sessionAttached(name: string): boolean {
  try {
    const r = spawnSync(
      TMUX,
      ["display", "-p", "-t", `=${name}`, "#{session_attached}"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) return true; // can't tell → assume attached (never nudge)
    const n = Number((r.stdout ?? "").trim());
    if (!Number.isInteger(n)) return true; // unparseable → assume attached
    return n !== 0;
  } catch {
    return true; // tmux blew up → assume attached (never nudge)
  }
}

/**
 * Send a LITERAL line into a session's main pane, then submit it with a real
 * Enter key event. The keys ride `send-keys -l <keys>` as a SINGLE literal
 * argument — tmux does NOT interpret it (no key-name lookup, no shell), so an
 * arbitrary nudge string is safe. Enter is sent as a separate, NON-literal
 * key-name so it is a real carriage return rather than the word "Enter". Used by
 * the interactive throttle auto-resume to un-stick a rate-limited pane. Returns
 * whether tmux accepted both sends.
 */
export function sendKeysLiteral(name: string, keys: string): boolean {
  const typed = spawnSync(TMUX, ["send-keys", "-t", name, "-l", keys], {
    stdio: "ignore",
  });
  if (typed.status !== 0) return false;
  const enter = spawnSync(TMUX, ["send-keys", "-t", name, "Enter"], {
    stdio: "ignore",
  });
  return enter.status === 0;
}

/**
 * Attach the real terminal straight into the Pod's tmux session via
 * `kubectl exec -it`. The local terminal talks to tmux directly (no WS proxy),
 * so scrollback + copy-to-local-clipboard (OSC52) work natively. Requires a
 * tmux-backed session (Pod started by the tmux-wrapping agent). Blocks until
 * detach/exit; returns the kubectl exit status.
 */
export function attachPodTmux(tunnel: TunnelConfig, sessionId: string): number {
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  // The attach CLIENT must be UTF-8 or tmux transcodes accented output to "_"
  // for it: the Pod's default locale is empty (ASCII), so we force it on the
  // exec'd tmux client — `env LANG=C.UTF-8` (so tmux detects UTF-8) + `tmux -u`
  // (force UTF-8 regardless of detection). (capture-pane never transcodes, which
  // is why a capture test looked fine while the interactive attach showed "_".)
  const args = [
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
  ];
  // Long-lived `kubectl exec` streams corrupt over time ("tls: bad record MAC"
  // / "next reader: local error" from the SPDY/WS executor): the terminal fills
  // with garbage and the client dies, dumping the user back to their local
  // shell. The Pod's tmux session SURVIVES that, so we auto-reconnect into it
  // instead of leaving the user stranded — a clean detach (Ctrl-b d) exits the
  // tmux client with status 0 and we stop; any non-zero exit is a dropped
  // stream and we re-exec. If it dies almost instantly several times in a row
  // the Pod is likely gone, so we give up rather than spin forever.
  let quickFailures = 0;
  for (;;) {
    const startedAt = Date.now();
    const r = spawnSync("kubectl", args, { stdio: "inherit", env });
    const status = r.status ?? 0;
    if (status === 0) {
      // Clean detach (Ctrl-b d) or exit: the Pod session keeps running — tell
      // the user how to get back in.
      process.stderr.write(
        `[remote] detached from ${sessionId} — re-attach: remote attach ${sessionId} --exec\n`,
      );
      return 0;
    }
    const ranMs = Date.now() - startedAt;
    if (ranMs < 3000) {
      quickFailures += 1;
      if (quickFailures >= 5) {
        process.stderr.write(
          `[remote] exec attach keeps failing immediately (status ${status}) — the Pod may be gone. ` +
            `Re-run \`remote attach ${sessionId} --exec\` once it's back.\n`,
        );
        return status;
      }
    } else {
      quickFailures = 0; // a real session that ran a while then dropped
    }
    process.stderr.write(
      `[remote] exec stream dropped (status ${status} — e.g. "tls: bad record MAC" on a long kubectl exec). ` +
        `Your Pod session is intact; reconnecting to its tmux… (Ctrl-C to stop)\n`,
    );
    spawnSync("sleep", ["1"], { stdio: "ignore" });
  }
}
