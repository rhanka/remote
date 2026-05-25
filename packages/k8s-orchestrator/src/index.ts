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
  destroy(sessionId: string, emit: ProvisionerEmit): Promise<void>;
  inspect(sessionId: string): Promise<{ phase: string } | undefined>;
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

  async destroy(sessionId: string, emit: ProvisionerEmit): Promise<void> {
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

export { K8sSessionProvisioner } from "./k8s/provisioner.js";
export type { K8sProvisionerOptions } from "./k8s/provisioner.js";
export { KubernetesObjectApiClient } from "./k8s/object-api-client.js";
export type { K8sClient, K8sResourceRef } from "./k8s/client.js";
export {
  DEFAULT_BUILDER_OPTIONS,
  buildSessionPodSpec,
  buildSessionPvcSpec,
  buildSessionAuthSecret,
  credentialSecretKey,
  resourceNames,
  sessionLabels,
  type K8sPodSpec,
  type K8sPvcSpec,
  type K8sSecretSpec,
  type K8sVolume,
  type K8sVolumeMount,
  type ResourceQuantities,
  type SpecBuilderOptions,
} from "./k8s/spec.js";
