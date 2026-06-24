import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEMA_VERSION,
  type Actor,
  type RemoteEventEnvelope,
} from "@sentropic/remote-protocol";

export type IncomingEnvelope = Pick<
  RemoteEventEnvelope,
  "type" | "sessionId" | "payload"
> & {
  readonly correlationId?: string;
  readonly actor?: Actor;
};

export interface AgentTransport {
  send(envelope: RemoteEventEnvelope): void;
  onMessage(handler: (envelope: IncomingEnvelope) => void): void;
  close(): Promise<void>;
  readonly closed: Promise<void>;
}

export type SpawnerOptions = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly onStdout: (chunk: string) => void;
  readonly onStderr: (chunk: string) => void;
};

export interface ProcessHandle {
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(signal?: string): void;
  readonly exited: Promise<{ exitCode: number | null; signal?: string }>;
}

export type Spawner = (options: SpawnerOptions) => ProcessHandle;

export type SessionAgentOptions = {
  readonly sessionId: string;
  readonly profile: string;
  readonly workspacePath: string;
  readonly transport: AgentTransport;
  readonly spawner: Spawner;
  readonly clock?: () => Date;
  readonly randomId?: (prefix: string) => string;
  readonly env?: Readonly<Record<string, string>>;
  /** Invoked when the wrapped process exits, before `terminal.exited` is
   * published (which triggers the control-plane cleanup cascade). Used to
   * snapshot conversation state into the retained workspace volume.
   * Receives the wrapped process exit code (0 = success, non-zero = error). */
  readonly onBeforeExit?: (exitCode: number) => void;
};

const AGENT_ACTOR: Actor = {
  id: "session-agent",
  kind: "session-agent",
  displayName: "Session Agent",
};

const PROFILE_COMMANDS: Readonly<
  Record<string, { command: string; args: ReadonlyArray<string> }>
> = {
  shell: { command: "/bin/bash", args: [] },
  codex: { command: "codex", args: [] },
  opencode: { command: "opencode", args: [] },
  claude: { command: "claude", args: ["--dangerously-skip-permissions"] },
  agy: { command: "agy", args: [] },
  gemini: { command: "gemini", args: [] },
  mistral: { command: "mistral", args: [] },
};

/**
 * Persistent-box wrapper. Runs the wrapped CLI as `$1 "$@"`, and when it exits
 * (Ctrl-C / Ctrl-D / normal quit) drops the user into a live login shell on the
 * workspace instead of ending the session. The agent's PTY is this shell, so the
 * session-agent keeps running and its WS stays registered (no deaf zombie, no
 * destroy-on-exit). The session ends only when the user exits this shell (PTY
 * exit) or via an explicit stop. `$0` is a label; `$1` is the CLI; rest are args.
 */
const PERSISTENT_SHELL_WRAPPER = `cli="$1"; shift
"$cli" "$@"; code=$?
printf '\\n[remote] %s exited (code %s) — you are now in a shell on this workspace (%s).\\n' "$cli" "$code" "$PWD"
printf '[remote] Re-run %s to resume your conversation, or type exit / Ctrl-D to stop this remote session.\\n' "$cli"
exec /bin/bash -l`;

/**
 * tmux-backed persistent box (enabled by SESSION_TMUX=1). Runs the wrapped CLI
 * inside a durable tmux session ("main") and the agent's PTY just proxies a
 * tmux CLIENT over the WS. Two wins over the bare wrapper:
 *  - Detaching (Ctrl-b d, or an `--exec` client leaving) does NOT end the
 *    session — the proxy re-attaches in a loop; the session ends only when the
 *    tmux session itself ends (CLI exited AND its drop-to-shell exited).
 *  - `remote attach <id> --exec` can open a second client straight into the Pod
 *    (kubectl exec) for native scrollback + copy-to-clipboard, side by side.
 * `$0` is a label, `$1` is the CLI, the rest are its args (same shape as the
 * bare wrapper). The inner drop-to-shell block is single-quoted (no `'` inside)
 * so it survives intact through to the tmux-spawned shell.
 */
const TMUX_BOX_WRAPPER = `ses=main
cli="$1"; shift
if ! tmux has-session -t "$ses" 2>/dev/null; then
  tmux new-session -d -s "$ses" /bin/bash -lc 'cli="$1"; shift
"$cli" "$@"; code=$?
printf "\\n[remote] %s exited (code %s) — you are now in a shell on this workspace (%s).\\n" "$cli" "$code" "$PWD"
printf "[remote] Re-run it (e.g. %s --resume) or type exit / Ctrl-D to stop this remote session.\\n" "$cli"
exec /bin/bash -l' remote-session "$cli" "$@"
fi
while tmux has-session -t "$ses" 2>/dev/null; do
  tmux attach -t "$ses" || sleep 1
done`;

