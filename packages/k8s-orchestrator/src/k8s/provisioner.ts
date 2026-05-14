import type { SessionDescriptor } from "@sentropic/remote-protocol";

import type { ProvisionerEmit, SessionProvisioner } from "../index.js";
import type { K8sClient } from "./client.js";
import {
  DEFAULT_BUILDER_OPTIONS,
  buildSessionPodSpec,
  buildSessionPvcSpec,
  resourceNames,
  type SpecBuilderOptions,
} from "./spec.js";

export type K8sProvisionerOptions = Partial<SpecBuilderOptions>;

export class K8sSessionProvisioner implements SessionProvisioner {
  private readonly options: SpecBuilderOptions;
  private readonly phases = new Map<string, string>();

  constructor(
    private readonly client: K8sClient,
    options: K8sProvisionerOptions = {},
  ) {
    this.options = { ...DEFAULT_BUILDER_OPTIONS, ...options };
  }

  async provision(
    descriptor: SessionDescriptor,
    emit: ProvisionerEmit,
  ): Promise<void> {
    this.phases.set(descriptor.id, "provisioning");
    emit(descriptor.id, "session.lifecycle.changed", {
      previousState: "requested",
      nextState: "provisioning",
    });

    await this.client.create(buildSessionPvcSpec(descriptor, this.options));
    await this.client.create(buildSessionPodSpec(descriptor, this.options));

    this.phases.set(descriptor.id, "starting");
    emit(descriptor.id, "session.lifecycle.changed", {
      previousState: "provisioning",
      nextState: "starting",
    });
  }

  async destroy(sessionId: string, emit: ProvisionerEmit): Promise<void> {
    const previous = this.phases.get(sessionId) ?? "running";
    this.phases.set(sessionId, "stopping");
    emit(sessionId, "session.lifecycle.changed", {
      previousState: previous,
      nextState: "stopping",
    });

    const names = resourceNames({ id: sessionId } as SessionDescriptor);
    const namespace = this.options.namespace;
    await this.client
      .delete({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: names.pod, namespace },
      })
      .catch(() => {});
    await this.client
      .delete({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: names.pvc, namespace },
      })
      .catch(() => {});

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
