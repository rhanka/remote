import { describe, expect, it, vi } from "vitest";

import {
  HeadfulBrowserBridge,
  type BrowserHandle,
  type BrowserSpawnConfig,
  type BrowserSpawner,
} from "./bridge.js";
import type { RandomBytes } from "./token.js";

/** Deterministic test seams: fixed RNG, fixed clock, fixed ids. */
const fixedRng: RandomBytes = (n) => new Uint8Array(n).fill(0xab);
const fixedNow = () => 1_000_000;
let idCounter = 0;
const seqId = (prefix: string) => `${prefix}-${++idCounter}`;

class FakeSpawner implements BrowserSpawner {
  spawned: BrowserSpawnConfig[] = [];
  killed = 0;
  failOnSpawn = false;
  async spawn(config: BrowserSpawnConfig): Promise<BrowserHandle> {
    if (this.failOnSpawn) throw new Error("xvfb boom");
    this.spawned.push(config);
    return { pid: "12345" };
  }
  async kill(): Promise<void> {
    this.killed += 1;
  }
}

const makeBridge = (spawner: BrowserSpawner) => {
  idCounter = 0;
  return new HeadfulBrowserBridge({
    spawner,
    now: fixedNow,
    rng: fixedRng,
    newId: seqId,
  });
};

describe("HeadfulBrowserBridge.start", () => {
  it("starts a session-private browser, spawns the sidecar, returns the URL + payloads", async () => {
    const spawner = new FakeSpawner();
    const bridge = makeBridge(spawner);
    const res = await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "session-private",
      requester: "session-owner",
      ttlMs: 600_000,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.spawned[0]!.interactive).toBe(true); // 2FA default
    expect(spawner.spawned[0]!.token).toBe("ab".repeat(16));
    expect(res.podPort).toBe(6080);
    expect(res.forwardCommand).toBe("remote forward sess-1 6080");
    expect(new URL(res.url).searchParams.get("path")).toBe(
      `websockify?token=${"ab".repeat(16)}`,
    );
    expect(res.started.transport).toBe("novnc");
    expect(res.routeCreated.exposurePolicy).toBe("session-private");
    expect(res.routeCreated.expiresAt).toBe(
      new Date(fixedNow() + 600_000).toISOString(),
    );
    expect(bridge.status().state).toBe("running");
    expect(bridge.status().tokenPresent).toBe(true);
  });

  it("DENIES per policy and never spawns (anonymous on session-private)", async () => {
    const spawner = new FakeSpawner();
    const bridge = makeBridge(spawner);
    const res = await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "session-private",
      requester: "anonymous",
      ttlMs: 600_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("anonymous");
    expect(spawner.spawned).toHaveLength(0);
    expect(bridge.status().state).toBe("idle");
  });

  it("public-expiring requires the TTL the bridge forwards (allowed with positive ttl)", async () => {
    const bridge = makeBridge(new FakeSpawner());
    const res = await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "public-expiring",
      requester: "anonymous",
      ttlMs: 60_000,
    });
    expect(res.ok).toBe(true);
  });

  it("public-expiring DENIES a zero/negative ttl (open-ended public route)", async () => {
    const spawner = new FakeSpawner();
    const bridge = makeBridge(spawner);
    const res = await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "public-expiring",
      requester: "operator",
      ttlMs: 0,
    });
    expect(res.ok).toBe(false);
    expect(spawner.spawned).toHaveLength(0);
  });

  it("honours interactive:false (view-only) when explicitly requested", async () => {
    const spawner = new FakeSpawner();
    const bridge = makeBridge(spawner);
    const res = await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "operator-only",
      requester: "operator",
      ttlMs: 60_000,
      interactive: false,
    });
    expect(res.ok).toBe(true);
    expect(spawner.spawned[0]!.interactive).toBe(false);
    if (res.ok) expect(res.url).toContain("view_only=true");
  });

  it("transitions to failed and reports the reason when the spawner throws", async () => {
    const spawner = new FakeSpawner();
    spawner.failOnSpawn = true;
    const bridge = makeBridge(spawner);
    const res = await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "operator-only",
      requester: "operator",
      ttlMs: 60_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("xvfb boom");
    expect(bridge.status().state).toBe("failed");
  });

  it("rejects a second concurrent start while live", async () => {
    const bridge = makeBridge(new FakeSpawner());
    await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "operator-only",
      requester: "operator",
      ttlMs: 60_000,
    });
    const second = await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "operator-only",
      requester: "operator",
      ttlMs: 60_000,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain("already");
  });
});

describe("HeadfulBrowserBridge.stop", () => {
  it("kills the sidecar, clears the token, returns route-expired", async () => {
    const spawner = new FakeSpawner();
    const bridge = makeBridge(spawner);
    const start = await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "operator-only",
      requester: "operator",
      ttlMs: 60_000,
    });
    expect(start.ok).toBe(true);
    const routeId = start.ok ? start.routeId : "";
    const expired = await bridge.stop();
    expect(spawner.killed).toBe(1);
    expect(expired?.routeId).toBe(routeId);
    expect(bridge.status().state).toBe("stopped");
    expect(bridge.status().tokenPresent).toBe(false);
    expect(bridge.status().browserId).toBeUndefined();
  });

  it("is a no-op (undefined) when nothing is live", async () => {
    const bridge = makeBridge(new FakeSpawner());
    expect(await bridge.stop()).toBeUndefined();
  });

  it("allows a fresh start after stop (reset from terminal)", async () => {
    const spawner = new FakeSpawner();
    const bridge = makeBridge(spawner);
    await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "operator-only",
      requester: "operator",
      ttlMs: 60_000,
    });
    await bridge.stop();
    const again = await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "operator-only",
      requester: "operator",
      ttlMs: 60_000,
    });
    expect(again.ok).toBe(true);
    expect(bridge.status().state).toBe("running");
    expect(spawner.spawned).toHaveLength(2);
  });

  it("still expires the route when the spawner.kill throws (best-effort)", async () => {
    const spawner = new FakeSpawner();
    const bridge = makeBridge(spawner);
    await bridge.start({
      sessionId: "sess-1",
      exposurePolicy: "operator-only",
      requester: "operator",
      ttlMs: 60_000,
    });
    vi.spyOn(spawner, "kill").mockRejectedValueOnce(new Error("kill failed"));
    const expired = await bridge.stop();
    expect(expired).toBeDefined();
    expect(bridge.status().state).toBe("stopped");
  });
});
