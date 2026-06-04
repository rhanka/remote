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
   * snapshot conversation state into the retained workspace volume. */
  readonly onBeforeExit?: () => void;
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
  claude: { command: "claude", args: [] },
  agy: { command: "agy", args: [] },
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
printf '[remote] Re-run it (e.g. %s --resume) or type exit / Ctrl-D to stop this remote session.\\n' "$cli"
exec /bin/bash -l`;

function defaultRandomId(prefix: string): string {
  const random = Math.floor(Math.random() * 1e12)
    .toString(36)
    .padStart(8, "0");
  return `${prefix}-${random}`;
}

function parseStartupArgs(raw: string | undefined): string[] {
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

export class SessionAgent {
  private readonly sessionId: string;
  private readonly profile: string;
  private readonly workspacePath: string;
  private readonly transport: AgentTransport;
  private readonly spawner: Spawner;
  private readonly clock: () => Date;
  private readonly randomId: (prefix: string) => string;
  private readonly env: Readonly<Record<string, string>>;
  private readonly onBeforeExit: (() => void) | undefined;
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

    this.transport.onMessage((envelope) => this.handleIncoming(envelope));

    // For an interactive CLI profile, wrap it in a persistent login shell so
    // exiting the CLI drops to a live shell on the box rather than destroying
    // the session. The `shell` profile (ephemeral workspace push/pull sessions
    // with one-shot startupArgs like `-c "exit 0"`) is spawned directly.
    let spawnCommand = profile.command;
    let spawnArgs: ReadonlyArray<string> = cliArgs;
    if (this.profile !== "shell") {
      spawnCommand = "/bin/bash";
      spawnArgs = [
        "-lc",
        PERSISTENT_SHELL_WRAPPER,
        "remote-session",
        profile.command,
        ...cliArgs,
      ];
    }

    const handle = this.spawner({
      command: spawnCommand,
      args: spawnArgs,
      cwd: this.workspacePath,
      env: { ...this.env, REMOTE_SESSION_ID: this.sessionId },
      onStdout: (chunk) => this.publishOutput("stdout", chunk),
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
          this.onBeforeExit();
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
