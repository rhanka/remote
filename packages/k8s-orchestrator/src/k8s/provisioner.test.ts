import type {
  KubernetesObject,
  KubernetesListObject,
} from "@kubernetes/client-node";
import type { SessionDescriptor } from "@sentropic/remote-protocol";
import { describe, expect, it } from "vitest";

import { K8sSessionProvisioner, parseWorkspaceGcLogs } from "./provisioner.js";
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
  | { op: "create"; kind: string; name: string; namespace?: string | undefined }
  | { op: "delete"; kind: string; name: string; namespace?: string | undefined }
  | { op: "read"; kind: string; name: string; namespace?: string | undefined };

function recordingClient(): { client: K8sClient; ops: Operation[] } {
  const ops: Operation[] = [];
  const client: K8sClient = {
    async create<T extends KubernetesObject>(spec: T): Promise<T> {
      ops.push({
        op: "create",
        kind: spec.kind ?? "?",
        name: spec.metadata?.name ?? "?",
        namespace: spec.metadata?.namespace,
      });
      return spec;
    },
    async delete(ref: K8sResourceRef): Promise<void> {
      ops.push({
        op: "delete",
        kind: ref.kind,
        name: ref.metadata.name,
        namespace: ref.metadata.namespace,
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
        namespace: "demo-ns",
      },
      {
        op: "create",
        kind: "Pod",
        name: "session-sess-test1",
        namespace: "demo-ns",
      },
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
      {
        op: "delete",
        kind: "Pod",
        name: "session-sess-test1",
        namespace: "demo-ns",
      },
      {
        op: "delete",
        kind: "PersistentVolumeClaim",
        name: "session-sess-test1-workspace",
        namespace: "demo-ns",
      },
      {
        op: "delete",
        kind: "Secret",
        name: "session-sess-test1-auth",
        namespace: "demo-ns",
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

  it("recreates the Pod and updates the auth secret on refresh", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "demo-ns",
    });
    await provisioner.provision(descriptor, () => {
      return;
    }, {
      credentials: {
        ".codex/auth.json": "OLD_TOKEN",
      },
    });
    ops.length = 0;

    await provisioner.refresh(
      descriptor,
      () => {
        return;
      },
      {
        credentials: {
          ".codex/auth.json": "NEW_TOKEN",
        },
      },
    );

    expect(ops.map((op) => `${op.op}:${op.kind}`)).toEqual([
      "delete:Pod",
      "delete:Secret",
      "create:Secret",
      "create:Pod",
    ]);
  });

  it("retries the Pod create on refresh while a same-named Pod is still terminating", async () => {
    let podCreateAttempts = 0;
    const createdPod = { done: false };
    const client: K8sClient = {
      async create<T extends KubernetesObject>(spec: T): Promise<T> {
        if (spec.kind === "Pod") {
          podCreateAttempts += 1;
          if (podCreateAttempts === 1) {
            throw new Error(
              'HTTP-Code: 409 object is being deleted: pods "session-sess-test1" already exists',
            );
          }
          createdPod.done = true;
        }
        return spec;
      },
      async delete(): Promise<void> {
        return;
      },
      async read<T extends KubernetesObject>(): Promise<T | undefined> {
        return undefined;
      },
    };
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "demo-ns",
    });

    await provisioner.refresh(descriptor, () => undefined, {
      credentials: { ".codex/auth.json": "NEW_TOKEN" },
    });

    // The 409 on the first Pod create (predecessor still terminating) is
    // retried until it frees up — the refresh succeeds rather than throwing.
    expect(podCreateAttempts).toBe(2);
    expect(createdPod.done).toBe(true);
  });

  it("provisions into the namespace passed in options", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "sentropic-remote",
    });
    await provisioner.provision(descriptor, () => {}, {
      namespace: "user-abc12345",
    });
    const creates = ops.filter((op) => op.op === "create");
    expect(creates.length).toBeGreaterThan(0);
    expect(creates.every((op) => op.namespace === "user-abc12345")).toBe(true);
  });

  it("destroys from the namespace passed in options", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "sentropic-remote",
    });
    await provisioner.destroy(descriptor.id, () => {}, "user-abc12345");
    const deletes = ops.filter((op) => op.op === "delete");
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((op) => op.namespace === "user-abc12345")).toBe(true);
  });

  it("injects REMOTE_TOKEN into the Pod env when a session token is set", async () => {
    const specs: Array<{ kind: string | undefined; spec: unknown }> = [];
    const client: K8sClient = {
      async create<T extends KubernetesObject>(spec: T): Promise<T> {
        specs.push({ kind: spec.kind, spec });
        return spec;
      },
      async delete(): Promise<void> {},
      async read<T extends KubernetesObject>(): Promise<T | undefined> {
        return undefined;
      },
    };
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "demo-ns",
    });
    await provisioner.provision(descriptor, () => {}, {
      sessionToken: "tok-abc123",
    });
    const pod = specs.find((s) => s.kind === "Pod")!.spec as {
      spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> };
    };
    const env = pod.spec.containers[0]!.env;
    expect(env).toContainEqual({ name: "REMOTE_TOKEN", value: "tok-abc123" });
  });

  it("omits REMOTE_TOKEN from the Pod env when no session token is set", async () => {
    const specs: Array<{ kind: string | undefined; spec: unknown }> = [];
    const client: K8sClient = {
      async create<T extends KubernetesObject>(spec: T): Promise<T> {
        specs.push({ kind: spec.kind, spec });
        return spec;
      },
      async delete(): Promise<void> {},
      async read<T extends KubernetesObject>(): Promise<T | undefined> {
        return undefined;
      },
    };
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "demo-ns",
    });
    await provisioner.provision(descriptor, () => {});
    const pod = specs.find((s) => s.kind === "Pod")!.spec as {
      spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> };
    };
    const env = pod.spec.containers[0]!.env;
    expect(env.some((e) => e.name === "REMOTE_TOKEN")).toBe(false);
  });

  it("refresh uses the per-call namespace, not the constructor namespace", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "sentropic-remote",
    });
    await provisioner.provision(descriptor, () => {}, {
      namespace: "user-abc12345",
      credentials: { ".codex/auth.json": "OLD_TOKEN" },
    });
    ops.length = 0;

    await provisioner.refresh(
      descriptor,
      () => {},
      {
        namespace: "user-abc12345",
        credentials: { ".codex/auth.json": "NEW_TOKEN" },
      },
    );

    const namespaces = ops.map((op) => op.namespace);
    expect(namespaces.every((ns) => ns === "user-abc12345")).toBe(true);
    expect(namespaces.some((ns) => ns === "sentropic-remote")).toBe(false);
  });

  it("provisionWorkspace creates the PVC in the per-call namespace", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "sentropic-remote",
    });
    await provisioner.provisionWorkspace("ws-test1", "user-abc12345");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "create",
      kind: "PersistentVolumeClaim",
      namespace: "user-abc12345",
    });
  });

  it("destroyWorkspace deletes the PVC in the per-call namespace", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "sentropic-remote",
    });
    await provisioner.destroyWorkspace("ws-test1", "user-abc12345");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "delete",
      kind: "PersistentVolumeClaim",
      namespace: "user-abc12345",
    });
  });

  it("provisionWorkspace falls back to constructor namespace when no per-call namespace given", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "sentropic-remote",
    });
    await provisioner.provisionWorkspace("ws-test2");
    expect(ops[0]).toMatchObject({ namespace: "sentropic-remote" });
  });

  it("destroyWorkspace falls back to constructor namespace when no per-call namespace given", async () => {
    const { client, ops } = recordingClient();
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "sentropic-remote",
    });
    await provisioner.destroyWorkspace("ws-test2");
    expect(ops[0]).toMatchObject({ namespace: "sentropic-remote" });
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

