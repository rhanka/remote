import { describe, expect, it } from "vitest";

import {
  DEFAULT_FANOUT_MAX,
  mapWithConcurrency,
  planRemoteFanout,
} from "./fanout.js";

describe("planRemoteFanout (pure, collision-free remote fan-out descriptors)", () => {
  it("count=1 is a byte-for-byte passthrough: bare base, no suffix", () => {
    expect(planRemoteFanout({ base: "myproj", count: 1 })).toEqual([
      { index: 1, name: "myproj", workspaceName: "myproj", subPath: "myproj" },
    ]);
  });

  it("count>1 derives <base>-NN, zero-padded to the count width", () => {
    const members = planRemoteFanout({ base: "api", count: 3 });
    expect(members.map((m) => m.name)).toEqual(["api-1", "api-2", "api-3"]);
    expect(members.map((m) => m.index)).toEqual([1, 2, 3]);
    // 12 → two-digit padding so names sort lexically and never prefix-collide.
    const wide = planRemoteFanout({ base: "api", count: 12 });
    expect(wide[0]!.name).toBe("api-01");
    expect(wide[11]!.name).toBe("api-12");
  });

  it("every member gets a DISTINCT subPath (no shared tree on the RWX volume)", () => {
    const members = planRemoteFanout({ base: "fleet", count: DEFAULT_FANOUT_MAX });
    const subPaths = new Set(members.map((m) => m.subPath));
    expect(subPaths.size).toBe(members.length);
    // subPath mirrors the member name (the intended per-member subPath label).
    expect(members.every((m) => m.subPath === m.name)).toBe(true);
    // workspaceName is also distinct per member (own createWorkspace → own id).
    expect(new Set(members.map((m) => m.workspaceName)).size).toBe(members.length);
  });

  it("enforces the bound: count exactly at max is allowed, count>max rejected", () => {
    expect(() => planRemoteFanout({ base: "x", count: 4, max: 4 })).not.toThrow();
    expect(() => planRemoteFanout({ base: "x", count: 5, max: 4 })).toThrow(
      /exceeds the fan-out cap of 4/,
    );
  });

  it("defaults the cap to DEFAULT_FANOUT_MAX when max is omitted", () => {
    expect(() =>
      planRemoteFanout({ base: "x", count: DEFAULT_FANOUT_MAX }),
    ).not.toThrow();
    expect(() =>
      planRemoteFanout({ base: "x", count: DEFAULT_FANOUT_MAX + 1 }),
    ).toThrow(/exceeds the fan-out cap of 16/);
  });

  it("rejects count < 1 and non-integer counts", () => {
    expect(() => planRemoteFanout({ base: "x", count: 0 })).toThrow(/whole number/);
    expect(() => planRemoteFanout({ base: "x", count: -3 })).toThrow(/whole number/);
    expect(() => planRemoteFanout({ base: "x", count: 2.5 })).toThrow(/whole number/);
  });

  it("rejects a base that is not name-safe (would yield an invalid subPath/k8s name)", () => {
    expect(() => planRemoteFanout({ base: "bad name", count: 2 })).toThrow(
      /not name-safe/,
    );
    expect(() => planRemoteFanout({ base: "../escape", count: 2 })).toThrow(
      /not name-safe/,
    );
    expect(() => planRemoteFanout({ base: "co#1", count: 2 })).toThrow(/not name-safe/);
  });

  it("rejects a degenerate max < 1", () => {
    expect(() => planRemoteFanout({ base: "x", count: 1, max: 0 })).toThrow(
      /max must be a whole number/,
    );
  });
});

describe("mapWithConcurrency (bounded fan-out creation, order-preserving)", () => {
  it("preserves input order in results regardless of completion order", async () => {
    const out = await mapWithConcurrency([10, 20, 30], 2, async (n) => n * 2);
    expect(out).toEqual([
      { status: "fulfilled", value: 20 },
      { status: "fulfilled", value: 40 },
      { status: "fulfilled", value: 60 },
    ]);
  });

  it("isolates failures: one rejected task does not abort the others", async () => {
    const out = await mapWithConcurrency([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(out[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(out[1]!.status).toBe("rejected");
    expect(out[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("never runs more than `limit` tasks at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 8 }, (_v, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles an empty input list", async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });
});
