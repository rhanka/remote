import { describe, expect, it } from "vitest";

import {
  buildHealthProbeCommand,
  claudeExpiryAdvisory,
  claudeTokenExpiry,
  CLAUDE_EXPIRY_WARN_MS,
  isProbeableTool,
  parseHealthResult,
  PROBEABLE_TOOLS,
  supervisorAdvisory,
  SUPERVISOR_HEARTBEAT_FILE,
  type ProbeableTool,
} from "./cred-health.js";

describe("isProbeableTool / PROBEABLE_TOOLS", () => {
  it("accepts gh/npm/docker and rejects claude/codex/unknown", () => {
    expect(isProbeableTool("gh")).toBe(true);
    expect(isProbeableTool("npm")).toBe(true);
    expect(isProbeableTool("docker")).toBe(true);
    expect(isProbeableTool("claude")).toBe(false);
    expect(isProbeableTool("codex")).toBe(false);
    expect(isProbeableTool("scw")).toBe(false);
  });

  it("PROBEABLE_TOOLS is exactly the cheap-to-probe set", () => {
    expect([...PROBEABLE_TOOLS].sort()).toEqual(["docker", "gh", "npm"]);
  });
});

describe("buildHealthProbeCommand — argv-safe (never bash -lc concat)", () => {
  it("gh → read-only `gh auth status`", () => {
    expect(buildHealthProbeCommand("gh")).toEqual(["gh", "auth", "status"]);
  });

  it("npm → `npm whoami`", () => {
    expect(buildHealthProbeCommand("npm")).toEqual(["npm", "whoami"]);
  });

  it("docker → a static node config-presence check (no untrusted interpolation)", () => {
    const argv = buildHealthProbeCommand("docker");
    expect(argv[0]).toBe("node");
    expect(argv[1]).toBe("-e");
    expect(typeof argv[2]).toBe("string");
    // The script reads the docker config and checks for auths — config presence,
    // not a registry hit.
    expect(argv[2]).toContain(".docker/config.json");
    expect(argv[2]).toContain("auths");
  });

  it("every probe is a pure token array with no shell metacharacters in fixed tokens", () => {
    for (const tool of PROBEABLE_TOOLS) {
      const argv = buildHealthProbeCommand(tool);
      expect(Array.isArray(argv)).toBe(true);
      expect(argv.length).toBeGreaterThan(0);
      // The binary token is never a shell invocation of untrusted data.
      expect(argv[0]).not.toBe("bash");
      expect(argv[0]).not.toBe("sh");
    }
  });
});

describe("parseHealthResult — ok/!ok matrix per tool", () => {
  const tools: ProbeableTool[] = ["gh", "npm", "docker"];

  it("non-zero exit is a fail for every tool", () => {
    for (const tool of tools) {
      const r = parseHealthResult(tool, 1, "");
      expect(r).toMatchObject({ tool, ok: false });
      expect(r.reason).toContain(tool);
      expect(r.reason).toContain("1");
    }
  });

  it("gh/docker exit 0 → ok", () => {
    expect(parseHealthResult("gh", 0, "Logged in to github.com").ok).toBe(true);
    expect(parseHealthResult("docker", 0, "").ok).toBe(true);
  });

  it("npm exit 0 WITH a username → ok", () => {
    expect(parseHealthResult("npm", 0, "alice\n").ok).toBe(true);
  });

  it("npm exit 0 but EMPTY stdout → fail (no user)", () => {
    const r = parseHealthResult("npm", 0, "   \n");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("npm");
  });

  it("reason never echoes raw stdout content (no leak)", () => {
    // A username on stdout must NOT appear verbatim in the reason.
    const r = parseHealthResult("gh", 0, "secret-username-token-xyz");
    expect(r.reason).not.toContain("secret-username-token-xyz");
  });
});