describe("gcWorkspaces (janitor lifecycle, no cluster)", () => {
  type JanitorClient = K8sClient & { created: KubernetesObject[]; deleted: string[] };

  function janitorClient(args: {
    phase: string;
    logs: string;
    withPodLogs?: boolean;
  }): JanitorClient {
    const created: KubernetesObject[] = [];
    const deleted: string[] = [];
    const client: JanitorClient = {
      created,
      deleted,
      async create<T extends KubernetesObject>(spec: T): Promise<T> {
        created.push(spec);
        return spec;
      },
      async delete(ref: K8sResourceRef): Promise<void> {
        deleted.push(`${ref.kind}/${ref.metadata.name}@${ref.metadata.namespace}`);
      },
      async read<T extends KubernetesObject>(): Promise<T | undefined> {
        return { status: { phase: args.phase } } as unknown as T;
      },
      ...(args.withPodLogs === false
        ? {}
        : {
            async podLogs(): Promise<string> {
              return args.logs;
            },
          }),
    };
    return client;
  }

  const sharedOpts = {
    namespace: "user-abc12345",
    sharedWorkspacePvc: "remote-workspaces",
  };

  it("creates the janitor, parses its logs into the report, then ALWAYS deletes it", async () => {
    const client = janitorClient({
      phase: "Succeeded",
      logs: [
        "KEPT ws-keep1",
        "RECENT ws-busy1",
        "CANDIDATE ws-old1 1.2G 1736000000",
        "CANDIDATE ws-old2 34M 1730000000",
        "GC_DONE",
      ].join("\n"),
    });
    const provisioner = new K8sSessionProvisioner(client, sharedOpts);
    const report = await provisioner.gcWorkspaces({
      olderThanDays: 30,
      apply: false,
      keep: ["ws-keep1"],
      pollIntervalMs: 1,
    });

    expect(report.applied).toBe(false);
    expect(report.failed).toEqual([]);
    expect(report.candidates).toEqual([
      {
        id: "ws-old1",
        sizeH: "1.2G",
        lastModified: new Date(1736000000 * 1000).toISOString(),
      },
      {
        id: "ws-old2",
        sizeH: "34M",
        lastModified: new Date(1730000000 * 1000).toISOString(),
      },
    ]);

    const pod = client.created[0]!;
    expect(pod.kind).toBe("Pod");
    expect(pod.metadata?.name).toMatch(/^workspace-gc-/);
    expect(pod.metadata?.namespace).toBe("user-abc12345");
    expect(client.deleted).toEqual([
      `Pod/${pod.metadata?.name}@user-abc12345`,
    ]);
  });

  it("apply: ARCHIVED lines attach the on-volume trash path; FAILED dirs are reported untouched", async () => {
    const client = janitorClient({
      phase: "Succeeded",
      logs: [
        "CANDIDATE ws-old1 1.2G 1736000000",
        "ARCHIVED ws-old1 .trash/ws-old1.1750000000.tar.gz",
        "CANDIDATE ws-bad1 9G 1730000000",
        "FAILED ws-bad1 archive-failed-directory-left-untouched",
        "GC_DONE",
      ].join("\n"),
    });
    const provisioner = new K8sSessionProvisioner(client, sharedOpts);
    const report = await provisioner.gcWorkspaces({
      olderThanDays: 30,
      apply: true,
      keep: [],
      pollIntervalMs: 1,
    });
    expect(report.applied).toBe(true);
    expect(report.candidates[0]).toMatchObject({
      id: "ws-old1",
      archivedTo: ".trash/ws-old1.1750000000.tar.gz",
    });
    expect(report.failed).toEqual([
      { id: "ws-bad1", reason: "archive-failed-directory-left-untouched" },
    ]);
  });

  it("throws on a Failed janitor but STILL deletes the pod", async () => {
    const client = janitorClient({ phase: "Failed", logs: "boom" });
    const provisioner = new K8sSessionProvisioner(client, sharedOpts);
    await expect(
      provisioner.gcWorkspaces({
        olderThanDays: 30,
        apply: false,
        keep: [],
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/janitor pod .* failed/);
    expect(client.deleted).toHaveLength(1);
  });

  it("refuses to report from logs missing the GC_DONE sentinel (truncated run)", async () => {
    const client = janitorClient({
      phase: "Succeeded",
      logs: "CANDIDATE ws-old1 1.2G 1736000000",
    });
    const provisioner = new K8sSessionProvisioner(client, sharedOpts);
    await expect(
      provisioner.gcWorkspaces({
        olderThanDays: 30,
        apply: false,
        keep: [],
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/GC_DONE/);
    expect(client.deleted).toHaveLength(1);
  });

  it("times out cleanly when the janitor never terminates (pod reaped, error raised)", async () => {
    const client = janitorClient({ phase: "Pending", logs: "" });
    const provisioner = new K8sSessionProvisioner(client, sharedOpts);
    await expect(
      provisioner.gcWorkspaces({
        olderThanDays: 30,
        apply: false,
        keep: [],
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/did not complete/);
    expect(client.deleted).toHaveLength(1);
  });

  it("refuses to run without sharedWorkspacePvc (no janitor created)", async () => {
    const client = janitorClient({ phase: "Succeeded", logs: "GC_DONE" });
    const provisioner = new K8sSessionProvisioner(client, {
      namespace: "demo-ns",
    });
    await expect(
      provisioner.gcWorkspaces({ olderThanDays: 30, apply: false, keep: [] }),
    ).rejects.toThrow(/sharedWorkspacePvc/);
    expect(client.created).toHaveLength(0);
  });

  it("refuses to run on a client without podLogs (no janitor created)", async () => {
    const client = janitorClient({
      phase: "Succeeded",
      logs: "GC_DONE",
      withPodLogs: false,
    });
    const provisioner = new K8sSessionProvisioner(client, sharedOpts);
    await expect(
      provisioner.gcWorkspaces({ olderThanDays: 30, apply: false, keep: [] }),
    ).rejects.toThrow(/podLogs/);
    expect(client.created).toHaveLength(0);
  });
});

describe("parseWorkspaceGcLogs", () => {
  it("requires the GC_DONE sentinel", () => {
    expect(() => parseWorkspaceGcLogs("CANDIDATE ws-a 1M 1", false)).toThrow(
      /GC_DONE/,
    );
  });

  it("tolerates noise lines and unknown epochs", () => {
    const report = parseWorkspaceGcLogs(
      ["something irrelevant", "CANDIDATE ws-a 1M 0", "GC_DONE"].join("\n"),
      false,
    );
    expect(report.candidates).toEqual([
      { id: "ws-a", sizeH: "1M", lastModified: "unknown" },
    ]);
  });
});
