import type {
  KubernetesObject,
  KubernetesListObject,
} from "@kubernetes/client-node";
import type { SessionDescriptor } from "@sentropic/remote-protocol";
import { describe, expect, it } from "vitest";

import { K8sSessionProvisioner } from "./provisioner.js";
import type { K8sClient, K8sResourceRef } from "./client.js";

const descriptor: SessionDescriptor = {
  id: "sess-test1",
  profile: "codex",
  target: "k3s",
  workspacePath: "/workspace",
  createdAt: "2026-05-14T18:00:00.000Z",
  createdBy: {
    id: "control-plane",
    kind: "control-plane",
    displayName: "Control Plane",
  },
};

type Operation =
  | { op: "create"; kind: string; name: string }
  | { op: "delete"; kind: string; name: string }
  | { op: "read"; kind: string; name: string };

function recordingClient(): { client: K8sClient; ops: Operation[] } {
  const ops: Operation[] = [];
  const client: K8sClient = {
    async create<T extends KubernetesObject>(spec: T): Promise<T> {
      ops.push({
        op: "create",
        kind: spec.kind ?? "?",
        name: spec.metadata?.name ?? "?",
      });
      return spec;
    },
    async delete(ref: K8sResourceRef): Promise<void> {
      ops.push({
        op: "delete",
        kind: ref.kind,
        name: ref.metadata.name,
      });
    },
    async read<T extends KubernetesObject>(
      ref: K8sResourceRef,
    ): Promise<T | undefined> {
      ops.push({ op: "read", kind: ref.kind, name: ref.metadata.name });
      return undefined;
    },
  };
  return { client, ops };
}

describe("K8sSessionProvisioner", () => {
  it("creates the PVC then the Pod and emits lifecycle events", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "demo-ns",
    });

    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    await provisioner.provision(descriptor, (_id, type, payload) => {
      events.push({ type, payload });
    });

    expect(ops).toEqual([
      {
        op: "create",
        kind: "PersistentVolumeClaim",
        name: "session-sess-test1-workspace",
      },
      { op: "create", kind: "Pod", name: "session-sess-test1" },
    ]);
    expect(events.map((event) => event.payload.nextState)).toEqual([
      "provisioning",
      "starting",
    ]);

    const inspected = await provisioner.inspect(descriptor.id);
    expect(inspected?.phase).toBe("starting");
  });

  it("deletes the Pod and PVC on destroy and emits stopping then stopped", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "demo-ns",
    });
    await provisioner.provision(descriptor, () => {});
    ops.length = 0;

    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    await provisioner.destroy(descriptor.id, (_id, type, payload) => {
      events.push({ type, payload });
    });

    expect(ops).toEqual([
      { op: "delete", kind: "Pod", name: "session-sess-test1" },
      {
        op: "delete",
        kind: "PersistentVolumeClaim",
        name: "session-sess-test1-workspace",
      },
      {
        op: "delete",
        kind: "Secret",
        name: "session-sess-test1-auth",
      },
    ]);
    expect(events.map((event) => event.payload.nextState)).toEqual([
      "stopping",
      "stopped",
    ]);
    expect(await provisioner.inspect(descriptor.id)).toBeUndefined();
  });

  it("ignores delete errors so a half-provisioned session can still clean up", async () => {
    let calls = 0;
    const client: K8sClient = {
      async create<T extends KubernetesObject>(spec: T): Promise<T> {
        return spec;
      },
      async delete(): Promise<void> {
        calls += 1;
        throw new Error("not found");
      },
      async read<T extends KubernetesObject>(): Promise<T | undefined> {
        return undefined;
      },
    };
    const provisioner = new K8sSessionProvisioner(client);
    await provisioner.destroy("sess-missing", () => {});
    expect(calls).toBeGreaterThan(0);
  });

  it("creates a Secret before the Pod when credentials are passed", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "demo-ns",
    });
    await provisioner.provision(descriptor, () => {}, {
      credentials: {
        ".codex/auth.json": "BASE64==",
        ".claude/.credentials.json": "BASE64==",
      },
    });
    expect(ops.map((op) => `${op.op}:${op.kind}`)).toEqual([
      "create:Secret",
      "create:PersistentVolumeClaim",
      "create:Pod",
    ]);
    expect(ops[0]!.name).toBe("session-sess-test1-auth");
  });

  it("ensures KubernetesListObject typing surface stays usable", () => {
    const list: KubernetesListObject<KubernetesObject> = {
      apiVersion: "v1",
      kind: "List",
      metadata: {},
      items: [],
    };
    expect(list.items).toEqual([]);
  });
});
