import type { SessionDescriptor } from "@sentropic/remote-protocol";

import type {
  DrainSessionOptions,
  DrainSessionResult,
  ProvisionerEmit,
  ProvisionOptions,
  SessionProvisioner,
  WorkspaceGcCandidate,
  WorkspaceGcOptions,
  WorkspaceGcReport,
} from "../index.js";
import type { K8sClient } from "./client.js";
import {
  DEFAULT_BUILDER_OPTIONS,
  buildSessionAuthSecret,
  buildSessionPodSpec,
  buildSessionPvcSpec,
  buildSharedWorkspacePvcSpec,
  buildWorkspaceGcJanitorPodSpec,
  buildWorkspacePvcSpec,
  resourceNames,
  workspacePvcName,
  type SpecBuilderOptions,
} from "./spec.js";

/**
 * Parse the janitor's stdout (see buildWorkspaceGcScript for the line
 * protocol) into a WorkspaceGcReport. PARANOID by design: the GC_DONE sentinel
 * is mandatory — a truncated/interrupted janitor run throws instead of
 * returning a partial (and possibly misleading) report.
 */
export function parseWorkspaceGcLogs(
  logs: string,
  applied: boolean,
): WorkspaceGcReport {
  const lines = logs.split("\n").map((line) => line.trim());
  if (!lines.includes("GC_DONE")) {
    throw new Error(
      "workspace GC: janitor output is missing the GC_DONE sentinel — treating the run as failed (no report)",
    );
  }
  const candidates: Array<{
    id: string;
    sizeH: string;
    lastModified: string;
    archivedTo?: string;
  }> = [];
  const failed: Array<{ id: string; reason: string }> = [];
  for (const line of lines) {
    const [tag, ...rest] = line.split(/\s+/);
    if (tag === "CANDIDATE" && rest.length >= 3) {
      const [id, sizeH, epoch] = rest as [string, string, string];
      const seconds = Number(epoch);
      const lastModified =
        Number.isFinite(seconds) && seconds > 0
          ? new Date(seconds * 1000).toISOString()
          : "unknown";
      candidates.push({ id, sizeH, lastModified });
    } else if (tag === "ARCHIVED" && rest.length >= 2) {
      const [id, trashPath] = rest as [string, string];
      const candidate = candidates.find((c) => c.id === id);
      if (candidate) candidate.archivedTo = trashPath;
    } else if (tag === "FAILED" && rest.length >= 1) {
      const [id, ...reason] = rest as [string, ...string[]];
      failed.push({ id, reason: reason.join(" ") || "unknown" });
    }
  }
  return {
    candidates: candidates.map((c): WorkspaceGcCandidate => {
      const { archivedTo, ...base } = c;
      return archivedTo !== undefined ? { ...base, archivedTo } : base;
    }),
    applied,
    failed,
  };
}

const GC_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const GC_DEFAULT_POLL_MS = 2000;

export type K8sProvisionerOptions = Partial<SpecBuilderOptions>;

export class K8sSessionProvisioner implements SessionProvisioner {
  private readonly options: SpecBuilderOptions;
  private readonly phases = new Map<string, string>();
  private readonly credentials = new Map<string, Readonly<Record<string, string>>>();

