import type {
  SessionProvisioner,
  WorkspaceGcOptions,
  WorkspaceGcReport,
} from "@sentropic/remote-k8s-orchestrator";
import { describe, expect, it } from "vitest";

import { createControlPlane } from "../index.js";

/** Provisioner stub recording the gcWorkspaces call (no cluster, ever). */
function gcProvisioner(report?: Partial<WorkspaceGcReport>): {
  provisioner: SessionProvisioner;
  calls: WorkspaceGcOptions[];
} {
  const calls: WorkspaceGcOptions[] = [];
  const provisioner: SessionProvisioner = {
    async provision() {},
    async refresh() {},
    async destroy() {},
    async inspect() {
      return undefined;
    },
    async provisionWorkspace() {},
    async destroyWorkspace() {},
    async gcWorkspaces(opts: WorkspaceGcOptions): Promise<WorkspaceGcReport> {
      calls.push(opts);
      return {
        candidates: [],
        applied: opts.apply,
        failed: [],
        ...report,
      };
    },
  };
  return { provisioner, calls };
}

async function createWorkspace(
  app: ReturnType<typeof createControlPlane>,
): Promise<string> {
  const res = await app.request("/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { workspace: { id: string } };
  return json.workspace.id;
}

describe("POST /workspaces/gc", () => {
  it("defaults to a 30-day dry-run and returns the provisioner report", async () => {
    const { provisioner, calls } = gcProvisioner({
      candidates: [
        { id: "ws-old1", sizeH: "1.2G", lastModified: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const app = createControlPlane({ provisioner });
    const res = await app.request("/workspaces/gc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      candidates: [
        { id: "ws-old1", sizeH: "1.2G", lastModified: "2026-01-01T00:00:00.000Z" },
      ],
      applied: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      olderThanDays: 30,
      apply: false,
      hasLiveSessions: false,
    });
  });

  it("keep is derived from the session store (every known session's workspaceId) plus registered workspaces", async () => {
    const { provisioner, calls } = gcProvisioner();
    const app = createControlPlane({ provisioner });

    // a registered workspace with NO session must be kept too
    const registeredWs = await createWorkspace(app);
    // a session bound to a workspace puts that workspaceId into keep
    const boundWs = await createWorkspace(app);
    const sessionRes = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "codex",
        target: "k3s",
        workspaceId: boundWs,
      }),
    });
    expect(sessionRes.status).toBe(201);

    const res = await app.request("/workspaces/gc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ olderThanDays: 7 }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.olderThanDays).toBe(7);
    expect(calls[0]!.keep).toContain(registeredWs);
    expect(calls[0]!.keep).toContain(boundWs);
    // a session is live in the store -> janitor must co-locate (required affinity)
    expect(calls[0]!.hasLiveSessions).toBe(true);
  });

  it("passes apply=true through and reports failed archives", async () => {
    const { provisioner, calls } = gcProvisioner({
      candidates: [
        {
          id: "ws-old1",
          sizeH: "1.2G",
          lastModified: "2026-01-01T00:00:00.000Z",
          archivedTo: ".trash/ws-old1.1750000000.tar.gz",
        },
      ],
      failed: [{ id: "ws-bad1", reason: "archive-failed" }],
    });
    const app = createControlPlane({ provisioner });
    const res = await app.request("/workspaces/gc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apply: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      applied: boolean;
      failed?: Array<{ id: string }>;
    };
    expect(json.applied).toBe(true);
    expect(json.failed).toEqual([{ id: "ws-bad1", reason: "archive-failed" }]);
    expect(calls[0]!.apply).toBe(true);
  });

  it("rejects malformed retention windows instead of widening the GC scope", async () => {
    const { provisioner, calls } = gcProvisioner();
    const app = createControlPlane({ provisioner });
    for (const olderThanDays of [0, -3, 1.5, "30"]) {
      const res = await app.request("/workspaces/gc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanDays }),
      });
      expect(res.status).toBe(400);
    }
    const badApply = await app.request("/workspaces/gc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apply: "yes" }),
    });
    expect(badApply.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("returns 501 when the provisioner cannot GC (e.g. in-memory)", async () => {
    const app = createControlPlane(); // InMemoryProvisioner: no gcWorkspaces
    const res = await app.request("/workspaces/gc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(501);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("workspace.gc_unsupported");
  });

  it("maps a janitor failure to a clean 502 (retryable)", async () => {
    const { provisioner } = gcProvisioner();
    provisioner.gcWorkspaces = async () => {
      throw new Error("janitor pod workspace-gc-x failed");
    };
    const app = createControlPlane({ provisioner });
    const res = await app.request("/workspaces/gc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { code: string; retryable: boolean };
    expect(json.code).toBe("workspace.gc_failed");
    expect(json.retryable).toBe(true);
  });
});
