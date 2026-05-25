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
const ensureProfileAuthFresh = vi.fn();
const collectProfileAuth = vi.fn();
const assertRequiredAuthBundle = vi.fn();
const run = vi.fn();

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
}));

vi.mock("./run.js", () => ({
  run,
}));

vi.mock("./smoke.js", () => ({
  smokeRemoteProfile: vi.fn(),
}));

const stderrWrite = vi
  .spyOn(process.stderr, "write")
  .mockImplementation(() => true);

const stdoutWrite = vi
  .spyOn(process.stdout, "write")
  .mockImplementation(() => true);

const { main } = await import("./index.js");

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
    run.mockReset();
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
});