  constructor(
    private readonly client: K8sClient,
    options: K8sProvisionerOptions = {},
  ) {
    this.options = { ...DEFAULT_BUILDER_OPTIONS, ...options };
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

    const ns = options.namespace ?? this.options.namespace;
    const opts: SpecBuilderOptions = {
      ...this.options,
      namespace: ns,
      ...(options.gatewayToken ? { llmGatewayToken: options.gatewayToken } : {}),
      ...(options.agentImage ? { image: options.agentImage } : {}),
    };

    const credentials = options.credentials ?? {};
    const authPaths = Object.keys(credentials);
    this.credentials.set(descriptor.id, { ...credentials });

    if (authPaths.length > 0) {
      await this.client.create(
        buildSessionAuthSecret(descriptor, credentials, opts),
      );
    }

    // A session bound to a persistent Workspace mounts that retained PVC;
    // only unbound sessions get an ephemeral per-session PVC.
    if (!descriptor.workspaceId) {
      await this.client.create(buildSessionPvcSpec(descriptor, opts));
    }
    // WP7: opt-in headful-browser sidecar (noVNC) when the descriptor asks for
    // it (`metadata.browser === true`). Default off — ~no session needs it and
    // the X/Chromium stack is heavy.
    const browser = descriptor.metadata?.["browser"] === true;
    await this.client.create(
      buildSessionPodSpec(
        descriptor,
        opts,
        authPaths,
        options.workspaceSync ?? false,
        options.workspaceExport ?? false,
        options.sessionToken,
        browser,
      ),
    );

    this.phases.set(descriptor.id, "starting");
    emit(descriptor.id, "session.lifecycle.changed", {
      previousState: "provisioning",
      nextState: "starting",
    });
  }

  async refresh(
    descriptor: SessionDescriptor,
    emit: ProvisionerEmit,
    options: ProvisionOptions = {},
  ): Promise<void> {
    const incoming = options.credentials ?? {};
    if (Object.keys(incoming).length === 0) return;

    const nextCredentials = {
      ...(this.credentials.get(descriptor.id) ?? {}),
      ...incoming,
    };
    this.credentials.set(descriptor.id, nextCredentials);
    const authPaths = Object.keys(nextCredentials);

    const names = resourceNames(descriptor);
    const ns = options.namespace ?? this.options.namespace;
    const opts = { ...this.options, namespace: ns };
    emit(descriptor.id, "session.lifecycle.changed", {
      previousState: this.phases.get(descriptor.id) ?? "running",
      nextState: "starting",
    });

    await this.client
      .delete({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: names.pod, namespace: ns },
      })
      .catch(() => {});

