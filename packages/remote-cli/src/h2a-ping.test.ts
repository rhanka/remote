import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildH2aPingEnvelope,
  remoteSessionIdFromInstance,
  sendH2aPing,
} from "./h2a-ping.js";

const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "h2a-ping",
);

let scratch: string;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "p-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("h2a ping", () => {
  it("builds an h2a.ping envelope using the on-disk h2a shape", () => {
    const env = buildH2aPingEnvelope({
      to: "codex:remote:sess-1",
      from: "remote:cli",
      message: "hello",
      cwd: "/work/project",
      nowMs: 1780000000000,
    });

    expect(env).toMatchObject({
      protocol: "sentropic.h2a",
      version: "0.1",
      type: "h2a.ping",
      to: "codex:remote:sess-1",
      actor: { instance: "remote:cli" },
      body: { message: "hello", cwd: "/work/project" },
    });
  });

  it("drops the envelope into the recipient inbox and stays idempotent by file name", () => {
    const first = sendH2aPing({
      to: "codex:remote:sess-1",
      localRoot: scratch,
      nowMs: 1780000000000,
    });
    const second = sendH2aPing({
      to: "codex:remote:sess-1",
      localRoot: scratch,
      nowMs: 1780000000000,
    });

    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(first.path).toContain("codex__remote__sess-1");
    expect(JSON.parse(readFileSync(first.path, "utf8")).type).toBe("h2a.ping");
  });

  it("rejects unsafe instance names before they become paths", () => {
    expect(() => buildH2aPingEnvelope({ to: "../evil" })).toThrow(/unsafe/);
  });

  it("extracts a remote session id from a default remote h2a instance", () => {
    expect(remoteSessionIdFromInstance("claude:remote:sess-1")).toBe("sess-1");
    expect(remoteSessionIdFromInstance("claude:job:j1")).toBeUndefined();
  });
});
