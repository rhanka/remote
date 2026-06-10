import { describe, expect, it } from "vitest";

import {
  buildPodUntarArgs,
  buildSkillsSyncPlan,
  buildSkillsTarArgs,
  selectSyncPods,
  SKILLS_SYNC_WHITELIST,
  skillsSyncWhitelist,
} from "./skills-sync.js";

describe("skillsSyncWhitelist", () => {
  it("is exactly the 4 documented paths, relative to $HOME", () => {
    expect(skillsSyncWhitelist()).toEqual([
      ".claude/skills",
      ".claude/plugins/installed_plugins.json",
      ".claude/plugins/marketplaces",
      ".claude/plugins/cache",
    ]);
  });

  it("the constant and the accessor agree", () => {
    expect(skillsSyncWhitelist()).toEqual([...SKILLS_SYNC_WHITELIST]);
  });

  it("returns a fresh array (caller cannot mutate the source of truth)", () => {
    const a = skillsSyncWhitelist();
    a.push("../../.ssh/id_rsa");
    expect(skillsSyncWhitelist()).not.toContain("../../.ssh/id_rsa");
  });
});

describe("SAFETY — whitelist never leaks auth/secrets", () => {
  // The whole point of WP1: copy skills+plugins, NEVER auth. These are the
  // ~/.claude paths that hold credentials/tokens/transcripts and MUST be absent.
  const FORBIDDEN = [
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/.credentials.json",
    ".claude/projects",
    ".claude.json",
    ".claude/plugins/blocklist.json",
    ".claude/plugins/known_marketplaces.json",
    ".claude/plugins/plugin-catalog-cache.json",
    ".claude/plugins/data",
  ];

  it("no whitelist entry is, or contains, a secret/credential/transcript path", () => {
    for (const entry of skillsSyncWhitelist()) {
      for (const secret of FORBIDDEN) {
        expect(entry).not.toBe(secret);
        // A whitelist of "directories" must not be a PREFIX of a secret path
        // (e.g. whitelisting ".claude" would sweep settings.json with it).
        expect(secret.startsWith(`${entry}/`)).toBe(false);
      }
    }
  });

  it("the tar argv references ONLY whitelisted paths — no secret path appears", () => {
    const args = buildSkillsTarArgs("/home/me");
    const joined = args.join(" ");
    for (const secret of FORBIDDEN) {
      expect(joined).not.toContain(secret);
    }
    // It also never tars the bare ~/.claude dir (which would carry everything).
    expect(args).not.toContain(".claude");
  });

  it("never tars the whole .claude tree (each member is a leaf whitelist path)", () => {
    const args = buildSkillsTarArgs("/home/me");
    const members = args.slice(args.indexOf("--") + 1);
    expect(members).toEqual([...skillsSyncWhitelist()]);
  });
});

describe("buildSkillsTarArgs", () => {
  it("creates a gzip stream to stdout, -C $HOME, only whitelisted members", () => {
    const args = buildSkillsTarArgs("/home/me");
    expect(args[0]).toBe("-c");
    expect(args).toContain("-z");
    // -C <home> so members are relative and untar cleanly into the Pod $HOME.
    const cIdx = args.indexOf("-C");
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBe("/home/me");
    // -f - : write the archive to stdout (piped into kubectl exec -i).
    const fIdx = args.indexOf("-f");
    expect(args[fIdx + 1]).toBe("-");
    // Members are passed after `--` so a stray leading-dash path can't be a flag.
    const dd = args.indexOf("--");
    expect(dd).toBeGreaterThanOrEqual(0);
    expect(args.slice(dd + 1)).toEqual([...skillsSyncWhitelist()]);
  });

  it("ignores missing members so a partial local install still syncs", () => {
    // tar must not abort if e.g. plugins/cache does not exist locally yet.
    expect(buildSkillsTarArgs("/home/me")).toContain("--ignore-failed-read");
  });

  it("never interpolates HOME into a shell string (argv only)", () => {
    // A home with shell metacharacters is just an argv element, never a word.
    const args = buildSkillsTarArgs("/home/a b;rm -rf/");
    expect(args).toContain("/home/a b;rm -rf/");
  });
});

