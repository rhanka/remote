import { describe, expect, it } from "vitest";

import {
  AuthBundleMissingError,
  assertRequiredAuthBundle,
  collectProfileAuth,
} from "./auth-bundle.js";

const codexAuthJson = JSON.stringify({ tokens: { access_token: "abc" } });
const claudeCredsJson = JSON.stringify({
  claudeAiOauth: { accessToken: "xyz" },
});

describe("collectProfileAuth", () => {
  it("encodes known files for the codex profile and skips missing ones", async () => {
    const files: Record<string, string> = {
      ".codex/auth.json": codexAuthJson,
    };
    const bundle = await collectProfileAuth("codex", {
      home: "/home/test",
      async readFileImpl(path) {
        const key = path.replace("/home/test/", "");
        if (!(key in files)) throw new Error("ENOENT");
        return Buffer.from(files[key]!, "utf8");
      },
    });
    expect(Object.keys(bundle)).toEqual([".codex/auth.json"]);
    expect(Buffer.from(bundle[".codex/auth.json"]!, "base64").toString()).toBe(
      codexAuthJson,
    );
  });

  it("bundles claude credentials when present", async () => {
    const bundle = await collectProfileAuth("claude", {
      home: "/home/test",
      async readFileImpl(path) {
        if (path.endsWith(".credentials.json"))
          return Buffer.from(claudeCredsJson, "utf8");
        throw new Error("ENOENT");
      },
    });
    expect(bundle).toEqual({
      ".claude/.credentials.json": Buffer.from(
        claudeCredsJson,
        "utf8",
      ).toString("base64"),
    });
  });

  it("returns an empty bundle when no files exist", async () => {
    const bundle = await collectProfileAuth("agy", {
      home: "/home/test",
      async readFileImpl() {
        throw new Error("ENOENT");
      },
    });
    expect(bundle).toEqual({});
  });

  it("returns an empty bundle for shell profile (no auth needed)", async () => {
    const bundle = await collectProfileAuth("shell", {
      home: "/home/test",
      async readFileImpl() {
        throw new Error("should not be called");
      },
    });
    expect(bundle).toEqual({});
  });
});

describe("assertRequiredAuthBundle", () => {
  it("throws an actionable error when codex has no bundled auth files", () => {
    expect(() => assertRequiredAuthBundle("codex", {})).toThrow(
      AuthBundleMissingError,
    );
    expect(() => assertRequiredAuthBundle("codex", {})).toThrow(
      "No local auth files found for codex",
    );
  });

  it("accepts claude when at least one known credential file was bundled", () => {
    expect(() =>
      assertRequiredAuthBundle("claude", {
        ".claude/.credentials.json": "base64",
      }),
    ).not.toThrow();
  });

  it("does not require auth files for shell or agy", () => {
    expect(() => assertRequiredAuthBundle("shell", {})).not.toThrow();
    expect(() => assertRequiredAuthBundle("agy", {})).not.toThrow();
  });
});
