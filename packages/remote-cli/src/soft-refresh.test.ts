import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process at the module boundary so NOTHING here ever runs kubectl.
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

// No real FS writes either (the Secret patch goes through a temp --patch-file).
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const collectProfileAuth = vi.fn();
vi.mock("./auth-bundle.js", () => ({ collectProfileAuth }));

vi.mock("./config.js", () => ({
  getTunnel: () => ({
    namespace: "remote",
    service: "svc/remote-control-plane",
    localPort: 8080,
    remotePort: 8080,
  }),
}));

const { softRefreshSession, hashAuthBundle, CREDS_HASH_FILE } = await import(
  "./soft-refresh.js"
);

const BUNDLE = { ".codex/auth.json": "QkFTRTY0LXZhbHVl" } as const;

const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });

/** Dispatch kubectl exec scripts; `podHash` is what the Pod's hash file holds. */
function mockPod(podHash: string): void {
  spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
    const sh = String(args[args.length - 1] ?? "");
    if (sh.startsWith(`cat "$HOME/${CREDS_HASH_FILE}"`)) return ok(podHash);
    if (sh.includes("ls -t")) return ok("conv-123\n");
    if (sh.includes("respawn-pane")) return ok("respawned\n");
    return ok("");
  });
}

function execScripts(): string[] {
  return spawnSyncMock.mock.calls.map((c) =>
    String((c[1] as string[]).at(-1) ?? ""),
  );
}

function fakeStderr(): { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn(() => true) };
}

describe("hashAuthBundle", () => {
  it("is key-order independent and sensitive to profile + values", () => {
    expect(hashAuthBundle("codex", { a: "1", b: "2" })).toBe(
      hashAuthBundle("codex", { b: "2", a: "1" }),
    );
    expect(hashAuthBundle("codex", { a: "1" })).not.toBe(
      hashAuthBundle("claude", { a: "1" }),
    );
    expect(hashAuthBundle("codex", { a: "1" })).not.toBe(
      hashAuthBundle("codex", { a: "2" }),
    );
  });
});

describe("softRefreshSession unchanged-creds gating", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    collectProfileAuth.mockReset();
    collectProfileAuth.mockResolvedValue({ ...BUNDLE });
  });

  it("skipIfUnchanged + matching Pod hash: silent no-op, NO respawn, nothing pushed", async () => {
    const hash = hashAuthBundle("codex", BUNDLE);
    mockPod(hash);
    const stderr = fakeStderr();

    const result = await softRefreshSession("sess-1", "codex", {
      skipIfUnchanged: true,
      stderr: stderr as unknown as NodeJS.WriteStream,
    });

    expect(result.changed).toBe(false);
    expect(result.respawned).toBe(false);
    expect(result.hash).toBe(hash);
    expect(result.filesPushed).toEqual([]);
    expect(result.secretKeysPatched).toEqual([]);
    // only ONE kubectl call: the Pod hash read — no push, no patch, no respawn
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(execScripts().join("\n")).not.toContain("respawn-pane");
    // silent no-op
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("skipIfUnchanged + matching previousHash (watch state): skips without touching the Pod", async () => {
    const hash = hashAuthBundle("codex", BUNDLE);
    mockPod("anything");

    const result = await softRefreshSession("sess-1", "codex", {
      skipIfUnchanged: true,
      previousHash: hash,
      stderr: fakeStderr() as unknown as NodeJS.WriteStream,
    });

    expect(result.changed).toBe(false);
    expect(result.respawned).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("skipIfUnchanged + different hash: pushes, records the hash in the Pod, patches the Secret, respawns", async () => {
    mockPod("stale-hash");
    const stderr = fakeStderr();

    const result = await softRefreshSession("sess-1", "codex", {
      skipIfUnchanged: true,
      stderr: stderr as unknown as NodeJS.WriteStream,
    });

    expect(result.changed).toBe(true);
    expect(result.respawned).toBe(true);
    expect(result.convId).toBe("conv-123");
    expect(result.filesPushed).toEqual([".codex/auth.json"]);
    expect(result.secretKeysPatched).toEqual(["codex_auth.json"]);
    expect(result.hash).toBe(hashAuthBundle("codex", BUNDLE));

    const scripts = execScripts().join("\n");
    expect(scripts).toContain("base64 -d"); // cred file materialized (decode once)
    expect(scripts).toContain(`> "$HOME/${CREDS_HASH_FILE}"`); // hash recorded
    expect(scripts).toContain("respawn-pane");
    // secret material never appears in any command line (stdin only)
    expect(scripts).not.toContain(BUNDLE[".codex/auth.json"]);
  });

  it("without skipIfUnchanged (explicit one-shot): always pushes + respawns, never reads the Pod hash", async () => {
    // Pod already holds the CURRENT hash — a plain `refresh <id> --soft` must
    // still relaunch (the user explicitly asked, e.g. the CLI is logged out).
    mockPod(hashAuthBundle("codex", BUNDLE));

    const result = await softRefreshSession("sess-1", "codex", {
      stderr: fakeStderr() as unknown as NodeJS.WriteStream,
    });

    expect(result.changed).toBe(true);
    expect(result.respawned).toBe(true);
    const scripts = execScripts();
    expect(scripts.some((s) => s.startsWith(`cat "$HOME/${CREDS_HASH_FILE}"`))).toBe(
      false,
    );
    expect(scripts.some((s) => s.includes("respawn-pane"))).toBe(true);
  });
});
