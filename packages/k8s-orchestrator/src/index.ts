import {
  EVENT_TYPES,
  type SessionDescriptor,
} from "@sentropic/remote-protocol";

export const packageName = "@sentropic/remote-k8s-orchestrator";

type EventType = (typeof EVENT_TYPES)[number];

export type ProvisionerEmit = (
  sessionId: string,
  type: EventType,
  payload: Record<string, unknown>,
) => void;

export type ProvisionOptions = {
  readonly credentials?: Readonly<Record<string, string>>;
  readonly workspaceSync?: boolean;
  readonly workspaceExport?: boolean;
  readonly namespace?: string;
  /** Per-session service token (only minted under bearer auth) injected as the
   * REMOTE_TOKEN env so the session-agent can authenticate its callbacks. */
  readonly sessionToken?: string;
};

export type WorkspaceGcOptions = {
  /** Only directories with NO entry modified in the last N days are candidates. */
  readonly olderThanDays: number;
  /** false = dry-run (report only); true = archive to on-volume .trash/ then delete. */
  readonly apply: boolean;
  /** Workspace ids that must NEVER be collected, re-checked inside the janitor. */
  readonly keep: ReadonlyArray<string>;
  readonly namespace?: string;
  /** True when session pods are running in this namespace: the janitor then
   * REQUIRES co-location with them (their node already mounts the shared
   * volume — the only guaranteed-mountable placement under the one-File
   * Storage-volume-per-node CSI constraint). False relaxes to preferred. */
  readonly hasLiveSessions?: boolean;
  /** Janitor end-to-end budget (default 20 min — tar of big workspaces is slow). */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
};

export type WorkspaceGcCandidate = {
  readonly id: string;
  /** Human-readable size (du -sh). */
  readonly sizeH: string;
  /** ISO timestamp of the most recent mtime anywhere inside the directory. */
  readonly lastModified: string;
  /** apply only: on-volume trash archive the directory was saved to before rm. */
  readonly archivedTo?: string;
};

export type WorkspaceGcReport = {
  readonly candidates: ReadonlyArray<WorkspaceGcCandidate>;
  readonly applied: boolean;
  /** apply only: directories whose trash archive FAILED — left untouched. */
  readonly failed: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
};

export interface SessionProvisioner {
  provision(
    descriptor: SessionDescriptor,
    emit: ProvisionerEmit,
    options?: ProvisionOptions,
  ): Promise<void>;
  refresh(
    descriptor: SessionDescriptor,
    emit: ProvisionerEmit,
    options?: ProvisionOptions,
  ): Promise<void>;
  destroy(
    sessionId: string,
    emit: ProvisionerEmit,
    namespace?: string,
  ): Promise<void>;
  inspect(sessionId: string): Promise<{ phase: string } | undefined>;
  /** Create the retained PVC backing a persistent Workspace (idempotent). */
  provisionWorkspace?(workspaceId: string, namespace?: string): Promise<void>;
  /** Delete a Workspace's retained PVC. */
  destroyWorkspace?(workspaceId: string, namespace?: string): Promise<void>;
  /** Explicit GC of stale workspace subdirectories on the shared RWX volume
   * via an ephemeral janitor pod (never a cascade — see K8sSessionProvisioner). */
  gcWorkspaces?(opts: WorkspaceGcOptions): Promise<WorkspaceGcReport>;
}

const LIFECYCLE_TRANSITIONS: ReadonlyArray<{ from: string; to: string }> = [
  { from: "requested", to: "provisioning" },
  { from: "provisioning", to: "starting" },
  { from: "starting", to: "ready" },
];

export class InMemoryProvisioner implements SessionProvisioner {
  private readonly phases = new Map<string, string>();

  async provision(
    descriptor: SessionDescriptor,
    emit: ProvisionerEmit,
  ): Promise<void> {
    for (const transition of LIFECYCLE_TRANSITIONS) {
      this.phases.set(descriptor.id, transition.to);
      emit(descriptor.id, "session.lifecycle.changed", {
        previousState: transition.from,
        nextState: transition.to,
      });
    }
  }

  async refresh(
    _descriptor: SessionDescriptor,
    _emit: ProvisionerEmit,
    _options: ProvisionOptions = {},
  ): Promise<void> {
    return;
  }

  async destroy(
    sessionId: string,
    emit: ProvisionerEmit,
    _namespace?: string,
  ): Promise<void> {
    const previous = this.phases.get(sessionId) ?? "running";
    this.phases.set(sessionId, "stopping");
    emit(sessionId, "session.lifecycle.changed", {
      previousState: previous,
      nextState: "stopping",
    });
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
}

export { K8sSessionProvisioner, parseWorkspaceGcLogs } from "./k8s/provisioner.js";
export type { K8sProvisionerOptions } from "./k8s/provisioner.js";
export { KubernetesObjectApiClient } from "./k8s/object-api-client.js";
export type { K8sClient, K8sResourceRef } from "./k8s/client.js";
export {
  BROWSER_SIDECAR_CONTAINER,
  BROWSER_SIDECAR_ENTRYPOINT,
  BROWSER_SIDECAR_IMAGE,
  BROWSER_SIDECAR_PORT,
  DEFAULT_BUILDER_OPTIONS,
  JANITOR_IMAGE,
  JANITOR_TRASH_DIR,
  JANITOR_WORKSPACES_MOUNT,
  buildBrowserSidecarContainer,
  buildSessionPodSpec,
  buildSessionPvcSpec,
  buildSessionAuthSecret,
  buildWorkspaceGcJanitorPodSpec,
  buildWorkspaceGcScript,
  credentialSecretKey,
  resourceNames,
  sessionLabels,
  type K8sContainer,
  type K8sPodAffinityTerm,
  type K8sPodSpec,
  type K8sPvcAccessMode,
  type K8sPvcSpec,
  type K8sSecretSpec,
  type K8sVolume,
  type K8sVolumeMount,
  type ResourceQuantities,
  type SpecBuilderOptions,
  type WorkspaceGcJanitorOptions,
} from "./k8s/spec.js";

export {
  DockerSessionProvisioner,
  execDocker,
  type DockerRunner,
  type DockerRunResult,
  type DockerProvisionerOptions,
} from "./docker/provisioner.js";
