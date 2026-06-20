import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before any `import` of the module under test.
// ---------------------------------------------------------------------------

const mockCreateRemoteSession = vi.fn();
const mockAttach = vi.fn();
const mockStopRemoteSession = vi.fn();
const mockListRemoteSessions = vi.fn();

vi.mock("./attach.js", () => ({
  createRemoteSession: mockCreateRemoteSession,
  attach: mockAttach,
  stopRemoteSession: mockStopRemoteSession,
  listRemoteSessions: mockListRemoteSessions,
}));

const mockBuildWorkspaceArchive = vi.fn();
const mockUploadWorkspaceArchive = vi.fn();

vi.mock("./workspace-sync.js", () => ({
  buildWorkspaceArchive: mockBuildWorkspaceArchive,
  uploadWorkspaceArchive: mockUploadWorkspaceArchive,
}));

const mockCreateWorkspace = vi.fn();
const mockReadWorkspaceMarker = vi.fn();
const mockWriteWorkspaceMarker = vi.fn();
const mockAcquireWorkspaceLock = vi.fn();
const mockReleaseWorkspaceLock = vi.fn();
const mockReadBaseSnapshot = vi.fn();
const mockWriteBaseSnapshot = vi.fn();
const mockDownloadWorkspaceExport = vi.fn();
const mockReadLineageRecord = vi.fn();
const mockWriteLineageRecord = vi.fn();

vi.mock("./workspace.js", () => ({
  createWorkspace: mockCreateWorkspace,
  readWorkspaceMarker: mockReadWorkspaceMarker,
  writeWorkspaceMarker: mockWriteWorkspaceMarker,
  acquireWorkspaceLock: mockAcquireWorkspaceLock,
  releaseWorkspaceLock: mockReleaseWorkspaceLock,
  readBaseSnapshot: mockReadBaseSnapshot,
  writeBaseSnapshot: mockWriteBaseSnapshot,
  downloadWorkspaceExport: mockDownloadWorkspaceExport,
  readLineageRecord: mockReadLineageRecord,
  writeLineageRecord: mockWriteLineageRecord,
  lockHolderId: () => "test-user@test-host",
}));

const mockMergeWorkspaceArchive = vi.fn();

vi.mock("./workspace-merge.js", () => ({
  mergeWorkspaceArchive: mockMergeWorkspaceArchive,
}));

const mockRestoreSessionsToLocal = vi.fn();

vi.mock("./session-restore.js", () => ({
  restoreSessionsToLocal: mockRestoreSessionsToLocal,
}));

const mockCollectProfileAuth = vi.fn();

vi.mock("./auth-bundle.js", () => ({
  collectProfileAuth: mockCollectProfileAuth,
  assertRequiredAuthBundle: vi.fn(),
}));

const mockAcquireLineageLease = vi.fn();
const mockReleaseLineageLease = vi.fn();

vi.mock("./lineage-client.js", () => ({
  leaseHeaders: (lease?: { lineageId: string; epoch: number }) =>
    lease
      ? { "X-Lineage-Id": lease.lineageId, "X-Lineage-Epoch": String(lease.epoch) }
      : {},
  acquireLineageLease: mockAcquireLineageLease,
  releaseLineageLease: mockReleaseLineageLease,
}));

// Import the module under test after all mocks are wired.
const { migrateForward, migrateBack } = await import("./migrate.js");

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

/** A no-op fake stderr/stdout write stream. */
function stubStream(): NodeJS.WriteStream & { lines: string[] } {
  const lines: string[] = [];
  const stream = {
    lines,
    write(chunk: string | Uint8Array) {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    },
  };
  return stream as unknown as NodeJS.WriteStream & { lines: string[] };
}

/** Build a temp dir that acts as the cwd for test runs (under the package dir). */
function makeTempCwd(label: string): string {
  // Keep under node_modules/../ to stay within the worktree (never /tmp per project rules).
  // We use os.tmpdir() only as a last resort; prefer a subdir of the package.
  const base = join(
    new URL(".", import.meta.url).pathname,
    "..",
    ".test-scratch",
    label,
  );
  mkdirSync(base, { recursive: true });
  return base;
}

const REMOTE_URL = "http://remote.test:8080";
const WORKSPACE_ID = "ws-migrate-test";
const SESSION_ID = "sess-migrate-test";
const PUSH_SESSION_ID = "sess-push-shell";
const PULL_SESSION_ID = "sess-pull-shell";

const ARCHIVE = Buffer.from("fake-tgz");

