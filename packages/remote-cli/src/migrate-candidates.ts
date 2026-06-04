/**
 * Discovery of local CLI sessions that are candidates for migration to a remote
 * workspace. Scans the claude conversation store (`~/.claude/projects/<encoded>/`)
 * and, for each project, reports the real cwd (read from the conversation), last
 * activity, conversation count/size, whether it is a git repo (cleanly
 * migratable), and whether it is already linked to a remote workspace.
 *
 * This powers `remote migrate ls` (list) and `remote migrate pick` (interactive
 * selection) so a user can move sessions to the cluster progressively, choosing
 * which ones, instead of cd-ing into each project by hand.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type MigrationCandidate = {
  /** Real project working directory (from the conversation's cwd field). */
  readonly path: string;
  /** Encoded dir name under ~/.claude/projects. */
  readonly encodedDir: string;
  /** mtime (ms) of the most-recent conversation — proxy for last activity. */
  readonly lastActivity: number;
  /** Number of conversation .jsonl files for this project. */
  readonly convCount: number;
  /** Total bytes of the conversation .jsonl files. */
  readonly sizeBytes: number;
  /** Whether the cwd is a usable git repo (clean migration via .gitignore). */
  readonly isGit: boolean;
  /** Whether the cwd still exists locally. */
  readonly exists: boolean;
  /** Whether the cwd is already linked to a remote workspace. */
  readonly linked: boolean;
};

/** Read the `cwd` field from the first conversation entry that has one. */
function readCwdFromJsonl(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        const obj = JSON.parse(line) as { cwd?: unknown };
        if (typeof obj.cwd === "string" && obj.cwd.startsWith("/")) return obj.cwd;
      } catch {
        // partial last line / non-JSON — keep scanning
      }
    }
  } catch {
    // unreadable — fall through
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

/** Best-effort decode of claude's project-dir encoding (slashes → dashes). */
function decodePath(encodedDir: string): string {
  return "/" + encodedDir.replace(/^-/, "").replace(/-/g, "/");
}

function isGitRepo(cwd: string): boolean {
  if (!existsSync(cwd)) return false;
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 && r.stdout.trim() === "true";
}

export function listMigrationCandidates(
  home: string = homedir(),
): MigrationCandidate[] {
  const projectsRoot = join(home, ".claude", "projects");
  if (!existsSync(projectsRoot)) return [];

  const out: MigrationCandidate[] = [];
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(projectsRoot, entry.name);
    let jsonls: string[];
    try {
      jsonls = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (jsonls.length === 0) continue;

    let lastActivity = 0;
    let sizeBytes = 0;
    let newestFile = jsonls[0]!;
    for (const f of jsonls) {
      try {
        const st = statSync(join(dir, f));
        sizeBytes += st.size;
        if (st.mtimeMs > lastActivity) {
          lastActivity = st.mtimeMs;
          newestFile = f;
        }
      } catch {
        // skip unreadable
      }
    }

    const path = readCwdFromJsonl(join(dir, newestFile)) ?? decodePath(entry.name);
    const exists = existsSync(path);
    out.push({
      path,
      encodedDir: entry.name,
      lastActivity,
      convCount: jsonls.length,
      sizeBytes,
      isGit: isGitRepo(path),
      exists,
      linked: exists && existsSync(join(path, ".remote", "workspace.json")),
    });
  }

  return out.sort((a, b) => b.lastActivity - a.lastActivity);
}

/** Human-readable size (KiB/MiB). */
export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024).toFixed(0)}K`;
}

/** Relative age from an mtime (ms) given "now" (ms). */
export function humanAge(mtimeMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - mtimeMs) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
