import {
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  type KubernetesObject,
} from "@kubernetes/client-node";

import type { K8sClient, K8sResourceRef } from "./client.js";

export class KubernetesObjectApiClient implements K8sClient {
  static fromDefault(): KubernetesObjectApiClient {
    const config = new KubeConfig();
    config.loadFromDefault();
    return new KubernetesObjectApiClient(
      KubernetesObjectApi.makeApiClient(config),
      config.makeApiClient(CoreV1Api),
    );
  }

  constructor(
    private readonly api: KubernetesObjectApi,
    private readonly core?: CoreV1Api,
  ) {}

  async create<T extends KubernetesObject>(spec: T): Promise<T> {
    return (await this.api.create(spec)) as T;
  }

  async delete(ref: K8sResourceRef): Promise<void> {
    await this.api.delete(ref as KubernetesObject);
  }

  async read<T extends KubernetesObject>(
    ref: K8sResourceRef,
  ): Promise<T | undefined> {
    try {
      const result = await this.api.read(
        ref as unknown as Parameters<typeof this.api.read>[0],
      );
      return result as T;
    } catch (error) {
      const statusCode =
        (error as { code?: number }).code ??
        (error as { statusCode?: number }).statusCode;
      if (statusCode === 404) return undefined;
      throw error;
    }
  }

  async podLogs(ref: K8sResourceRef): Promise<string> {
    if (!this.core) {
      throw new Error(
        "KubernetesObjectApiClient: CoreV1Api not wired (construct via fromDefault() to read pod logs)",
      );
    }
    return await this.core.readNamespacedPodLog({
      name: ref.metadata.name,
      namespace: ref.metadata.namespace,
    });
  }
}
