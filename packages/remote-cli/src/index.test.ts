import { beforeEach, describe, expect, it, vi } from "vitest";

const createRemoteSession = vi.fn();
const attach = vi.fn();
const getRemoteSession = vi.fn();
const listRemoteSessions = vi.fn();
const refreshRemoteSession = vi.fn();
const stopRemoteSession = vi.fn();
const getDefaultRemote = vi.fn();
const setDefaultRemote = vi.fn();
const clearDefaultRemote = vi.fn();
const setToken = vi.fn();
const ensureProfileAuthFresh = vi.fn();
const collectProfileAuth = vi.fn();
const assertRequiredAuthBundle = vi.fn();
const run = vi.fn();
const createWorkspace = vi.fn();
const listWorkspaces = vi.fn();
const deleteWorkspace = vi.fn();
const readWorkspaceMarker = vi.fn();
const writeWorkspaceMarker = vi.fn();

vi.mock("./attach.js", () => ({
  attach,
  createRemoteSession,
  getRemoteSession,
  listRemoteSessions,
  stopRemoteSession,
  refreshRemoteSession,
}));

vi.mock("./auth-refresh.js", () => ({
  AuthRefreshError: class AuthRefreshError extends Error {},
  ensureProfileAuthFresh,
}));

vi.mock("./auth-bundle.js", () => ({
  AuthBundleMissingError: class AuthBundleMissingError extends Error {},
  assertRequiredAuthBundle,
  collectProfileAuth,
}));

vi.mock("./config.js", () => ({
  clearDefaultRemote,
  getDefaultRemote,
  setDefaultRemote,
  setToken,
  getTunnel: () => undefined,
  setTunnel: () => {},
  getDefaultTarget: () => "scaleway-kapsule",
  setDefaultTarget: () => {},
  getDefaultTools: () => [],
  setDefaultTools: () => {},
  getPlugins: () => [],
  setPlugins: () => {},
  DEFAULT_SESSION_TARGET: "scaleway-kapsule",
  authHeaders: () => ({}),
  resolveConfigPath: () => "/tmp/remote-cli-test-config.json",
}));

vi.mock("./run.js", () => ({
  run,
}));

vi.mock("./workspace.js", () => ({
  createWorkspace,
  listWorkspaces,
  deleteWorkspace,
  readWorkspaceMarker,
  writeWorkspaceMarker,
}));

vi.mock("./workspace-sync.js", () => ({
  buildWorkspaceArchive: vi.fn(async () => Buffer.from("tgz")),
  uploadWorkspaceArchive: vi.fn(async () => {}),
}));

vi.mock("./smoke.js", () => ({
  smokeRemoteProfile: vi.fn(),
}));

const softRefreshSession = vi.fn();
vi.mock("./soft-refresh.js", () => ({
  softRefreshSession,
}));

const bridgeSession = vi.fn();
vi.mock("./h2a-bridge.js", () => ({
  bridgeSession,
}));

const stderrWrite = vi
  .spyOn(process.stderr, "write")
  .mockImplementation(() => true);

const stdoutWrite = vi
  .spyOn(process.stdout, "write")
  .mockImplementation(() => true);

const {
  conductLoop,
  main,
  parseWatchMinutes,
  softRefreshAllSessions,
  watchRefreshLoop,
} = await import("./index.js");

