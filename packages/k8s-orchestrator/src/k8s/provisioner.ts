import type { SessionDescriptor } from "@sentropic/remote-protocol";

import type {
  ProvisionerEmit,
  ProvisionOptions,
  SessionProvisioner,
} from "../index.js";
import type { K8sClient } from "./client.js";
import {
  DEFAULT_BUILDER_OPTIONS,
  buildSessionAuthSecret,
  buildSessionPodSpec,
  buildSessionPvcSpec,
  buildWorkspacePvcSpec,
  resourceNames,
  workspacePvcName,
  type SpecBuilderOptions,
} from "./spec.js";

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
    const opts = { ...this.options, namespace: ns };

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
    await this.client.create(
      buildSessionPodSpec(
        descriptor,
        opts,
        authPaths,
        options.workspaceSync ?? false,
        options.workspaceExport ?? false,
        options.sessionToken,
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
    await this.client
      .create(buildWorkspacePvcSpec(workspaceId, opts))
      .catch((error: unknown) => {
        // tolerate "already exists" so workspace create is idempotent
        const message = String(error);
        if (!/already exists|AlreadyExists/i.test(message)) throw error;
      });
  }

  async destroyWorkspace(workspaceId: string, namespace?: string): Promise<void> {
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
}