function defaultRandomId(prefix: string): string {
  const random = Math.floor(Math.random() * 1e12)
    .toString(36)
    .padStart(8, "0");
  return `${prefix}-${random}`;
}

/**
 * Parse SESSION_STARTUP_ARGS (a JSON string array) into the extra args appended
 * to the wrapped CLI's command line. Malformed payloads degrade to []. Shared by
 * the spawn path (agent.ts) and the announce path (index.ts), which re-reports
 * the same args to the control-plane for restart durability.
 */
export function parseStartupArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((value): value is string => typeof value === "string")
    ) {
      return parsed;
    }
  } catch {
    // ignore malformed payload
  }
  return [];
}

/**
 * Mark `workspacePath` as trusted in `~/.claude.json` so `claude -p <task>`
 * doesn't block on "Do you trust the files in this folder?". Idempotent and
 * best-effort: silently skipped on any read/write error.
 */
export function preTrustClaudeWorkspace(
  home: string,
  workspacePath: string,
): void {
  try {
    const configPath = join(home, ".claude.json");
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // missing or malformed — start fresh
    }
    const projects = (config.projects ?? {}) as Record<string, unknown>;
    const project = (projects[workspacePath] ?? {}) as Record<string, unknown>;
    if (project["hasTrustDialogAccepted"] === true) {
      console.log(
        `[session-agent] pre-trust: ${workspacePath} already trusted in ${configPath}`,
      );
      return;
    }
    project["hasTrustDialogAccepted"] = true;
    projects[workspacePath] = project;
    config.projects = projects;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    console.log(
      `[session-agent] pre-trust: wrote hasTrustDialogAccepted=true for ${workspacePath} in ${configPath}`,
    );
  } catch (err) {
    console.error(
      `[session-agent] pre-trust: FAILED to write ${join(home, ".claude.json")}: ${String(err)}`,
    );
  }
}

export class SessionAgent {
  private readonly sessionId: string;
  private readonly profile: string;
  private readonly workspacePath: string;
  private readonly transport: AgentTransport;
  private readonly spawner: Spawner;
  private readonly clock: () => Date;
  private readonly randomId: (prefix: string) => string;
  private readonly env: Readonly<Record<string, string>>;
  private readonly onBeforeExit: ((exitCode: number) => void) | undefined;
  private sequence = 0;
  private process: ProcessHandle | null = null;
  private terminalId = "";
  private stopped = false;

  /**
   * Resolves when the wrapped process exits (after `terminal.exited` is
   * published and the transport is closed). Use this in `main()` to gate
   * process lifetime on the PTY, not the socket.
   */
  readonly done: Promise<void>;

  private doneResolve!: () => void;

  constructor(options: SessionAgentOptions) {
    this.sessionId = options.sessionId;
    this.profile = options.profile;
    this.workspacePath = options.workspacePath;
    this.transport = options.transport;
    this.spawner = options.spawner;
    this.clock = options.clock ?? (() => new Date());
    this.randomId = options.randomId ?? defaultRandomId;
    this.env = options.env ?? {};
    this.onBeforeExit = options.onBeforeExit;
    this.done = new Promise<void>((resolve) => {
      this.doneResolve = resolve;
    });
  }