describe("main", () => {
  beforeEach(() => {
    createRemoteSession.mockReset();
    attach.mockReset();
    getRemoteSession.mockReset();
    listRemoteSessions.mockReset();
    refreshRemoteSession.mockReset();
    stopRemoteSession.mockReset();
    ensureProfileAuthFresh.mockReset();
    collectProfileAuth.mockReset();
    assertRequiredAuthBundle.mockReset();
    getDefaultRemote.mockReset();
    setDefaultRemote.mockReset();
    clearDefaultRemote.mockReset();
    setToken.mockReset();
    run.mockReset();
    createWorkspace.mockReset();
    listWorkspaces.mockReset();
    deleteWorkspace.mockReset();
    readWorkspaceMarker.mockReset();
    writeWorkspaceMarker.mockReset();
    readWorkspaceMarker.mockReturnValue(undefined);
    createWorkspace.mockResolvedValue({ id: "ws-new", createdAt: "now" });
    listWorkspaces.mockResolvedValue([]);
    deleteWorkspace.mockResolvedValue(true);
    softRefreshSession.mockReset();
    softRefreshSession.mockResolvedValue({
      changed: true,
      hash: "hash-default",
      filesPushed: [".codex/auth.json"],
      secretKeysPatched: ["codex_auth.json"],
      convId: "conv-1",
      respawned: true,
    });
    process.exitCode = undefined;
    stderrWrite.mockClear();
    stdoutWrite.mockClear();

    createRemoteSession.mockResolvedValue({ id: "sess-target" });
    attach.mockResolvedValue({
      close: async () => {},
      finished: Promise.resolve(),
    });
    refreshRemoteSession.mockResolvedValue({
      accepted: true,
      sessionId: "sess-refresh",
    });
    getRemoteSession.mockResolvedValue({
      session: { profile: "codex" },
    });
    stopRemoteSession.mockResolvedValue({
      accepted: true,
      sessionId: "sess-stop",
    });
    ensureProfileAuthFresh.mockResolvedValue({
      checked: true,
      command: "codex login status",
    });
    collectProfileAuth.mockResolvedValue({
      ".codex/auth.json": "BASE64",
    });
    setDefaultRemote.mockImplementation((url: string) => url);
  });

  it("is remote-first: bare profile command uses the configured default remote", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    const exitCode = await main(["node", "remote", "codex"]);

    expect(exitCode).toBe(0);
    expect(createRemoteSession).toHaveBeenCalledWith(
      "http://localhost:8080",
      expect.objectContaining({ profile: "codex" }),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("--remote <url> overrides the configured default", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    const exitCode = await main([
      "node",
      "remote",
      "codex",
      "--remote",
      "http://other:9090",
    ]);

    expect(exitCode).toBe(0);
    expect(createRemoteSession).toHaveBeenCalledWith(
      "http://other:9090",
      expect.objectContaining({ profile: "codex" }),
    );
  });

  it("--local runs the in-process PTY instead of a remote session", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    run.mockResolvedValue({
      sessionId: "sess-local",
      port: 12345,
      exit: Promise.resolve({ exitCode: 0 }),
    });
    const exitCode = await main(["node", "remote", "codex", "--local"]);

    expect(exitCode).toBe(0);
    expect(createRemoteSession).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "codex" }),
    );
  });

  it("errors with guidance when no remote is configured and not --local", async () => {
    getDefaultRemote.mockReturnValue(undefined);
    await expect(main(["node", "remote", "codex"])).rejects.toThrow(
      /No remote URL configured/,
    );
  });

  describe("WP6 — remote fan-out (--count N)", () => {
    it("--count N creates N sessions, each on its OWN workspace (distinct subPath), and never auto-attaches", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      let wsN = 0;
      createWorkspace.mockImplementation(async () => ({
        id: `ws-${++wsN}`,
        createdAt: "now",
      }));
      let sessN = 0;
      createRemoteSession.mockImplementation(async () => ({
        id: `sess-${++sessN}`,
      }));

      const exitCode = await main([
        "node",
        "remote",
        "codex",
        "--remote",
        "http://localhost:8080",
        "--count",
        "3",
        "--name",
        "fleet",
      ]);

      expect(exitCode).toBe(0);
      // One workspace per member → N distinct subPaths on the shared RWX volume.
      expect(createWorkspace).toHaveBeenCalledTimes(3);
      expect(createWorkspace.mock.calls.map((c) => c[1].displayName)).toEqual([
        "fleet-1",
        "fleet-2",
        "fleet-3",
      ]);
      expect(createRemoteSession).toHaveBeenCalledTimes(3);
      // Each session is bound to its own server-assigned workspaceId.
      const wsIds = createRemoteSession.mock.calls.map((c) => c[1].workspaceId);
      expect(new Set(wsIds).size).toBe(3);
      expect(createRemoteSession.mock.calls.map((c) => c[1].displayName)).toEqual([
        "fleet-1",
        "fleet-2",
        "fleet-3",
      ]);
      // A fleet is never auto-attached (no single terminal to take over).
      expect(attach).not.toHaveBeenCalled();
    });

    it("--count 1 is the unchanged single-session path (no workspace fan-out, attaches)", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      const exitCode = await main([
        "node",
        "remote",
        "codex",
        "--remote",
        "http://localhost:8080",
        "--count",
        "1",
      ]);

      expect(exitCode).toBe(0);
      expect(createWorkspace).not.toHaveBeenCalled();
      expect(createRemoteSession).toHaveBeenCalledTimes(1);
      expect(attach).toHaveBeenCalledTimes(1);
    });

    it("--count > 1 is rejected without a remote (it is a REMOTE fan-out)", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      run.mockResolvedValue({
        sessionId: "sess-local",
        port: 1,
        exit: Promise.resolve({ exitCode: 0 }),
      });
      const exitCode = await main([
        "node",
        "remote",
        "codex",
        "--local",
        "--count",
        "2",
      ]);

      expect(exitCode).toBe(1);
      expect(run).not.toHaveBeenCalled();
      const err = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(err).toContain("REMOTE fan-out");
    });

    it("--count > 1 cannot combine with --resume (fresh convs on distinct workspaces)", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      const exitCode = await main([
        "node",
        "remote",
        "codex",
        "--remote",
        "http://localhost:8080",
        "--count",
        "2",
        "--resume",
        "conv-x",
      ]);

      expect(exitCode).toBe(1);
      expect(createRemoteSession).not.toHaveBeenCalled();
      const err = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(err).toContain("--count > 1 cannot combine with -r/--resume");
    });

    it("--count > 1 cannot combine with --sync", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      const exitCode = await main([
        "node",
        "remote",
        "codex",
        "--remote",
        "http://localhost:8080",
        "--count",
        "2",
        "--sync",
      ]);

      expect(exitCode).toBe(1);
      expect(createRemoteSession).not.toHaveBeenCalled();
      const err = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(err).toContain("--count > 1 cannot combine with --sync");
    });

    it("a single failed member sets exit 1 but still creates the rest", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      let wsN = 0;
      createWorkspace.mockImplementation(async () => ({
        id: `ws-${++wsN}`,
        createdAt: "now",
      }));
      let sessN = 0;
      createRemoteSession.mockImplementation(async () => {
        sessN += 1;
        if (sessN === 2) throw new Error("control-plane 503");
        return { id: `sess-${sessN}` };
      });

      const exitCode = await main([
        "node",
        "remote",
        "codex",
        "--remote",
        "http://localhost:8080",
        "--count",
        "3",
        "--name",
        "fleet",
      ]);

      expect(exitCode).toBe(1);
      expect(createRemoteSession).toHaveBeenCalledTimes(3);
      const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("FAILED");
    });
  });

  it("accepts --target on remote profile commands and forwards it to session creation", async () => {
    const exitCode = await main([
      "node",
      "remote",
      "codex",
      "--remote",
      "http://localhost:8080",
      "--target",
      "scaleway-kapsule",
    ]);

    expect(exitCode).toBe(0);
    expect(createRemoteSession).toHaveBeenCalledWith(
      "http://localhost:8080",
      expect.objectContaining({
        profile: "codex",
        target: "scaleway-kapsule",
      }),
    );
  });

  it("forwards wrapped profile args when running remote", async () => {
    const exitCode = await main([
      "node",
      "remote",
      "codex",
      "--remote",
      "http://localhost:8080",
      "config",
      "install",
    ]);

    expect(exitCode).toBe(0);
    expect(createRemoteSession).toHaveBeenCalledWith(
      "http://localhost:8080",
      expect.objectContaining({
        profile: "codex",
        startupArgs: ["config", "install"],
      }),
    );
  });

  it("refreshes remote credentials for an explicit profile", async () => {
    const exitCode = await main([
      "node",
      "remote",
      "refresh",
      "http://localhost:8080",
      "sess-refresh",
      "--profile",
      "codex",
    ]);

    expect(exitCode).toBe(0);
    expect(ensureProfileAuthFresh).toHaveBeenCalledWith("codex");
    expect(collectProfileAuth).toHaveBeenCalledWith("codex");
    expect(refreshRemoteSession).toHaveBeenCalledWith(
      "http://localhost:8080",
      "sess-refresh",
      { ".codex/auth.json": "BASE64" },
    );
  });

  it("derives profile from remote session when --profile is omitted", async () => {
    getRemoteSession.mockResolvedValue({
      session: { profile: "claude" },
    });
    const exitCode = await main([
      "node",
      "remote",
      "refresh",
      "http://localhost:8080",
      "sess-refresh",
    ]);

    expect(exitCode).toBe(0);
    expect(getRemoteSession).toHaveBeenCalledWith(
      "http://localhost:8080",
      "sess-refresh",
    );
    expect(refreshRemoteSession).toHaveBeenCalledWith(
      "http://localhost:8080",
      "sess-refresh",
      { ".codex/auth.json": "BASE64" },
    );
  });

  it("stores default remote from config set", async () => {
    setDefaultRemote.mockReturnValue("http://localhost:8080");
    const exitCode = await main([
      "node",
      "remote",
      "config",
      "set",
      "http://localhost:8080",
    ]);

    expect(exitCode).toBe(0);
    expect(setDefaultRemote).toHaveBeenCalledWith("http://localhost:8080");
  });

  it("stores a bearer token from config token", async () => {
    const exitCode = await main([
      "node",
      "remote",
      "config",
      "token",
      "tok-123",
    ]);

    expect(exitCode).toBe(0);
    expect(setToken).toHaveBeenCalledWith("tok-123");
  });

  it("aliases remote install to set default remote", async () => {
    setDefaultRemote.mockReturnValue("http://localhost:8080");
    const exitCode = await main([
      "node",
      "remote",
      "install",
      "http://localhost:8080",
    ]);

    expect(exitCode).toBe(0);
    expect(setDefaultRemote).toHaveBeenCalledWith("http://localhost:8080");
  });

  it("shows default remote when configured", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    const exitCode = await main(["node", "remote", "config", "show"]);

    expect(exitCode).toBe(0);
    expect(stdoutWrite).toHaveBeenCalledWith("http://localhost:8080\n");
  });

  it("clears default remote", async () => {
    const exitCode = await main(["node", "remote", "config", "clear"]);

    expect(exitCode).toBe(0);
    expect(clearDefaultRemote).toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalledWith("[remote] cleared default remote\n");
  });

  it("uses configured default remote for refresh when URL is omitted", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    const exitCode = await main(["node", "remote", "refresh", "sess-refresh"]);

    expect(exitCode).toBe(0);
    expect(refreshRemoteSession).toHaveBeenCalledWith(
      "http://localhost:8080",
      "sess-refresh",
      { ".codex/auth.json": "BASE64" },
    );
  });

  it("uses configured default remote for attach when URL is omitted", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    const exitCode = await main(["node", "remote", "attach", "sess-attach"]);

    expect(exitCode).toBe(0);
    expect(attach).toHaveBeenCalledWith({
      baseUrl: "http://localhost:8080",
      sessionId: "sess-attach",
    });
  });

  it("auth status --all reports every profile", async () => {
    const exitCode = await main(["node", "remote", "auth", "status", "--all"]);

    expect(exitCode).toBe(0);
    const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("profile: codex");
    expect(out).toContain("profile: claude");
    expect(out).toContain("profile: agy");
  });

  it("auth login on a profile without a scripted login prints guidance", async () => {
    const exitCode = await main(["node", "remote", "auth", "login", "agy"]);

    expect(exitCode).toBe(0);
    const err = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(err).toContain("no scripted login");
  });

  it("auth push --all merges every local profile's creds into one refresh", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    const exitCode = await main([
      "node",
      "remote",
      "auth",
      "push",
      "sess-push",
      "--all",
    ]);

    expect(exitCode).toBe(0);
    expect(refreshRemoteSession).toHaveBeenCalledWith(
      "http://localhost:8080",
      "sess-push",
      { ".codex/auth.json": "BASE64" },
    );
  });

  it("workspace link creates a workspace and writes the marker", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    const exitCode = await main(["node", "remote", "workspace", "link"]);

    expect(exitCode).toBe(0);
    expect(createWorkspace).toHaveBeenCalledWith("http://localhost:8080", {});
    expect(writeWorkspaceMarker).toHaveBeenCalledWith(expect.any(String), {
      remote: "http://localhost:8080",
      workspaceId: "ws-new",
    });
  });

  it("workspace link is idempotent when already mapped", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    readWorkspaceMarker.mockReturnValue({
      remote: "http://localhost:8080",
      workspaceId: "ws-existing",
    });
    const exitCode = await main(["node", "remote", "workspace", "link"]);

    expect(exitCode).toBe(0);
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("workspace list calls the API and prints rows", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    listWorkspaces.mockResolvedValue([
      { id: "ws-1", createdAt: "t1", displayName: "proj" },
    ]);
    const exitCode = await main(["node", "remote", "workspace", "list"]);

    expect(exitCode).toBe(0);
    expect(listWorkspaces).toHaveBeenCalledWith("http://localhost:8080");
    const out = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("ws-1");
  });

  it("auto-binds a profile session to the mapped workspace", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    readWorkspaceMarker.mockReturnValue({
      remote: "http://localhost:8080",
      workspaceId: "ws-mapped",
    });
    const exitCode = await main(["node", "remote", "codex"]);

    expect(exitCode).toBe(0);
    expect(createRemoteSession).toHaveBeenCalledWith(
      "http://localhost:8080",
      expect.objectContaining({ profile: "codex", workspaceId: "ws-mapped" }),
    );
  });

  it("--no-workspace ignores the mapping", async () => {
    getDefaultRemote.mockReturnValue("http://localhost:8080");
    readWorkspaceMarker.mockReturnValue({
      remote: "http://localhost:8080",
      workspaceId: "ws-mapped",
    });
    const exitCode = await main(["node", "remote", "codex", "--no-workspace"]);

    expect(exitCode).toBe(0);
    expect(createRemoteSession).toHaveBeenCalledWith(
      "http://localhost:8080",
      expect.not.objectContaining({ workspaceId: expect.anything() }),
    );
  });

  describe("refresh --soft --all", () => {
    const sessions = [
      { id: "s1", profile: "codex", target: "k3s", createdAt: "now" },
      { id: "s2", profile: "claude", target: "k3s", createdAt: "now" },
      { id: "s3", profile: "codex", target: "k3s", createdAt: "now" },
    ];

    it("soft-refreshes every live session (gated) and recaps ok/unchanged", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      listRemoteSessions.mockResolvedValue(sessions.slice(0, 2));
      softRefreshSession
        .mockResolvedValueOnce({
          changed: true,
          hash: "h1",
          filesPushed: [],
          secretKeysPatched: [],
          convId: "c1",
          respawned: true,
        })
        .mockResolvedValueOnce({
          changed: false,
          hash: "h2",
          filesPushed: [],
          secretKeysPatched: [],
          convId: undefined,
          respawned: false,
        });

      const exitCode = await main(["node", "remote", "refresh", "--soft", "--all"]);

      expect(exitCode).toBe(0);
      expect(listRemoteSessions).toHaveBeenCalledWith("http://localhost:8080");
      expect(softRefreshSession).toHaveBeenCalledTimes(2);
      expect(softRefreshSession).toHaveBeenNthCalledWith(1, "s1", "codex", {
        skipIfUnchanged: true,
      });
      expect(softRefreshSession).toHaveBeenNthCalledWith(2, "s2", "claude", {
        skipIfUnchanged: true,
      });
      const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("s1 (codex) ok");
      expect(out).toContain("s2 (claude) unchanged");
    });

    it("continues past per-session failures and exits 1 when any failed", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      listRemoteSessions.mockResolvedValue(sessions);
      softRefreshSession.mockImplementation(async (sessionId: string) => {
        if (sessionId === "s2") throw new Error("pod gone");
        return {
          changed: true,
          hash: `h-${sessionId}`,
          filesPushed: [],
          secretKeysPatched: [],
          convId: undefined,
          respawned: true,
        };
      });

      const exitCode = await main(["node", "remote", "refresh", "--soft", "--all"]);

      expect(exitCode).toBe(1);
      expect(softRefreshSession).toHaveBeenCalledTimes(3); // s2 failure didn't stop s3
      const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("s2 (claude) failed — pod gone");
      expect(out).toContain("s3 (codex) ok");
      expect(out).toContain("1 failed");
    });

    it("--all rejects an explicit session id", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      await expect(
        main(["node", "remote", "refresh", "sess-1", "--all"]),
      ).rejects.toThrow(/--all refreshes every live session/);
      expect(softRefreshSession).not.toHaveBeenCalled();
    });

    it("feeds the previous pass hash back into the next pass (watch state)", async () => {
      listRemoteSessions.mockResolvedValue(sessions.slice(0, 1));
      softRefreshSession.mockResolvedValue({
        changed: true,
        hash: "h1",
        filesPushed: [],
        secretKeysPatched: [],
        convId: undefined,
        respawned: true,
      });
      const hashes = new Map<string, string>();

      await softRefreshAllSessions("http://localhost:8080", {}, hashes);
      expect(softRefreshSession).toHaveBeenLastCalledWith("s1", "codex", {
        skipIfUnchanged: true,
      });

      await softRefreshAllSessions("http://localhost:8080", {}, hashes);
      expect(softRefreshSession).toHaveBeenLastCalledWith("s1", "codex", {
        skipIfUnchanged: true,
        previousHash: "h1",
      });
    });
  });

  describe("refresh --watch", () => {
    it("parseWatchMinutes accepts whole minutes >= 1 and rejects the rest", () => {
      expect(parseWatchMinutes("1")).toBe(1);
      expect(parseWatchMinutes("30")).toBe(30);
      for (const bad of ["0", "-5", "1.5", "abc", ""]) {
        expect(() => parseWatchMinutes(bad)).toThrow(/whole number of minutes/);
      }
    });

    it("rejects an invalid --watch value before touching the control-plane", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      await expect(
        main(["node", "remote", "refresh", "--all", "--watch", "0"]),
      ).rejects.toThrow(/--watch needs a whole number of minutes >= 1/);
      expect(listRemoteSessions).not.toHaveBeenCalled();
      expect(softRefreshSession).not.toHaveBeenCalled();
    });

    it("watchRefreshLoop runs passes on the interval and stops cleanly on SIGINT (exit 0)", async () => {
      vi.useFakeTimers();
      try {
        const { EventEmitter } = await import("node:events");
        const signals = new EventEmitter();
        const pass = vi
          .fn<() => Promise<{ failed: number }>>()
          .mockImplementationOnce(async () => ({ failed: 0 }))
          .mockImplementationOnce(async () => {
            signals.emit("SIGINT"); // Ctrl-C during the second pass
            return { failed: 1 }; // pass failures never kill the loop
          });

        const loop = watchRefreshLoop(5, pass, signals);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        const code = await loop;

        expect(code).toBe(0);
        expect(pass).toHaveBeenCalledTimes(2);
        expect(signals.listenerCount("SIGINT")).toBe(0); // handler removed
        const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toMatch(/refresh pass — \d{4}-\d{2}-\d{2}T/); // timestamped
        expect(out).toContain("watch stopped (SIGINT)");
      } finally {
        vi.useRealTimers();
      }
    });

    it("conductLoop runs conductor passes on the interval and stops cleanly on SIGINT (exit 0)", async () => {
      vi.useFakeTimers();
      try {
        const { EventEmitter } = await import("node:events");
        const signals = new EventEmitter();
        const pass = vi
          .fn<() => Promise<{ started: number; finished: number }>>()
          .mockImplementationOnce(async () => ({ started: 2, finished: 0 }))
          .mockImplementationOnce(async () => {
            signals.emit("SIGINT"); // Ctrl-C during the second pass
            return { started: 1, finished: 1 };
          });

        const loop = conductLoop(5, pass, signals);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        const code = await loop;

        expect(code).toBe(0);
        expect(pass).toHaveBeenCalledTimes(2);
        expect(signals.listenerCount("SIGINT")).toBe(0); // handler removed
        const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toMatch(/conduct pass — \d{4}-\d{2}-\d{2}T/); // timestamped
        expect(out).toContain("2 started, 0 finished"); // pass recap
        expect(out).toContain("conduct stopped (SIGINT)");
      } finally {
        vi.useRealTimers();
      }
    });

    it("conductLoop keeps going when a pass throws (logs, no crash)", async () => {
      vi.useFakeTimers();
      try {
        const { EventEmitter } = await import("node:events");
        const signals = new EventEmitter();
        const pass = vi
          .fn<() => Promise<{ started: number; finished: number }>>()
          .mockImplementationOnce(async () => {
            throw new Error("cluster unreachable");
          })
          .mockImplementationOnce(async () => {
            signals.emit("SIGINT");
            return { started: 0, finished: 0 };
          });

        const loop = conductLoop(2, pass, signals);
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        const code = await loop;

        expect(code).toBe(0);
        expect(pass).toHaveBeenCalledTimes(2);
        const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("conduct pass failed: cluster unreachable");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("h2a bridge", () => {
    const bridged = (over: Partial<Record<string, unknown>> = {}) => ({
      sessionId: "sess-1",
      pulled: 0,
      pushed: 0,
      skipped: 0,
      failed: 0,
      scaffolded: false,
      podInstanceDirs: ["claude__remote__sess-1"],
      ...over,
    });

    beforeEach(() => {
      bridgeSession.mockReset();
      bridgeSession.mockResolvedValue(bridged());
    });

    it("with a sessionId bridges that session with its control-plane profile", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      getRemoteSession.mockResolvedValue({ session: { profile: "claude" } });
      bridgeSession.mockResolvedValue(
        bridged({ pulled: 2, pushed: 1, skipped: 3 }),
      );

      const exitCode = await main(["node", "remote", "h2a", "bridge", "sess-1"]);

      expect(exitCode).toBe(0);
      expect(bridgeSession).toHaveBeenCalledTimes(1);
      expect(bridgeSession).toHaveBeenCalledWith("sess-1", { profile: "claude" });
      expect(listRemoteSessions).not.toHaveBeenCalled();
      const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("pulled=2 pushed=1 skipped=3");
    });

    it("without a sessionId bridges EVERY live session; one failure = exit 1 but the pass continues", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      listRemoteSessions.mockResolvedValue([
        { id: "sess-a", profile: "claude" },
        { id: "sess-b", profile: "codex" },
      ]);
      bridgeSession
        .mockRejectedValueOnce(new Error("pod gone"))
        .mockResolvedValueOnce(bridged({ sessionId: "sess-b", pushed: 1 }));

      const exitCode = await main(["node", "remote", "h2a", "bridge"]);

      expect(exitCode).toBe(1);
      expect(bridgeSession).toHaveBeenCalledTimes(2);
      expect(bridgeSession).toHaveBeenNthCalledWith(1, "sess-a", {
        profile: "claude",
      });
      expect(bridgeSession).toHaveBeenNthCalledWith(2, "sess-b", {
        profile: "codex",
      });
      const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("h2a bridge sess-a failed: pod gone");
      expect(out).toContain("h2a bridge sess-b (codex) pulled=0 pushed=1");
    });

    it("no live sessions = clean no-op (exit 0)", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      listRemoteSessions.mockResolvedValue([]);

      const exitCode = await main(["node", "remote", "h2a", "bridge"]);

      expect(exitCode).toBe(0);
      expect(bridgeSession).not.toHaveBeenCalled();
      const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("no live remote sessions to bridge");
    });

    it("rejects an invalid --watch value before touching anything", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      await expect(
        main(["node", "remote", "h2a", "bridge", "--watch", "0.5"]),
      ).rejects.toThrow(/--watch needs a whole number of minutes >= 1/);
      expect(listRemoteSessions).not.toHaveBeenCalled();
      expect(bridgeSession).not.toHaveBeenCalled();
    });

    it("per-file failures inside an otherwise-ok bridge set exit 1", async () => {
      getDefaultRemote.mockReturnValue("http://localhost:8080");
      getRemoteSession.mockResolvedValue({ session: { profile: "codex" } });
      bridgeSession.mockResolvedValue(bridged({ pulled: 1, failed: 2 }));

      const exitCode = await main(["node", "remote", "h2a", "bridge", "sess-1"]);

      expect(exitCode).toBe(1);
      const out = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("failed=2");
    });
  });
});
