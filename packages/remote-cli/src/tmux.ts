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
 * Start a CLI in a detached local tmux session. Idempotent on name: if a
 * session with the same slug already exists it is reused (returns it).
 */
export function startLocalSession(
  profile: string,
  command: string,
  cwd: string,
  args: ReadonlyArray<string> = [],
): StartLocalResult {
  const slug = slugify(cwd);
  const name = localSessionName(slug);
  if (findLocalSession(name)) return { name, slug };

  const r = spawnSync(
    TMUX,
    [
      "new-session",
      "-d",
      "-s",
      name,
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
 * Attach the real terminal to a local tmux session. Blocks until the user
 * detaches (Ctrl-b d) or the session ends. Returns the tmux exit status.
 */
export function attachLocalSession(name: string): number {
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
      "tmux",
      "new-session",
      "-A",
      "-s",
      POD_TMUX_SESSION,
    ],
    { stdio: "inherit", env },
  );
  return r.status ?? 0;
}