beforeEach(() => {
  vi.resetAllMocks();

  // Default happy-path stubs.
  mockReadWorkspaceMarker.mockReturnValue({
    remote: REMOTE_URL,
    workspaceId: WORKSPACE_ID,
  });
  mockAcquireWorkspaceLock.mockResolvedValue({ acquired: true });
  mockReleaseWorkspaceLock.mockResolvedValue(undefined);
  mockBuildWorkspaceArchive.mockResolvedValue(ARCHIVE);
  mockUploadWorkspaceArchive.mockResolvedValue(undefined);
  mockWriteBaseSnapshot.mockReturnValue(undefined);
  mockReadBaseSnapshot.mockReturnValue(null);
  mockCreateWorkspace.mockResolvedValue({ id: "ws-new", createdAt: "now" });
  mockWriteWorkspaceMarker.mockReturnValue(undefined);
  // Default: no local creds (forward path omits credentials, matching prior behavior).
  mockCollectProfileAuth.mockResolvedValue({});

  // A0c: lineage lease happy-path defaults (lease acquired successfully).
  mockAcquireLineageLease.mockResolvedValue({
    lineageId: "lin_wsmigrate-test",
    epoch: 0,
    holder: "test-user@test-host",
    incarnationId: "test-user@test-host:1",
    location: "local" as const,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  mockReleaseLineageLease.mockResolvedValue(undefined);

  // Phase A: lineage record defaults (no existing record → new id generated).
  mockReadLineageRecord.mockReturnValue(undefined);
  mockWriteLineageRecord.mockReturnValue(undefined);

  // push shell session
  mockCreateRemoteSession.mockImplementation(
    (
      _url: string,
      body: { workspaceSync?: boolean; workspaceExport?: boolean },
    ) => {
      if (body.workspaceSync) return Promise.resolve({ id: PUSH_SESSION_ID });
      if (body.workspaceExport) return Promise.resolve({ id: PULL_SESSION_ID });
      return Promise.resolve({ id: SESSION_ID });
    },
  );

  mockAttach.mockResolvedValue({
    close: async () => {},
    finished: Promise.resolve(),
  });
  mockStopRemoteSession.mockResolvedValue({ accepted: true });
  mockListRemoteSessions.mockResolvedValue([
    {
      id: SESSION_ID,
      profile: "claude",
      target: "scaleway-kapsule",
      createdAt: "2025-01-01T00:00:00Z",
    },
  ]);

  // pull
  mockDownloadWorkspaceExport.mockResolvedValue(ARCHIVE);
  mockMergeWorkspaceArchive.mockReturnValue({
    tookRemote: ["src/main.ts"],
    keptLocal: [],
    merged: [],
    conflicts: [],
  });
  mockRestoreSessionsToLocal.mockReturnValue({
    restored: [],
    keptLocal: [],
    backedUp: [],
    conflicts: [],
  });
});

// ---------------------------------------------------------------------------
// migrateForward tests
// ---------------------------------------------------------------------------

describe("migrateForward", () => {
  it("calls push → createRemoteSession (with workspaceId) → attach in order", async () => {
    const stderr = stubStream();
    const callOrder: string[] = [];

    mockBuildWorkspaceArchive.mockImplementation(async () => {
      callOrder.push("buildWorkspaceArchive");
      return ARCHIVE;
    });
    // The push session and the real session are distinguished by workspaceSync.
    mockCreateRemoteSession.mockImplementation(
      (
        _url: string,
        body: {
          workspaceSync?: boolean;
          workspaceId?: string;
          profile: string;
        },
      ) => {
        if (body.workspaceSync && body.profile === "shell") {
          callOrder.push("createRemoteSession:push");
          return Promise.resolve({ id: PUSH_SESSION_ID });
        }
        callOrder.push("createRemoteSession:main");
        return Promise.resolve({ id: SESSION_ID });
      },
    );
    mockAttach.mockImplementation(
      (opts: { sessionId: string }) => {
        callOrder.push(`attach:${opts.sessionId}`);
        return Promise.resolve({ close: async () => {}, finished: Promise.resolve() });
      },
    );

    const result = await migrateForward({
      profile: "claude",
      remoteUrl: REMOTE_URL,
      cwd: makeTempCwd("forward-order"),
      stderr,
    });

    expect(callOrder).toContain("buildWorkspaceArchive");
    const pushIdx = callOrder.indexOf("createRemoteSession:push");
    const mainIdx = callOrder.indexOf("createRemoteSession:main");
    // The main session's attach comes AFTER the push session's attach, so find
    // the attach entry that corresponds to the main SESSION_ID.
    const mainAttachIdx = callOrder.indexOf(`attach:${SESSION_ID}`);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(mainIdx).toBeGreaterThan(pushIdx);
    expect(mainAttachIdx).toBeGreaterThan(mainIdx);

    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.sessionId).toBe(SESSION_ID);
  });

  it("passes workspaceId to createRemoteSession for the main session", async () => {
    const stderr = stubStream();
    const capturedBodies: Array<{ profile: string; workspaceId?: string; workspaceSync?: boolean }> = [];

    mockCreateRemoteSession.mockImplementation(
      (_url: string, body: { profile: string; workspaceId?: string; workspaceSync?: boolean }) => {
        capturedBodies.push(body);
        if (body.workspaceSync && body.profile === "shell")
          return Promise.resolve({ id: PUSH_SESSION_ID });
        return Promise.resolve({ id: SESSION_ID });
      },
    );

    await migrateForward({
      profile: "codex",
      remoteUrl: REMOTE_URL,
      cwd: makeTempCwd("forward-wsid"),
      stderr,
    });

    // The non-shell session should carry the workspaceId.
    const mainSession = capturedBodies.find(
      (b) => b.profile === "codex",
    );
    expect(mainSession).toBeDefined();
    expect(mainSession!.workspaceId).toBe(WORKSPACE_ID);
  });

  it("bundles the profile's local credentials into the main session", async () => {
    const stderr = stubStream();
    mockCollectProfileAuth.mockResolvedValue({ "auth.json": "secret-token" });
    const capturedBodies: Array<{
      profile: string;
      workspaceSync?: boolean;
      credentials?: Record<string, string>;
    }> = [];

    mockCreateRemoteSession.mockImplementation(
      (
        _url: string,
        body: {
          profile: string;
          workspaceSync?: boolean;
          credentials?: Record<string, string>;
        },
      ) => {
        capturedBodies.push(body);
        if (body.workspaceSync && body.profile === "shell")
          return Promise.resolve({ id: PUSH_SESSION_ID });
        return Promise.resolve({ id: SESSION_ID });
      },
    );

    await migrateForward({
      profile: "claude",
      remoteUrl: REMOTE_URL,
      cwd: makeTempCwd("forward-creds"),
      stderr,
    });

    expect(mockCollectProfileAuth).toHaveBeenCalledWith("claude");
    const mainSession = capturedBodies.find((b) => b.profile === "claude");
    expect(mainSession?.credentials).toEqual({ "auth.json": "secret-token" });
    // The throwaway push shell session must NOT carry credentials.
    const pushSession = capturedBodies.find((b) => b.profile === "shell");
    expect(pushSession?.credentials).toBeUndefined();
  });

  it("with noAttach: creates the session, does NOT attach, prints the attach command", async () => {
    const stderr = stubStream();
    mockCreateRemoteSession.mockImplementation(
      (_url: string, body: { profile: string; workspaceSync?: boolean }) => {
        if (body.workspaceSync && body.profile === "shell")
          return Promise.resolve({ id: PUSH_SESSION_ID });
        return Promise.resolve({ id: SESSION_ID });
      },
    );

    const result = await migrateForward({
      profile: "claude",
      remoteUrl: REMOTE_URL,
      noAttach: true,
      cwd: makeTempCwd("forward-noattach"),
      stderr,
    });

    expect(result.sessionId).toBe(SESSION_ID);
    // attach is called once for the throwaway PUSH session, but NEVER for the
    // main session when noAttach is set.
    const mainAttach = (mockAttach.mock.calls as Array<[{ sessionId?: string }]>).find(
      (c) => c[0]?.sessionId === SESSION_ID,
    );
    expect(mainAttach).toBeUndefined();
    expect(stderr.lines.join("")).toContain(`remote attach ${REMOTE_URL} ${SESSION_ID}`);
  });

  it("passes --resume args to createRemoteSession when resume is given", async () => {
    const stderr = stubStream();
    const capturedBodies: Array<{ profile: string; startupArgs?: readonly string[] }> = [];

    mockCreateRemoteSession.mockImplementation(
      (_url: string, body: { profile: string; startupArgs?: readonly string[]; workspaceSync?: boolean }) => {
        capturedBodies.push(body);
        if (body.workspaceSync && body.profile === "shell")
          return Promise.resolve({ id: PUSH_SESSION_ID });
        return Promise.resolve({ id: SESSION_ID });
      },
    );

    await migrateForward({
      profile: "claude",
      remoteUrl: REMOTE_URL,
      resume: "conv-abc123",
      cwd: makeTempCwd("forward-resume"),
      stderr,
    });

    const mainSession = capturedBodies.find((b) => b.profile === "claude");
    expect(mainSession).toBeDefined();
    expect(mainSession!.startupArgs).toContain("--resume");
    expect(mainSession!.startupArgs).toContain("conv-abc123");
  });

  it("creates a new workspace when none is linked", async () => {
    mockReadWorkspaceMarker.mockReturnValue(undefined);
    mockCreateWorkspace.mockResolvedValue({ id: "ws-fresh", createdAt: "now" });

    const stderr = stubStream();
    const result = await migrateForward({
      profile: "claude",
      remoteUrl: REMOTE_URL,
      cwd: makeTempCwd("forward-nolink"),
      stderr,
    });

    expect(mockCreateWorkspace).toHaveBeenCalledWith(REMOTE_URL, {}, expect.any(Function));
    expect(mockWriteWorkspaceMarker).toHaveBeenCalled();
    expect(result.workspaceId).toBe("ws-fresh");
  });

  it("resolves URL fallback to config default when --remote omitted (caller responsibility)", async () => {
    // migrateForward requires remoteUrl to be pre-resolved; the Commander layer
    // in index.ts is responsible for calling getConfiguredRemote. This test
    // asserts that the url passed is threaded through to createRemoteSession.
    const stderr = stubStream();
    const capturedUrls: string[] = [];

    mockCreateRemoteSession.mockImplementation(
      (url: string, body: { workspaceSync?: boolean; profile: string }) => {
        capturedUrls.push(url);
        if (body.workspaceSync && body.profile === "shell")
          return Promise.resolve({ id: PUSH_SESSION_ID });
        return Promise.resolve({ id: SESSION_ID });
      },
    );

    await migrateForward({
      profile: "claude",
      remoteUrl: "http://configured-default:9000",
      cwd: makeTempCwd("forward-url"),
      stderr,
    });

    expect(capturedUrls.every((u) => u === "http://configured-default:9000")).toBe(true);
  });

  it("throws for an unknown profile", async () => {
    const stderr = stubStream();
    await expect(
      migrateForward({
        profile: "unknown-profile",
        remoteUrl: REMOTE_URL,
        cwd: makeTempCwd("forward-badprofile"),
        stderr,
      }),
    ).rejects.toThrow(/unknown profile/i);
  });

  it("honours --workspace override even when a marker already exists", async () => {
    const stderr = stubStream();
    const capturedBodies: Array<{ workspaceId?: string; profile: string; workspaceSync?: boolean }> = [];

    mockCreateRemoteSession.mockImplementation(
      (_url: string, body: { workspaceId?: string; profile: string; workspaceSync?: boolean }) => {
        capturedBodies.push(body);
        if (body.workspaceSync && body.profile === "shell")
          return Promise.resolve({ id: PUSH_SESSION_ID });
        return Promise.resolve({ id: SESSION_ID });
      },
    );

    await migrateForward({
      profile: "claude",
      remoteUrl: REMOTE_URL,
      workspaceId: "ws-override",
      cwd: makeTempCwd("forward-wsoverride"),
      stderr,
    });

    const mainSession = capturedBodies.find((b) => b.profile === "claude");
    expect(mainSession!.workspaceId).toBe("ws-override");
  });
});

// ---------------------------------------------------------------------------
// migrateBack tests
// ---------------------------------------------------------------------------

describe("migrateBack", () => {
  it("calls pull → stopRemoteSession in order", async () => {
    const stderr = stubStream();
    const stdout = stubStream();
    const callOrder: string[] = [];

    mockDownloadWorkspaceExport.mockImplementation(async () => {
      callOrder.push("downloadWorkspaceExport");
      return ARCHIVE;
    });
    mockStopRemoteSession.mockImplementation(async (_url: string, id: string) => {
      callOrder.push(`stopRemoteSession:${id}`);
      return { accepted: true };
    });

    await migrateBack({
      remoteUrl: REMOTE_URL,
      cwd: makeTempCwd("back-order"),
      home: makeTempCwd("back-order-home"),
      stderr,
      stdout,
    });

    expect(callOrder).toContain("downloadWorkspaceExport");
    const pullIdx = callOrder.indexOf("downloadWorkspaceExport");
    const stopIdx = callOrder.findIndex((e) => e.startsWith("stopRemoteSession:"));
    expect(stopIdx).toBeGreaterThan(pullIdx);
  });

  it("prints a resume command containing the profile name", async () => {
    const stderr = stubStream();
    const stdout = stubStream();

    // Simulate that claude has restored sessions.
    mockRestoreSessionsToLocal.mockImplementation(
      (args: { profile: string }) => {
        if (args.profile === "claude") {
          return { restored: ["some-conv.json"], keptLocal: [], backedUp: [], conflicts: [] };
        }
        return { restored: [], keptLocal: [], backedUp: [], conflicts: [] };
      },
    );

    const result = await migrateBack({
      remoteUrl: REMOTE_URL,
      cwd: makeTempCwd("back-resume"),
      home: makeTempCwd("back-resume-home"),
      stderr,
      stdout,
    });

    // The resume command is the ACTUAL CLI shape: remote run <profile> [-r id].
    expect(result.resumeCommand).toMatch(/^remote run claude/);

    // The printed output should also contain it.
    const printed = stdout.lines.join("");
    expect(printed).toContain(result.resumeCommand);
  });

  it("URL is threaded through to pull operations", async () => {
    const stderr = stubStream();
    const stdout = stubStream();
    const capturedUrls: string[] = [];

    mockCreateRemoteSession.mockImplementation(
      (url: string, body: { workspaceSync?: boolean; workspaceExport?: boolean }) => {
        capturedUrls.push(url);
        if (body.workspaceExport) return Promise.resolve({ id: PULL_SESSION_ID });
        return Promise.resolve({ id: SESSION_ID });
      },
    );

    await migrateBack({
      remoteUrl: "http://custom-back:7777",
      cwd: makeTempCwd("back-url"),
      home: makeTempCwd("back-url-home"),
      stderr,
      stdout,
    });

    expect(capturedUrls.some((u) => u === "http://custom-back:7777")).toBe(true);
  });

  it("throws when no workspace is linked and no --workspace flag given", async () => {
    mockReadWorkspaceMarker.mockReturnValue(undefined);
    const stderr = stubStream();
    const stdout = stubStream();

    await expect(
      migrateBack({
        remoteUrl: REMOTE_URL,
        cwd: makeTempCwd("back-nolink"),
        home: makeTempCwd("back-nolink-home"),
        stderr,
        stdout,
      }),
    ).rejects.toThrow(/no workspace/i);
  });

  it("reports hasConflicts when merge has conflicts", async () => {
    const stderr = stubStream();
    const stdout = stubStream();

    mockMergeWorkspaceArchive.mockReturnValue({
      tookRemote: [],
      keptLocal: [],
      merged: ["README.md"],
      conflicts: ["README.md"],
    });

    const result = await migrateBack({
      remoteUrl: REMOTE_URL,
      cwd: makeTempCwd("back-conflicts"),
      home: makeTempCwd("back-conflicts-home"),
      stderr,
      stdout,
    });

    expect(result.hasConflicts).toBe(true);
  });

  it("returns the stopped session id", async () => {
    const stderr = stubStream();
    const stdout = stubStream();

    mockListRemoteSessions.mockResolvedValue([
      {
        id: "sess-to-stop",
        profile: "claude",
        target: "scaleway-kapsule",
        createdAt: "2025-06-01T00:00:00Z",
      },
    ]);

    const result = await migrateBack({
      remoteUrl: REMOTE_URL,
      cwd: makeTempCwd("back-stopid"),
      home: makeTempCwd("back-stopid-home"),
      stderr,
      stdout,
    });

    expect(result.stoppedSessionId).toBe("sess-to-stop");
    expect(mockStopRemoteSession).toHaveBeenCalledWith(
      REMOTE_URL,
      "sess-to-stop",
      "migrate-back",
      expect.any(Function),
    );
  });

  it("uses provided sessionId directly without listing sessions (D1 fix)", async () => {
    const stderr = stubStream();
    const stdout = stubStream();

    mockListRemoteSessions.mockResolvedValue([]);

    const result = await migrateBack({
      remoteUrl: REMOTE_URL,
      sessionId: "known-sess-from-lineage",
      cwd: makeTempCwd("back-known-session"),
      home: makeTempCwd("back-known-session-home"),
      stderr,
      stdout,
    });

    // listRemoteSessions must NOT have been called when sessionId is provided
    expect(mockListRemoteSessions).not.toHaveBeenCalled();
    expect(result.stoppedSessionId).toBe("known-sess-from-lineage");
    expect(mockStopRemoteSession).toHaveBeenCalledWith(
      REMOTE_URL,
      "known-sess-from-lineage",
      "migrate-back",
      expect.any(Function),
    );
  });
});
