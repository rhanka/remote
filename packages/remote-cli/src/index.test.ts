import { beforeEach, describe, expect, it, vi } from "vitest";

const createRemoteSession = vi.fn();
const attach = vi.fn();
const ensureProfileAuthFresh = vi.fn();
const collectProfileAuth = vi.fn();
const assertRequiredAuthBundle = vi.fn();
const run = vi.fn();

vi.mock("./attach.js", () => ({
  attach,
  createRemoteSession,
  listRemoteSessions: vi.fn(),
  stopRemoteSession: vi.fn(),
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
    ensureProfileAuthFresh.mockReset();
    collectProfileAuth.mockReset();
    assertRequiredAuthBundle.mockReset();
    run.mockReset();
    stderrWrite.mockClear();
    stdoutWrite.mockClear();

    createRemoteSession.mockResolvedValue({ id: "sess-target" });
    attach.mockResolvedValue({
      close: async () => {},
      finished: Promise.resolve(),
    });
    ensureProfileAuthFresh.mockResolvedValue({
      checked: true,
      command: "codex login status",
    });
    collectProfileAuth.mockResolvedValue({
      ".codex/auth.json": "BASE64",
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
});