describe("supervisorAdvisory — heartbeat staleness", () => {
  const NOW = 1_000_000_000_000;
  const INTERVAL = 30 * 60_000; // 30 min

  it("missing heartbeat → loud MISSING warning", () => {
    const a = supervisorAdvisory(undefined, INTERVAL, NOW);
    expect(a).toBeDefined();
    expect(a).toContain("MISSING");
    expect(a).toContain("watch");
  });

  it("fresh heartbeat (within 2× interval) → no advisory", () => {
    expect(supervisorAdvisory(NOW - INTERVAL, INTERVAL, NOW)).toBeUndefined();
    // exactly at the 2× boundary is still fresh
    expect(supervisorAdvisory(NOW - 2 * INTERVAL, INTERVAL, NOW)).toBeUndefined();
  });

  it("stale heartbeat (older than 2× interval) → STALE warning with age", () => {
    const a = supervisorAdvisory(NOW - 2 * INTERVAL - 1, INTERVAL, NOW);
    expect(a).toBeDefined();
    expect(a).toContain("STALE");
  });

  it("non-positive interval with a present heartbeat → no advisory (can't compute)", () => {
    expect(supervisorAdvisory(NOW, 0, NOW)).toBeUndefined();
    expect(supervisorAdvisory(NOW, -5, NOW)).toBeUndefined();
  });

  it("heartbeat file constant is stable", () => {
    expect(SUPERVISOR_HEARTBEAT_FILE).toBe("supervisor-heartbeat");
  });
});

describe("claudeTokenExpiry — parse incl. missing/expired/fresh", () => {
  const NOW = 1_700_000_000_000;

  it("fresh token far from expiry → not expiring", () => {
    const e = claudeTokenExpiry(
      { claudeAiOauth: { expiresAt: NOW + 60 * 60_000 } },
      NOW,
    );
    expect(e.expiresAtMs).toBe(NOW + 60 * 60_000);
    expect(e.expired).toBe(false);
    expect(e.expiringSoon).toBe(false);
    expect(e.msUntilExpiry).toBe(60 * 60_000);
  });

  it("within the 15m warn window → expiringSoon, not yet expired", () => {
    const e = claudeTokenExpiry(
      { claudeAiOauth: { expiresAt: NOW + 10 * 60_000 } },
      NOW,
    );
    expect(e.expiringSoon).toBe(true);
    expect(e.expired).toBe(false);
  });

  it("already expired → expired AND expiringSoon", () => {
    const e = claudeTokenExpiry(
      { claudeAiOauth: { expiresAt: NOW - 5 * 60_000 } },
      NOW,
    );
    expect(e.expired).toBe(true);
    expect(e.expiringSoon).toBe(true);
    expect((e.msUntilExpiry ?? 0) < 0).toBe(true);
  });

  it("accepts a raw JSON string", () => {
    const json = JSON.stringify({ claudeAiOauth: { expiresAt: NOW - 1 } });
    expect(claudeTokenExpiry(json, NOW).expired).toBe(true);
  });

  it("missing claudeAiOauth / expiresAt → all undefined, never warns", () => {
    for (const input of [
      {},
      { claudeAiOauth: {} },
      { claudeAiOauth: { expiresAt: "nope" } },
      "not json",
      undefined,
      null,
    ]) {
      const e = claudeTokenExpiry(input, NOW);
      expect(e.expiresAtMs).toBeUndefined();
      expect(e.msUntilExpiry).toBeUndefined();
      expect(e.expiringSoon).toBe(false);
      expect(e.expired).toBe(false);
    }
  });

  it("warn window is the documented 15 min", () => {
    expect(CLAUDE_EXPIRY_WARN_MS).toBe(15 * 60_000);
  });
});

describe("claudeExpiryAdvisory — detection-only message", () => {
  const NOW = 1_700_000_000_000;

  it("fresh token → no advisory", () => {
    const e = claudeTokenExpiry({ claudeAiOauth: { expiresAt: NOW + 60 * 60_000 } }, NOW);
    expect(claudeExpiryAdvisory(e)).toBeUndefined();
  });

  it("expiring soon → minutes-left message, tells user to run claude locally", () => {
    const e = claudeTokenExpiry({ claudeAiOauth: { expiresAt: NOW + 8 * 60_000 } }, NOW);
    const a = claudeExpiryAdvisory(e);
    expect(a).toBeDefined();
    expect(a).toContain("claude");
    expect(a).toContain("8m");
  });

  it("expired → EXPIRED message", () => {
    const e = claudeTokenExpiry({ claudeAiOauth: { expiresAt: NOW - 60_000 } }, NOW);
    const a = claudeExpiryAdvisory(e);
    expect(a).toBeDefined();
    expect(a).toContain("EXPIRED");
  });

  it("never contains a token value (only minutes / phrasing)", () => {
    const e = claudeTokenExpiry({ claudeAiOauth: { expiresAt: NOW + 60_000 } }, NOW);
    const a = claudeExpiryAdvisory(e) ?? "";
    expect(a).not.toMatch(/accessToken|refreshToken/);
  });
});
