import {
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
    );
  }

  constructor(private readonly api: KubernetesObjectApi) {}

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
}
