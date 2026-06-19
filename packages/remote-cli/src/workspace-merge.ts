import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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
import { dirname, join, relative } from "node:path";

function extractInto(archive: Buffer, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const res = spawnSync("tar", ["-xzf", "-", "-C", dest], { input: archive });
  if (res.status !== 0) {
    throw new Error(
      `tar extract failed: ${res.stderr?.toString() ?? res.status}`,
    );
  }
}

function walkFiles(root: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".remote") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.add(relative(root, abs));
    }
  }
  return out;
}

function readOrNull(root: string, rel: string): Buffer | null {
  const abs = join(root, rel);
  try {
    if (!statSync(abs).isFile()) return null;
    return readFileSync(abs);
  } catch {
    return null;
  }
}

function eq(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

// Heuristic: a file is binary if it contains a NUL byte in the first 8 KiB.
// git merge-file corrupts binary content — route binary conflicts to .bak instead.
function isBinary(buf: Buffer): boolean {
  const probe = buf.slice(0, 8192);
  return probe.includes(0);
}

function writeLocal(cwd: string, rel: string, content: Buffer): void {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export type MergeResult = {
  readonly merged: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<string>;
  readonly tookRemote: ReadonlyArray<string>;
  readonly keptLocal: ReadonlyArray<string>;
};

/**
 * 3-way merge of a remote workspace archive into `cwd`, using an optional base
 * snapshot (the last-synced tree) as the common ancestor. Line-level conflicts
 * are resolved with `git merge-file` and left with conflict markers.
 */
export function mergeWorkspaceArchive(args: {
  cwd: string;
  remoteArchive: Buffer;
  baseArchive: Buffer | null;
}): MergeResult {
  const tmp = mkdtempSync(join(tmpdir(), "remote-merge-"));
  const remoteDir = join(tmp, "remote");
  const baseDir = join(tmp, "base");
  try {
    extractInto(args.remoteArchive, remoteDir);
    if (args.baseArchive) extractInto(args.baseArchive, baseDir);
    else mkdirSync(baseDir, { recursive: true });

    const paths = new Set<string>([
      ...walkFiles(remoteDir),
      ...walkFiles(args.cwd),
      ...walkFiles(baseDir),
    ]);

    const merged: string[] = [];
    const conflicts: string[] = [];
    const tookRemote: string[] = [];
    const keptLocal: string[] = [];

    for (const rel of paths) {
      const base = readOrNull(baseDir, rel);
      const local = readOrNull(args.cwd, rel);
      const remote = readOrNull(remoteDir, rel);

      if (remote === null) {
        // deleted (or never existed) on remote — keep whatever is local
        if (local !== null) keptLocal.push(rel);
        continue;
      }
      if (local === null) {
        writeLocal(args.cwd, rel, remote);
        tookRemote.push(rel);
        continue;
      }
      if (eq(local, remote)) continue;
      if (base !== null && eq(local, base)) {
        writeLocal(args.cwd, rel, remote);
        tookRemote.push(rel);
        continue;
      }
      if (base !== null && eq(remote, base)) {
        keptLocal.push(rel);
        continue;
      }
      // both diverged from base (or no base) — binary files must not go through
      // git merge-file (it produces garbage). Back up local, take remote, mark conflict.
      if (isBinary(local) || isBinary(remote)) {
        const epoch = Math.floor(Date.now() / 1000);
        const abs = join(args.cwd, rel);
        copyFileSync(abs, `${abs}.bak-${epoch}`);
        writeLocal(args.cwd, rel, remote);
        conflicts.push(rel);
        continue;
      }
      // 3-way line merge for text files
      const mt = mkdtempSync(join(tmp, "f-"));
      const lf = join(mt, "local");
      const bf = join(mt, "base");
      const rf = join(mt, "remote");
      writeFileSync(lf, local);
      writeFileSync(bf, base ?? Buffer.alloc(0));
      writeFileSync(rf, remote);
      const res = spawnSync(
        "git",
        [
          "merge-file",
          "-p",
          "-L",
          `${rel} (local)`,
          "-L",
          `${rel} (base)`,
          "-L",
          `${rel} (remote)`,
          lf,
          bf,
          rf,
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const out = res.stdout ?? Buffer.alloc(0);
      writeLocal(args.cwd, rel, out);
      merged.push(rel);
      if ((res.status ?? 0) > 0) conflicts.push(rel);
    }

    return { merged, conflicts, tookRemote, keptLocal };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