describe("buildPodUntarArgs", () => {
  it("extracts gzip from stdin into the Pod $HOME, overwriting", () => {
    const args = buildPodUntarArgs("/root");
    expect(args[0]).toBe("-x");
    expect(args).toContain("-z");
    expect(args).toContain("--overwrite");
    const cIdx = args.indexOf("-C");
    expect(args[cIdx + 1]).toBe("/root");
    const fIdx = args.indexOf("-f");
    expect(args[fIdx + 1]).toBe("-"); // read archive from stdin
  });

  it("does not name any member (extracts whatever the archive carries)", () => {
    // Members are constrained on the TAR side (whitelist); untar just extracts.
    const args = buildPodUntarArgs("/root");
    expect(args).not.toContain("--");
  });
});

describe("buildSkillsSyncPlan", () => {
  const POD = { sessionId: "abc123", profile: "claude", podHome: "/root" };

  it("composes a local-tar | pod-untar plan with both argv arrays", () => {
    const plan = buildSkillsSyncPlan({ home: "/home/me", pod: POD });
    expect(plan.pod).toBe("session-abc123");
    expect(plan.tar.cmd).toBe("tar");
    expect(plan.tar.args).toEqual(buildSkillsTarArgs("/home/me"));
    expect(plan.untar.cmd).toBe("tar");
    expect(plan.untar.args).toEqual(buildPodUntarArgs("/root"));
    expect(plan.whitelist).toEqual([...skillsSyncWhitelist()]);
  });

  it("defaults the Pod $HOME to /root when none is given", () => {
    const plan = buildSkillsSyncPlan({
      home: "/home/me",
      pod: { sessionId: "x", profile: "claude" },
    });
    expect(plan.untar.args).toEqual(buildPodUntarArgs("/root"));
  });

  it("renders a human dry-run line that names the whitelist and the pod", () => {
    const plan = buildSkillsSyncPlan({ home: "/home/me", pod: POD });
    expect(plan.dryRun).toContain("session-abc123");
    expect(plan.dryRun).toContain(".claude/skills");
    expect(plan.dryRun).toContain("tar -c");
  });

  it("the dry-run plan reveals no secret path", () => {
    const plan = buildSkillsSyncPlan({ home: "/home/me", pod: POD });
    expect(plan.dryRun).not.toContain("credentials");
    expect(plan.dryRun).not.toContain("settings.json");
    expect(plan.dryRun).not.toContain(".claude.json");
  });
});

describe("selectSyncPods", () => {
  const SESSIONS = [
    { id: "a", profile: "claude" },
    { id: "b", profile: "codex" },
    { id: "c", profile: "claude" },
  ];

  it("--all selects every session", () => {
    expect(selectSyncPods(SESSIONS, { all: true }).map((p) => p.sessionId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("--pod selects exactly that session by id", () => {
    const got = selectSyncPods(SESSIONS, { pod: "b" });
    expect(got.map((p) => p.sessionId)).toEqual(["b"]);
    expect(got[0]!.profile).toBe("codex");
  });

  it("--pod accepts the session-<id> Pod name form too", () => {
    expect(selectSyncPods(SESSIONS, { pod: "session-c" }).map((p) => p.sessionId)).toEqual([
      "c",
    ]);
  });

  it("throws when --pod matches no live session", () => {
    expect(() => selectSyncPods(SESSIONS, { pod: "nope" })).toThrow(/no live session/);
  });

  it("throws when neither --pod nor --all is given", () => {
    expect(() => selectSyncPods(SESSIONS, {})).toThrow(/--pod|--all/);
  });
});
