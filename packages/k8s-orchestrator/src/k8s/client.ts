import type { KubernetesObject } from "@kubernetes/client-node";

export type K8sResourceRef = {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: { readonly name: string; readonly namespace: string };
};

export interface K8sClient {
  create<T extends KubernetesObject>(spec: T): Promise<T>;
  delete(ref: K8sResourceRef): Promise<void>;
  read<T extends KubernetesObject>(ref: K8sResourceRef): Promise<T | undefined>;
}
