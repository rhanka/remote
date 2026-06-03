import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SessionDescriptor } from "@sentropic/remote-protocol";

import type {
  ProvisionerEmit,
  ProvisionOptions,
  SessionProvisioner,
} from "../index.js";

export type DockerRunResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type DockerRunner = (
  args: ReadonlyArray<string>,
) => Promise<DockerRunResult>;

export const execDocker: DockerRunner = (args) =>
  new Promise((resolve) => {
    execFile("docker", [...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        status: err && typeof (err as { code?: number }).code === "number"
          ? ((err as { code?: number }).code as number)
          : err
            ? 1
            : 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });

export type DockerProvisionerOptions = {
  readonly image?: string;
  /** Endpoint the in-container session-agent uses to reach the control-plane.
   * Defaults to host.docker.internal (added via --add-host host-gateway). */
  readonly controlPlaneEndpoint?: string;
  readonly home?: string;
  readonly network?: string;
  readonly runner?: DockerRunner;
};

const DEFAULTS = {
  image: "ghcr.io/rhanka/sentropic-remote-session-agent:v0.4.2",
  controlPlaneEndpoint: "http://host.docker.internal:8080",
  home: "/root",
};

function containerName(sessionId: string): string {
  return `session-${sessionId}`;
}
function workspaceVolume(workspaceId: string): string {
  return `workspace-${workspaceId}`;
}
function sessionVolume(sessionId: string): string {
  return `session-${sessionId}-workspace`;
}

/**
 * Runs each session as a plain `docker run` container of the session-agent
 * image — a Kubernetes-free path (fast local/CI sessions). Mirrors the K8s
 * provisioner: workspace volume (retained when bound to a Workspace), auth
 * staging bind-mount, conversation-state persistence via the volume.
 */
export class DockerSessionProvisioner implements SessionProvisioner {
  private readonly image: string;
  private readonly controlPlaneEndpoint: string;
  private readonly home: string;
  private readonly network: string | undefined;
  private readonly run: DockerRunner;
  private readonly phases = new Map<string, string>();
  private readonly authDirs = new Map<string, string>();

  constructor(options: DockerProvisionerOptions = {}) {
    this.image = options.image ?? DEFAULTS.image;
    this.controlPlaneEndpoint =
      options.controlPlaneEndpoint ?? DEFAULTS.controlPlaneEndpoint;
    this.home = options.home ?? DEFAULTS.home;
    this.network = options.network;
    this.run = options.runner ?? execDocker;
  }

  private stageAuth(
    sessionId: string,
    credentials: Readonly<Record<string, string>>,
  ): { dir: string; paths: string[] } | undefined {
    const paths = Object.keys(credentials);
    if (paths.length === 0) return undefined;
    const dir = mkdtempSync(join(tmpdir(), `remote-auth-${sessionId}-`));
    for (const [rel, b64] of Object.entries(credentials)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, Buffer.from(b64, "base64"));
    }
    this.authDirs.set(sessionId, dir);
    return { dir, paths };
  }

  async provision(
    descriptor: SessionDescriptor,
    emit: ProvisionerEmit,
    options: ProvisionOptions = {},
  ): Promise<void> {
    this.phases.set(descriptor.id, "provisioning");
    emit(descriptor.id, "session.lifecycle.changed", {
      previousState: "requested",
      nextState: "provisioning",
    });

    const volume = descriptor.workspaceId
      ? workspaceVolume(descriptor.workspaceId)
      : sessionVolume(descriptor.id);
    await this.run(["volume", "create", volume]);

    const startupArgs = (() => {
      const startup = descriptor.metadata?.startup as
        | { args?: unknown }
        | undefined;
      const args = startup?.args;
      return Array.isArray(args)
        ? args.filter((v): v is string => typeof v === "string")
        : [];
    })();

    const env: string[] = [
      "-e", `SESSION_ID=${descriptor.id}`,
      "-e", `SESSION_PROFILE=${descriptor.profile}`,
      "-e", `SESSION_TARGET=${descriptor.target}`,
      "-e", `CONTROL_PLANE_ENDPOINT=${this.controlPlaneEndpoint}`,
      "-e", `WORKSPACE_PATH=${descriptor.workspacePath}`,
      "-e", `HOME=${this.home}`,
    ];
    if (descriptor.workspaceId)
      env.push("-e", `SESSION_WORKSPACE_ID=${descriptor.workspaceId}`);
    if (options.workspaceSync) env.push("-e", "SESSION_WORKSPACE_SYNC=1");
    if (options.workspaceExport) env.push("-e", "SESSION_WORKSPACE_EXPORT=1");
    if (options.sessionToken)
      env.push("-e", `REMOTE_TOKEN=${options.sessionToken}`);
    if (startupArgs.length > 0)
      env.push("-e", `SESSION_STARTUP_ARGS=${JSON.stringify(startupArgs)}`);

    const auth = this.stageAuth(descriptor.id, options.credentials ?? {});
    const authMount = auth
      ? [
          "-e", "SESSION_AUTH_STAGING_DIR=/run/auth-bundle",
          "-e", `SESSION_AUTH_BUNDLE_PATHS=${auth.paths.join(":")}`,
          "-v", `${auth.dir}:/run/auth-bundle:ro`,
        ]
      : [];

    const args = [
      "run", "-d",
      "--name", containerName(descriptor.id),
      "--add-host=host.docker.internal:host-gateway",
      ...(this.network ? ["--network", this.network] : []),
      ...env,
      ...authMount,
      "-v", `${volume}:${descriptor.workspacePath}`,
      this.image,
    ];
    const res = await this.run(args);
    if (res.status !== 0) {
      throw new Error(`docker run failed: ${res.stderr || res.status}`);
    }

    this.phases.set(descriptor.id, "starting");
    emit(descriptor.id, "session.lifecycle.changed", {
      previousState: "provisioning",
      nextState: "starting",
    });
    this.phases.set(descriptor.id, "ready");
    emit(descriptor.id, "session.lifecycle.changed", {
      previousState: "starting",
      nextState: "ready",
    });
  }

  async refresh(): Promise<void> {
    // Docker sessions re-read mounted auth on (re)start; live refresh of a
    // running container is out of scope for the docker backend (V1).
  }

  async destroy(
    sessionId: string,
    emit: ProvisionerEmit,
    _namespace?: string,
  ): Promise<void> {
    this.phases.set(sessionId, "stopping");
    emit(sessionId, "session.lifecycle.changed", {
      previousState: this.phases.get(sessionId) ?? "running",
      nextState: "stopping",
    });
    await this.run(["rm", "-f", containerName(sessionId)]);
    // only the ephemeral per-session volume is removed; workspace-<id> is kept
    await this.run(["volume", "rm", "-f", sessionVolume(sessionId)]);
    const authDir = this.authDirs.get(sessionId);
    if (authDir) {
      rmSync(authDir, { recursive: true, force: true });
      this.authDirs.delete(sessionId);
    }
    this.phases.set(sessionId, "stopped");
    emit(sessionId, "session.lifecycle.changed", {
      previousState: "stopping",
      nextState: "stopped",
    });
    this.phases.delete(sessionId);
  }

  async inspect(sessionId: string): Promise<{ phase: string } | undefined> {
    const phase = this.phases.get(sessionId);
    return phase ? { phase } : undefined;
  }

  async provisionWorkspace(workspaceId: string, _namespace?: string): Promise<void> {
    await this.run(["volume", "create", workspaceVolume(workspaceId)]);
  }

  async destroyWorkspace(workspaceId: string, _namespace?: string): Promise<void> {
    await this.run(["volume", "rm", "-f", workspaceVolume(workspaceId)]);
  }
}