  start(): void {
    const profile =
      PROFILE_COMMANDS[this.profile] ?? PROFILE_COMMANDS["shell"]!;
    const startupArgs = parseStartupArgs(this.env.SESSION_STARTUP_ARGS);
    const cliArgs = [...profile.args, ...startupArgs];
    this.terminalId = this.randomId("term");

    // Pre-trust the workspace for claude so `claude -p <task>` isn't blocked
    // by the "Do you trust the files in this folder?" dialog (which disrupts
    // headless mode by stalling stdin before the task can execute).
    if (this.profile === "claude") {
      preTrustClaudeWorkspace(
        this.env.HOME ?? "/root",
        this.workspacePath,
      );
    }

    this.transport.onMessage((envelope) => this.handleIncoming(envelope));

    // For an interactive CLI profile, wrap it in a persistent login shell so
    // exiting the CLI drops to a live shell on the box rather than destroying
    // the session. The `shell` profile (ephemeral workspace push/pull sessions
    // with one-shot startupArgs like `-c "exit 0"`) is spawned directly.
    //
    // Claude headless (-p <task>): skip the wrapper entirely and launch the
    // binary directly. With no wrapper there is no tmux (so no TTY), which
    // means claude detects a non-TTY stdout and skips the workspace trust dialog
    // automatically — the documented behaviour. The wrapper is only useful for
    // interactive sessions that need a persistent box after the CLI exits.
    const isClaudeHeadless =
      this.profile === "claude" && startupArgs.includes("-p");

    let spawnCommand = profile.command;
    let spawnArgs: ReadonlyArray<string> = cliArgs;
    if (this.profile !== "shell" && !isClaudeHeadless) {
      // SESSION_TMUX=1 → run the CLI inside a durable tmux session (detach-safe,
      // enables `--exec` attach); otherwise the bare persistent-box wrapper.
      const wrapper =
        this.env.SESSION_TMUX === "1"
          ? TMUX_BOX_WRAPPER
          : PERSISTENT_SHELL_WRAPPER;
      spawnCommand = "/bin/bash";
      spawnArgs = [
        "-lc",
        wrapper,
        "remote-session",
        profile.command,
        ...cliArgs,
      ];
    }

    // Fallback trust-dialog handler: if preTrustClaudeWorkspace didn't prevent
    // the "Do you trust the files in this folder?" dialog (e.g. because the
    // running claude version uses a different config key, or the write raced with
    // a concurrent pod), detect it in stdout and answer "1" automatically.
    // Accumulate across chunks; cap the buffer to avoid unbounded growth.
    let trustDialogHandled = false;
    let trustBuffer = "";

    const handle = this.spawner({
      command: spawnCommand,
      args: spawnArgs,
      cwd: this.workspacePath,
      env: { ...this.env, REMOTE_SESSION_ID: this.sessionId },
      onStdout: (chunk) => {
        if (!trustDialogHandled && this.profile === "claude") {
          trustBuffer += chunk;
          if (trustBuffer.includes("Do you trust the files in this folder?")) {
            trustDialogHandled = true;
            trustBuffer = "";
            console.log(
              `[session-agent] auto-trust: dialog detected — answering "1" for ${this.workspacePath}`,
            );
            this.process?.write("1\n");
          } else if (trustBuffer.length > 512) {
            trustBuffer = trustBuffer.slice(-256);
          }
        }
        this.publishOutput("stdout", chunk);
      },
      onStderr: (chunk) => this.publishOutput("stderr", chunk),
    });
    this.process = handle;

    this.publish("terminal.opened", {
      terminalId: this.terminalId,
      shell: spawnCommand,
    });

    void handle.exited.then((result) => {
      if (this.stopped) return;
      this.stopped = true;
      if (this.onBeforeExit) {
        try {
          this.onBeforeExit(result.exitCode ?? -1);
        } catch {
          // best-effort snapshot; never block the exit path
        }
      }
      const payload: Record<string, unknown> = {
        terminalId: this.terminalId,
        exitCode: result.exitCode ?? -1,
      };
      if (result.signal) payload.signal = result.signal;
      this.publish("terminal.exited", payload);
      // Deliberately close the transport (graceful shutdown). This is the only
      // path that resolves transport.closed — a transient socket drop does not.
      void this.transport.close().then(() => {
        this.doneResolve();
      });
    });
  }

  private handleIncoming(envelope: IncomingEnvelope): void {
    if (envelope.sessionId !== this.sessionId) return;
    if (envelope.type === "terminal.input") {
      const payload = envelope.payload as { data?: string };
      if (typeof payload.data === "string" && this.process) {
        this.process.write(payload.data);
      }
      return;
    }
    if (envelope.type === "terminal.resized") {
      const payload = envelope.payload as { columns?: number; rows?: number };
      if (
        typeof payload.columns === "number" &&
        typeof payload.rows === "number" &&
        this.process?.resize
      ) {
        this.process.resize(payload.columns, payload.rows);
      }
    }
  }

  private publishOutput(stream: "stdout" | "stderr", data: string): void {
    this.publish("terminal.output", {
      terminalId: this.terminalId,
      stream,
      data,
      encoding: "utf8",
    });
  }

  private publish(
    type: RemoteEventEnvelope["type"],
    payload: Record<string, unknown>,
  ): void {
    const envelope: RemoteEventEnvelope = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      schemaVersion: REMOTE_SCHEMA_VERSION,
      eventId: this.randomId("evt"),
      sessionId: this.sessionId,
      sequence: this.sequence++,
      type,
      occurredAt: this.clock().toISOString(),
      correlationId: `agent-${this.sessionId}`,
      actor: AGENT_ACTOR,
      payload,
    };
    this.transport.send(envelope);
  }
}
