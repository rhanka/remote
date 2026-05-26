import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

const STATE_SUBDIR = ".remote/sessions";

export type OnConflict = "backup" | "keep-local" | "block";

export type RestoreResult = {
  readonly restored: string[]; // remote written to local (clear new/continuation)
  readonly keptLocal: string[]; // local already ahead → remote skipped
  readonly backedUp: string[]; // local duplicated, remote written
  readonly conflicts: string[]; // diverged, left untouched (block)
};

function extractInto(archive: Buffer, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const res = spawnSync("tar", ["-xzf", "-", "-C", dest], { input: archive });
  if (res.status !== 0) {
    throw new Error(`tar extract failed: ${res.stderr?.toString() ?? res.status}`);
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) out.push(relative(root, abs));
    }
  }
  return out;
}

function isPrefix(short: Buffer, long: Buffer): boolean {
  return short.length <= long.length && long.subarray(0, short.length).equals(short);
}

function backupWithNewId(home: string, rel: string, local: Buffer): string {
  // Heuristic: the conversation id is the filename stem (uuid-like). Duplicate
  // the local conversation under a fresh id so the CLI lists it separately.
  const ext = extname(rel);
  const dir = dirname(rel);
  const stem = rel.slice(dir === "." ? 0 : dir.length + 1, rel.length - ext.length);
  const newId = randomUUID();
  const newRel = join(dir === "." ? "" : dir, `${newId}${ext}`);
  const replaced =
    stem.length >= 8
      ? Buffer.from(local.toString("utf8").split(stem).join(newId), "utf8")
      : local;
  const dst = join(home, newRel);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, replaced);
  return newRel;
}

/**
 * Restore persisted conversation state from a workspace export archive into the
 * local HOME. Per file:
 *  - local absent → write remote (new conversation).
 *  - local == remote → skip.
 *  - local is a prefix of remote (remote is a continuation) → overwrite.
 *  - remote is a prefix of local (local is ahead) → keep local.
 *  - diverged → conflict, resolved by `onConflict`:
 *      backup    → duplicate local under a fresh id, then write remote.
 *      keep-local→ skip remote.
 *      block     → leave untouched, report.
 */
export function restoreSessionsToLocal(args: {
  home: string;
  profile: string;
  remoteArchive: Buffer;
  onConflict: OnConflict;
}): RestoreResult {
  const tmp = mkdtempSync(join(tmpdir(), "remote-restore-"));
  const result: RestoreResult = {
    restored: [],
    keptLocal: [],
    backedUp: [],
    conflicts: [],
  };
  try {
    extractInto(args.remoteArchive, tmp);
    const stateRoot = join(tmp, STATE_SUBDIR, args.profile);
    for (const rel of walk(stateRoot)) {
      const remote = readFileSync(join(stateRoot, rel));
      const localPath = join(args.home, rel);
      let local: Buffer | null = null;
      try {
        if (statSync(localPath).isFile()) local = readFileSync(localPath);
      } catch {
        local = null;
      }

      const write = () => {
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, remote);
      };

      if (local === null) {
        write();
        result.restored.push(rel);
      } else if (local.equals(remote)) {
        // identical, nothing to do
      } else if (isPrefix(local, remote)) {
        write();
        result.restored.push(rel);
      } else if (isPrefix(remote, local)) {
        result.keptLocal.push(rel);
      } else if (args.onConflict === "backup") {
        const bak = backupWithNewId(args.home, rel, local);
        write();
        result.backedUp.push(`${rel} -> ${bak}`);
      } else if (args.onConflict === "keep-local") {
        result.keptLocal.push(rel);
      } else {
        result.conflicts.push(rel);
      }
    }
    return result;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