    if (authPaths.length > 0) {
      await this.client
        .delete({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: names.authSecret, namespace: ns },
        })
        .catch(() => {});
      await this.client.create(
        buildSessionAuthSecret(descriptor, nextCredentials, opts),
      );
    }

    await this.createAwaitingDeletion(
      buildSessionPodSpec(descriptor, opts, authPaths),
    );

    this.phases.set(descriptor.id, "ready");
    emit(descriptor.id, "session.lifecycle.changed", {
      previousState: "starting",
      nextState: "ready",
    });
  }

  /**
   * Create a resource, tolerating a slow predecessor still terminating. On
   * refresh we delete()+create() a same-named Pod; a large Pod can still be in
   * graceful shutdown when create() fires, yielding a 409 ("object is being
   * deleted: pods … already exists"). Retry the create until the name frees up.
   */
  private async createAwaitingDeletion(
    spec: ReturnType<typeof buildSessionPodSpec>,
    attempts = 60,
    delayMs = 1000,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.create(spec);
        return;
      } catch (error) {
        const message = String(error);
        const terminating = /being deleted|already exists/i.test(message);
        if (!terminating || attempt >= attempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async destroy(
    sessionId: string,
    emit: ProvisionerEmit,
    namespace?: string,
  ): Promise<void> {
    const previous = this.phases.get(sessionId) ?? "running";
    this.phases.set(sessionId, "stopping");
    emit(sessionId, "session.lifecycle.changed", {
      previousState: previous,
      nextState: "stopping",
    });

    const names = resourceNames({ id: sessionId } as SessionDescriptor);
    const ns = namespace ?? this.options.namespace;
    await this.client
      .delete({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: names.pod, namespace: ns },
      })
      .catch(() => {});
    await this.client
      .delete({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: names.pvc, namespace: ns },
      })
      .catch(() => {});
    await this.client
      .delete({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: names.authSecret, namespace: ns },
      })
      .catch(() => {});

    this.credentials.delete(sessionId);
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

  async provisionWorkspace(workspaceId: string, namespace?: string): Promise<void> {
    const ns = namespace ?? this.options.namespace;
    const opts = { ...this.options, namespace: ns };
    // Shared mode: ensure the ONE per-user RWX PVC exists (workspaces are
    // subdirectories inside it); legacy mode: one PVC per workspace.
    const spec = this.options.sharedWorkspacePvc
      ? buildSharedWorkspacePvcSpec(opts)
      : buildWorkspacePvcSpec(workspaceId, opts);
    await this.client.create(spec).catch((error: unknown) => {
      // tolerate "already exists" so workspace create is idempotent
      const message = String(error);
      if (!/already exists|AlreadyExists/i.test(message)) throw error;
    });
  }

  async destroyWorkspace(workspaceId: string, namespace?: string): Promise<void> {
    // Never delete the SHARED volume on workspace rm — it holds every other
    // workspace too. Subdirectory GC is an explicit operation, not a cascade.
    if (this.options.sharedWorkspacePvc) return;
    const ns = namespace ?? this.options.namespace;
    await this.client
      .delete({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: workspacePvcName(workspaceId),
          namespace: ns,
        },
      })
      .catch(() => {});
  }

  /**
   * Proactively drain a session pod off its current node (node-pressure
   * evacuation). Reads the pod's nodeName, optionally checks the node's
   * MemoryPressure/DiskPressure conditions, then deletes the pod and recreates
   * it with a nodeAffinity that excludes the current node so k8s schedules it
   * elsewhere.
   *
   * `force: true` skips the node-pressure check.
   */
  async drainSession(
    descriptor: SessionDescriptor,
    emit: ProvisionerEmit,
    options: DrainSessionOptions = {},
  ): Promise<DrainSessionResult> {
    const names = resourceNames(descriptor);
    const ns = options.namespace ?? this.options.namespace;

    // 1. Read the current pod to find which node it is on.
    type PodStatus = { spec?: { nodeName?: string } };
    const podRaw = await this.client.read({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: names.pod, namespace: ns },
    });
    const pod = podRaw as (PodStatus & typeof podRaw) | undefined;

    if (!pod) {
      return { migrated: false, reason: "pod_not_found" };
    }

    const nodeName = (pod as PodStatus).spec?.nodeName;
    if (!nodeName) {
      return { migrated: false, reason: "pod_not_scheduled" };
    }

    // 2. Unless forced, check the node for pressure conditions.
    if (!options.force) {
      type NodeStatus = {
        status?: {
          conditions?: ReadonlyArray<{ type: string; status: string }>;
        };
      };
      const nodeRaw = await this.client.read({
        apiVersion: "v1",
        kind: "Node",
        // Nodes are cluster-scoped; pass an empty-string namespace.
        metadata: { name: nodeName, namespace: "" },
      });
      const nodeConditions =
        (nodeRaw as NodeStatus | undefined)?.status?.conditions ?? [];
      const underPressure = nodeConditions.some(
        (c) =>
          (c.type === "MemoryPressure" || c.type === "DiskPressure") &&
          c.status === "True",
      );
      if (!underPressure) {
        return { migrated: false, reason: "node_not_under_pressure" };
      }
    }

    // 3. Delete the existing pod.
    await this.client
      .delete({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: names.pod, namespace: ns },
      })
      .catch(() => {});

    // 4. Rebuild the pod spec with a nodeAffinity that excludes the current node.
    const opts = { ...this.options, namespace: ns };
    const credentials = this.credentials.get(descriptor.id) ?? {};
    const authPaths = Object.keys(credentials);
    const baseSpec = buildSessionPodSpec(descriptor, opts, authPaths);

    // Merge our node-exclusion affinity with the base spec's existing affinity.
    const exclusionAffinity = {
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                {
                  key: "kubernetes.io/hostname",
                  operator: "NotIn" as const,
                  values: [nodeName],
                },
              ],
            },
          ],
        },
      },
    };
    const drainSpec = {
      ...baseSpec,
      spec: {
        ...baseSpec.spec,
        affinity: {
          ...(baseSpec.spec.affinity ?? {}),
          ...exclusionAffinity,
        },
      },
    };

    emit(descriptor.id, "session.lifecycle.changed", {
      previousState: this.phases.get(descriptor.id) ?? "running",
      nextState: "starting",
    });

    await this.createAwaitingDeletion(drainSpec);

    this.phases.set(descriptor.id, "starting");
    emit(descriptor.id, "session.lifecycle.changed", {
      previousState: "starting",
      nextState: "ready",
    });

    return { migrated: true, fromNode: nodeName };
  }

  /**
   * EXPLICIT GC of stale `ws-*` subdirectories on the shared workspaces PVC.
   * Runs an ephemeral janitor pod that mounts the PVC ROOT (sessions only see
   * their own subPath slice), reports candidates from its logs, and — with
   * apply — archives each one to on-volume `.trash/<dir>.<epoch>.tar.gz`
   * BEFORE `rm -rf` (never a dry loss; recoverable from the same volume). The
   * keep-list and the age cutoff are re-evaluated inside the pod at run time.
   * The janitor pod is always deleted afterwards, success or failure.
   */
  async gcWorkspaces(opts: WorkspaceGcOptions): Promise<WorkspaceGcReport> {
    if (!this.options.sharedWorkspacePvc) {
      throw new Error(
        "workspace GC requires sharedWorkspacePvc mode (per-workspace PVCs are deleted individually via destroyWorkspace)",
      );
    }
    if (typeof this.client.podLogs !== "function") {
      throw new Error(
        "workspace GC requires a K8sClient with podLogs (the janitor reports through its pod logs)",
      );
    }
    const ns = opts.namespace ?? this.options.namespace;
    const specOpts = { ...this.options, namespace: ns };
    const name = `workspace-gc-${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const pod = buildWorkspaceGcJanitorPodSpec(
      {
        name,
        olderThanDays: opts.olderThanDays,
        apply: opts.apply,
        keep: opts.keep,
        hasLiveSessions: opts.hasLiveSessions ?? false,
      },
      specOpts,
    );
    await this.client.create(pod);
    try {
      const logs = await this.awaitJanitorLogs(
        name,
        ns,
        opts.timeoutMs ?? GC_DEFAULT_TIMEOUT_MS,
        opts.pollIntervalMs ?? GC_DEFAULT_POLL_MS,
      );
      return parseWorkspaceGcLogs(logs, opts.apply);
    } finally {
      // ALWAYS reap the janitor — success, failure or timeout.
      await this.client
        .delete({
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name, namespace: ns },
        })
        .catch(() => {});
    }
  }

  /** Poll the janitor pod until it terminates, then return its logs. A Failed
   * phase (or a timeout) throws — with the pod logs attached when available. */
  private async awaitJanitorLogs(
    name: string,
    namespace: string,
    timeoutMs: number,
    pollMs: number,
  ): Promise<string> {
    const ref = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, namespace },
    } as const;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pod = await this.client.read(ref);
      const phase = (pod as { status?: { phase?: string } } | undefined)?.status
        ?.phase;
      if (phase === "Succeeded") {
        return await this.client.podLogs!(ref);
      }
      if (phase === "Failed") {
        const logs = await this.client.podLogs!(ref).catch(() => "");
        throw new Error(
          `workspace GC: janitor pod ${name} failed${logs ? `; logs:\n${logs}` : ""}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `workspace GC: janitor pod ${name} did not complete within ${timeoutMs}ms (phase=${phase ?? "unknown"}); nothing is reported — note an apply run may have already archived some directories to on-volume .trash/ (nothing is ever removed without its archive)`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
