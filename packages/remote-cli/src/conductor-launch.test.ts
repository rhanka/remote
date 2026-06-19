import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildConductorTask,
  computeDurableWorkspaceId,
  normalizeRootCommits,
  detectAvailableHosts,
  freshestLaunchEnvelope,
  h2aReportsLiveConductor,
  markLaunchEnvelopeProcessed,
  parseConductorLaunchEnvelope,
  readLastLaunchAt,
  readLaunchEnvelopes,
  recordLaunchAt,
  selectHost,
  shouldLaunch,
  type ConductorLaunchRequest,
} from "./conductor-launch.js";

const baseRequest = (
  over: Partial<ConductorLaunchRequest> = {},
): ConductorLaunchRequest => ({
  kind: "conductor-launch-request",
  workspaceId: "ws:sha256:abc123",
  hostPref: ["claude", "codex", "agy"],
  stalled: [
    { id: "wp-1", title: "ship the thing", reason: "no conductor", since: "2026-06-10T00:00:00.000Z" },
  ],
  reason: "stalled work and no live conductor",
  ...over,
});

/** Wrap a request in the on-disk h2a message envelope the contract specifies. */
const envelope = (request: unknown, over: Record<string, unknown> = {}) => ({
  protocol: "sentropic.h2a",
  version: "0.1",
  id: "env:123:launch",
  type: "message",
  actor: { instance: "h2a:track:abc", role: "AGENTS", scope: "scope:default" },
  to: "remote:cli",
  body: { kind: "message", topic: "conductor-launch-request", request },
  createdAt: "2026-06-10T00:00:00.000Z",
  ...over,
});

// ---------------------------------------------------------------------------
// parseConductorLaunchEnvelope
// ---------------------------------------------------------------------------

