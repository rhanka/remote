import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverSessions,
  groupSessions,
  mergeDiscovered,
  readLastLayout,
  registrySessions,
  tabCommand,
  writeLastLayout,
  type DiscoveredSession,
} from "./restore.js";
import type { RegistryEntry } from "./registry.js";
import { DEFAULT_LAYOUT } from "./config.js";

// Scratch dir inside the package (never /tmp). It plays the role of $HOME.
const SCRATCH_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-scratch",
  "restore",
);

let home: string;
let prevConfigHome: string | undefined;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  home = mkdtempSync(join(SCRATCH_ROOT, "h-"));
  prevConfigHome = process.env.REMOTE_CLI_CONFIG_HOME;
  process.env.REMOTE_CLI_CONFIG_HOME = home;
});

afterEach(() => {
  if (prevConfigHome === undefined) delete process.env.REMOTE_CLI_CONFIG_HOME;
  else process.env.REMOTE_CLI_CONFIG_HOME = prevConfigHome;
  rmSync(home, { recursive: true, force: true });
});

/** claude encodes a cwd into its project-dir name by replacing "/" with "-". */
function claudeProjectDir(cwd: string): string {
  return join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
}

function seedClaudeScan(project: string, sid: string): string {
  const cwd = join(home, "src", project);
  mkdirSync(cwd, { recursive: true });
  const dir = claudeProjectDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), "{}\n", "utf8");
  return cwd;
}

function registryEntry(project: string, over: Partial<RegistryEntry> = {}): RegistryEntry {
  const now = new Date().toISOString();
  return {
    id: `id-${project}`,
    tool: "claude",
    kind: "local-tmux",
    cwd: join(home, "src", project),
    tmuxSession: `remote-${project}`,
    enrolledAt: now,
    lastSeenAt: now,
    source: "run",
    ...over,
  };
}

describe("registry-first discovery", () => {
  it("registry entries beat the filesystem scan for the same project; the scan completes uncovered projects", () => {
    // projA: live registry entry AND scan files -> registry wins.
    const cwdA = seedClaudeScan("projA", "scan-a");
    // projB: scan only -> kept, tagged "scan".
    const cwdB = seedClaudeScan("projB", "scan-b");

    const entries = [
      registryEntry("projA", { convId: "conv-A", label: "projA" }),
    ];
    const fromRegistry = registrySessions(home, entries);
    expect(fromRegistry).toHaveLength(1);
    expect(fromRegistry[0]).toMatchObject({
      project: "projA",
      tool: "claude",
      sid: "conv-A",
      cwd: cwdA,
      origin: "registry",
      label: "projA",
    });

    const scanned = discoverSessions(60 * 60 * 1000, home);
    expect(scanned.map((s) => s.project).sort()).toEqual(["projA", "projB"]);

    const merged = mergeDiscovered(fromRegistry, scanned);
    expect(merged).toHaveLength(2);
    const a = merged.find((s) => s.project === "projA")!;
    expect(a.origin).toBe("registry");
    expect(a.sid).toBe("conv-A"); // reliable convId, not the scanned guess
    const b = merged.find((s) => s.project === "projB")!;
    expect(b.origin).toBe("scan");
    expect(b.sid).toBe("scan-b");
    expect(b.cwd).toBe(cwdB);
  });

  it("skips remote-kind entries and cwds outside ~/src", () => {
    const entries: RegistryEntry[] = [
      registryEntry("projA", { kind: "remote", remoteId: "scw-1" }),
      registryEntry("elsewhere", { cwd: "/somewhere/else" }),
    ];
    expect(registrySessions(home, entries)).toEqual([]);
  });

  it("groupSessions propagates the origin badge onto tabs", () => {
    const sessions: DiscoveredSession[] = [
      {
        project: "projA",
        mtimeMs: Date.now(),
        tool: "claude",
        sid: "conv-A",
        cwd: join(home, "src", "projA"),
        origin: "registry",
        label: "projA",
      },
      {
        project: "projB",
        mtimeMs: Date.now() - 1000,
        tool: "codex",
        sid: "scan-b",
        cwd: join(home, "src", "projB"),
        origin: "scan",
      },
    ];
    const { windows } = groupSessions(sessions, DEFAULT_LAYOUT);
    const tabs = windows.flatMap((w) => w.tabs);
    expect(tabs.find((t) => t.label === "projA")?.origin).toBe("registry");
    expect(tabs.find((t) => t.label === "projB")?.origin).toBe("scan");
  });
});

describe("layout-last.json", () => {
  it("writeLastLayout/readLastLayout round-trip with per-tab commands", () => {
    expect(readLastLayout()).toBeUndefined();
    writeLastLayout(
      [
        {
          title: "groupe un",
          tabs: [
            { cwd: "/w/a", label: "a", tool: "claude", sid: "conv-A" },
            { cwd: "/w/b", label: "b", remoteId: "scw-9" },
          ],
        },
      ],
      "groupe un",
    );
    const last = readLastLayout();
    expect(last).toBeDefined();
    expect(last!.group).toBe("groupe un");
    expect(last!.windows).toHaveLength(1);
    expect(last!.windows[0]!.tabs[0]).toMatchObject({ cwd: "/w/a", label: "a" });
    expect(last!.windows[0]!.tabs[0]!.cmd).toContain("remote run 'claude' '/w/a'");
    expect(last!.windows[0]!.tabs[0]!.cmd).toContain("--resume 'conv-A'");
    expect(last!.windows[0]!.tabs[1]!.cmd).toBe("remote attach 'scw-9' --exec");
  });

  it("omits --resume for tabs without a conversation id", () => {
    writeLastLayout([
      { title: "w", tabs: [{ cwd: "/w/a", label: "a", tool: "claude", sid: "" }] },
    ]);
    const last = readLastLayout()!;
    expect(last.group).toBeUndefined();
    expect(last.windows[0]!.tabs[0]!.cmd).not.toContain("--resume");
    expect(last.windows[0]!.tabs[0]!.cmd).toContain("--name 'a' --attach");
  });
});

describe("tabCommand", () => {
  it("attaches a SCW session via --exec", () => {
    expect(tabCommand({ cwd: "/x", label: "surch", remoteId: "sess-1" })).toBe(
      "remote attach 'sess-1' --exec",
    );
  });

  it("runs a local session that is NOT live (create + resume + attach)", () => {
    expect(
      tabCommand({ cwd: "/home/u/src/dataviz", label: "dataviz", tool: "codex", sid: "r1" }),
    ).toBe("remote run 'codex' '/home/u/src/dataviz' --resume 'r1' --name 'dataviz' --attach");
  });

  it("ATTACHES (not run -r) a local session that is already live — avoids the guard", () => {
    const live = new Set(["dataviz"]);
    expect(
      tabCommand(
        { cwd: "/home/u/src/dataviz", label: "dataviz", tool: "codex", sid: "r1" },
        live,
      ),
    ).toBe("remote attach 'dataviz'");
  });
});