describe("parseConductorLaunchEnvelope", () => {
  it("parses a valid envelope into a typed request", () => {
    const req = baseRequest();
    const parsed = parseConductorLaunchEnvelope(JSON.stringify(envelope(req)));
    expect(parsed).toEqual(req);
  });

  it("accepts an already-parsed object (not just a JSON string)", () => {
    const req = baseRequest();
    expect(parseConductorLaunchEnvelope(envelope(req))).toEqual(req);
  });

  it("normalizes a missing/empty hostPref to the default order", () => {
    const req = baseRequest({ hostPref: [] });
    const parsed = parseConductorLaunchEnvelope(envelope(req));
    expect(parsed?.hostPref).toEqual(["claude", "codex", "agy"]);
  });

  it("drops unknown hosts from hostPref but keeps the known ones in order", () => {
    const parsed = parseConductorLaunchEnvelope(
      envelope(baseRequest({ hostPref: ["gpt" as never, "codex", "claude"] })),
    );
    expect(parsed?.hostPref).toEqual(["codex", "claude"]);
  });

  it("falls back to the default order when hostPref has only unknown hosts", () => {
    const parsed = parseConductorLaunchEnvelope(
      envelope(baseRequest({ hostPref: ["gpt" as never, "llama" as never] })),
    );
    expect(parsed?.hostPref).toEqual(["claude", "codex", "agy"]);
  });

  it("tolerates an empty/absent stalled list", () => {
    const parsed = parseConductorLaunchEnvelope(
      envelope({ ...baseRequest(), stalled: undefined }),
    );
    expect(parsed?.stalled).toEqual([]);
  });

  it("keeps only well-formed stalled items (id+title required)", () => {
    const parsed = parseConductorLaunchEnvelope(
      envelope({
        ...baseRequest(),
        stalled: [
          { id: "ok", title: "good" },
          { title: "no id" },
          { id: "no title" },
          "garbage",
          { id: "ok2", title: "good2", reason: "r", since: "s" },
        ],
      }),
    );
    expect(parsed?.stalled).toEqual([
      { id: "ok", title: "good" },
      { id: "ok2", title: "good2", reason: "r", since: "s" },
    ]);
  });

  it("returns undefined when the topic is not conductor-launch-request", () => {
    expect(
      parseConductorLaunchEnvelope(
        envelope(baseRequest(), {
          body: { kind: "message", topic: "something-else", request: baseRequest() },
        }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when body.kind is not 'message'", () => {
    expect(
      parseConductorLaunchEnvelope(
        envelope(baseRequest(), {
          body: { kind: "event", topic: "conductor-launch-request", request: baseRequest() },
        }),
      ),
    ).toBeUndefined();
  });

  it("returns undefined when the workspaceId is missing", () => {
    const { workspaceId: _drop, ...rest } = baseRequest();
    expect(
      parseConductorLaunchEnvelope(envelope(rest as unknown)),
    ).toBeUndefined();
  });

  it("returns undefined on malformed JSON", () => {
    expect(parseConductorLaunchEnvelope("{not json")).toBeUndefined();
  });

  it("returns undefined on a non-object / non-envelope", () => {
    expect(parseConductorLaunchEnvelope("42")).toBeUndefined();
    expect(parseConductorLaunchEnvelope(JSON.stringify({}))).toBeUndefined();
  });

  it("also reads the request when it is spread directly under body (no .request)", () => {
    const req = baseRequest();
    // Spread the request fields onto body, but body.kind stays the envelope
    // message-kind ("message"); request.kind is recomputed by the parser.
    const { kind: _reqKind, ...reqFields } = req;
    const parsed = parseConductorLaunchEnvelope(
      envelope(undefined, {
        body: { kind: "message", topic: "conductor-launch-request", ...reqFields },
      }),
    );
    expect(parsed).toEqual(req);
  });
});

// ---------------------------------------------------------------------------
// selectHost
// ---------------------------------------------------------------------------

describe("selectHost", () => {
  it("returns the first preferred host that is available", () => {
    expect(selectHost(["claude", "codex", "agy"], new Set(["codex", "agy"]))).toBe(
      "codex",
    );
  });

  it("honors the preference ORDER, not the availability set order", () => {
    expect(selectHost(["agy", "claude"], new Set(["claude", "agy"]))).toBe("agy");
  });

  it("returns undefined when no preferred host is available", () => {
    expect(selectHost(["claude", "codex"], new Set(["agy"]))).toBeUndefined();
  });

  it("returns undefined for an empty preference list", () => {
    expect(selectHost([], new Set(["claude"]))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// shouldLaunch
// ---------------------------------------------------------------------------

describe("shouldLaunch", () => {
  const now = Date.parse("2026-06-10T12:00:00.000Z");
  const cooldownMs = 30 * 60_000;

  it("launches when there is no live conductor and no recent launch", () => {
    const r = shouldLaunch({
      request: baseRequest(),
      liveConductors: 0,
      lastLaunchAt: undefined,
      now,
      cooldownMs,
    });
    expect(r.launch).toBe(true);
  });

  it("skips when a conductor is already live (idempotent)", () => {
    const r = shouldLaunch({
      request: baseRequest(),
      liveConductors: 1,
      lastLaunchAt: undefined,
      now,
      cooldownMs,
    });
    expect(r.launch).toBe(false);
    expect(r.reason).toMatch(/conductor.*alive|already/i);
  });

  it("skips within the cooldown window since the last launch", () => {
    const r = shouldLaunch({
      request: baseRequest(),
      liveConductors: 0,
      lastLaunchAt: now - 10 * 60_000, // 10 min ago, cooldown is 30
      now,
      cooldownMs,
    });
    expect(r.launch).toBe(false);
    expect(r.reason).toMatch(/cooldown/i);
  });

  it("launches once the cooldown has elapsed", () => {
    const r = shouldLaunch({
      request: baseRequest(),
      liveConductors: 0,
      lastLaunchAt: now - 31 * 60_000,
      now,
      cooldownMs,
    });
    expect(r.launch).toBe(true);
  });

  it("skips when there is no stalled work to conduct", () => {
    const r = shouldLaunch({
      request: baseRequest({ stalled: [] }),
      liveConductors: 0,
      lastLaunchAt: undefined,
      now,
      cooldownMs,
    });
    expect(r.launch).toBe(false);
    expect(r.reason).toMatch(/stalled|nothing/i);
  });

  it("prioritizes the live-conductor check over the cooldown", () => {
    const r = shouldLaunch({
      request: baseRequest(),
      liveConductors: 2,
      lastLaunchAt: now - 1_000,
      now,
      cooldownMs,
    });
    expect(r.launch).toBe(false);
    expect(r.reason).toMatch(/conductor.*alive|already/i);
  });
});

// ---------------------------------------------------------------------------
// buildConductorTask
// ---------------------------------------------------------------------------

describe("buildConductorTask", () => {
  it("instructs the agent to claim the conductor role at boot", () => {
    const task = buildConductorTask(baseRequest());
    expect(task).toMatch(/h2a conductor claim/);
  });

  it("includes the workspace id and the stalled item titles", () => {
    const task = buildConductorTask(
      baseRequest({
        workspaceId: "ws:sha256:deadbeef",
        stalled: [
          { id: "a", title: "Alpha task" },
          { id: "b", title: "Beta task", reason: "blocked" },
        ],
      }),
    );
    expect(task).toContain("ws:sha256:deadbeef");
    expect(task).toContain("Alpha task");
    expect(task).toContain("Beta task");
  });

  it("returns a single non-empty string even with no stalled items", () => {
    const task = buildConductorTask(baseRequest({ stalled: [] }));
    expect(typeof task).toBe("string");
    expect(task.length).toBeGreaterThan(0);
  });

  it("never embeds a bash -lc construct (task is plain prose, runs as argv)", () => {
    const task = buildConductorTask(baseRequest());
    expect(task).not.toContain("bash -lc");
  });
});

// ---------------------------------------------------------------------------
// computeDurableWorkspaceId
// ---------------------------------------------------------------------------

describe("computeDurableWorkspaceId", () => {
  it("produces a stable ws:<hex> id for the same input", () => {
    const a = computeDurableWorkspaceId("abc", "");
    const b = computeDurableWorkspaceId("abc", "");
    expect(a).toBe(b);
    expect(a).toMatch(/^ws:[0-9a-f]{64}$/);
  });

  // Vectors pinned WITH track + h2a 0.68 (a2a-cli) — these MUST stay byte-identical
  // or conductor-launch-request envelopes will never match the local repo.
  it("matches a2a-cli's pinned vectors exactly", () => {
    expect(computeDurableWorkspaceId("abc", "")).toBe(
      "ws:edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb",
    );
    expect(computeDurableWorkspaceId("abc", "my-feature")).toBe(
      "ws:81a25e53c1b1c56cc708a5fed4958388aeaef6c611b18e01d61c4a21a5e61820",
    );
  });

  it("differs by root-commit and by worktree relpath", () => {
    expect(computeDurableWorkspaceId("a", "")).not.toBe(
      computeDurableWorkspaceId("b", ""),
    );
    expect(computeDurableWorkspaceId("abc", "")).not.toBe(
      computeDurableWorkspaceId("abc", "wt"),
    );
  });
});

describe("normalizeRootCommits", () => {
  it("collapses a mono-root repo to its single SHA", () => {
    expect(normalizeRootCommits(["abc"])).toBe("abc");
    expect(normalizeRootCommits([" abc \n"])).toBe("abc");
  });

  it("sorts ascending, de-dupes and drops blanks, joins with ','", () => {
    expect(normalizeRootCommits(["c", "a", "b", "a", "  "])).toBe("a,b,c");
  });
});

// ---------------------------------------------------------------------------
// detectAvailableHosts (injected which-seam)
// ---------------------------------------------------------------------------

describe("detectAvailableHosts", () => {
  it("returns only the hosts the probe reports present", () => {
    const hosts = detectAvailableHosts((bin) => bin === "claude" || bin === "agy");
    expect([...hosts].sort()).toEqual(["agy", "claude"]);
  });

  it("returns an empty set when nothing is on PATH", () => {
    expect(detectAvailableHosts(() => false).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// h2aReportsLiveConductor (injected h2a runner)
// ---------------------------------------------------------------------------

describe("h2aReportsLiveConductor", () => {
  it("returns undefined when h2a is unavailable (graceful degrade)", () => {
    expect(h2aReportsLiveConductor("ws:sha256:x", () => undefined)).toBeUndefined();
  });

  it("returns true when discover reports an active conductor for the workspace", () => {
    expect(
      h2aReportsLiveConductor(
        "ws:sha256:x",
        () => "ws:sha256:x  role=conductor  connectionConfidence=active",
      ),
    ).toBe(true);
  });

  it("returns false when discover ran but mentions no conductor for it", () => {
    expect(
      h2aReportsLiveConductor("ws:sha256:x", () => "ws:sha256:y conductor active\nidle peer"),
    ).toBe(false);
  });

  it("returns false when conductor exists but connectionConfidence is idle-uncertain (h2a 0.70.0+)", () => {
    expect(
      h2aReportsLiveConductor(
        "ws:sha256:x",
        () => "ws:sha256:x  role=conductor  connectionConfidence=idle-uncertain",
      ),
    ).toBe(false);
  });

  it("returns false when conductor exists but connectionConfidence is unknown", () => {
    expect(
      h2aReportsLiveConductor(
        "ws:sha256:x",
        () => "ws:sha256:x  role=conductor  connectionConfidence=unknown",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inbox read + freshest + processed marking (scratch dir, never /tmp)
// ---------------------------------------------------------------------------

const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "conductor-launch",
);

let scratch: string;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "cl-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const dropEnvelopeFile = (
  dir: string,
  name: string,
  request: unknown,
  mtimeSec?: number,
): string => {
  const inboxDir = join(scratch, "inbox", dir);
  mkdirSync(inboxDir, { recursive: true });
  const path = join(inboxDir, name);
  writeFileSync(path, JSON.stringify(envelope(request)));
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
  return path;
};

describe("readLaunchEnvelopes + freshestLaunchEnvelope", () => {
  it("returns [] for a missing inbox", () => {
    expect(readLaunchEnvelopes(join(scratch, "nope"))).toEqual([]);
  });

  it("reads valid launch envelopes and skips non-launch / malformed files", () => {
    dropEnvelopeFile("remote__cli", "env__1.json", baseRequest());
    // a non-launch envelope (wrong topic) — must be skipped
    const inboxDir = join(scratch, "inbox", "remote__cli");
    writeFileSync(
      join(inboxDir, "env__2.json"),
      JSON.stringify(envelope(baseRequest(), {
        body: { kind: "message", topic: "other", request: baseRequest() },
      })),
    );
    writeFileSync(join(inboxDir, "garbage.json"), "{not json");
    const found = readLaunchEnvelopes(scratch);
    expect(found).toHaveLength(1);
    expect(found[0]!.request.workspaceId).toBe("ws:sha256:abc123");
  });

  it("freshestLaunchEnvelope picks the highest mtime", () => {
    dropEnvelopeFile("remote__cli", "old.json", baseRequest({ reason: "old" }), 1000);
    dropEnvelopeFile("remote__cli", "new.json", baseRequest({ reason: "new" }), 2000);
    const fresh = freshestLaunchEnvelope(readLaunchEnvelopes(scratch));
    expect(fresh?.request.reason).toBe("new");
  });

  it("skips an envelope once a .processed stamp is dropped (idempotent)", () => {
    const path = dropEnvelopeFile("remote__cli", "env.json", baseRequest());
    expect(readLaunchEnvelopes(scratch)).toHaveLength(1);
    expect(markLaunchEnvelopeProcessed(path, "launched")).toBe(true);
    expect(readLaunchEnvelopes(scratch)).toHaveLength(0);
  });
});

describe("recordLaunchAt + readLastLaunchAt", () => {
  it("round-trips a per-workspace last-launch timestamp", () => {
    expect(readLastLaunchAt("ws:sha256:a", scratch)).toBeUndefined();
    expect(recordLaunchAt("ws:sha256:a", 1234, scratch)).toBe(true);
    expect(readLastLaunchAt("ws:sha256:a", scratch)).toBe(1234);
  });

  it("keeps per-workspace entries independent", () => {
    recordLaunchAt("ws:sha256:a", 100, scratch);
    recordLaunchAt("ws:sha256:b", 200, scratch);
    expect(readLastLaunchAt("ws:sha256:a", scratch)).toBe(100);
    expect(readLastLaunchAt("ws:sha256:b", scratch)).toBe(200);
  });

  it("overwrites the same workspace's timestamp on a later launch", () => {
    recordLaunchAt("ws:sha256:a", 100, scratch);
    recordLaunchAt("ws:sha256:a", 999, scratch);
    expect(readLastLaunchAt("ws:sha256:a", scratch)).toBe(999);
  });
});
