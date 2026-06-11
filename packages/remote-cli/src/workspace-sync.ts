import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { authHeaders } from "./config.js";

// Largest .git we ship in the workspace archive. Over this, the repo history is
// not transferred (the user restores it in-Pod via git fetch/clone).
const MAX_GIT_BYTES = 128 * 1024 * 1024; // 128 MiB

/** Best-effort directory size in bytes via `du -sk`. Infinity on failure (so we skip). */
async function dirSizeBytes(absPath: string): Promise<number> {
  const r = await run("du", ["-sk", absPath], dirname(absPath));
  if (r.status !== 0) return Number.POSITIVE_INFINITY;
  const kb = parseInt(r.stdout.toString("utf8").trim().split(/\s+/)[0] ?? "", 10);
  return Number.isFinite(kb) ? kb * 1024 : Number.POSITIVE_INFINITY;
}

// Safety cap against accidentally pushing huge directories. Generous because a
// legitimate migrated conversation (.remote/sessions) can be large — claude
// transcripts embed base64 images that do not compress.
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024; // 256 MiB

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ status: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", () =>
      resolve({ status: 127, stdout: Buffer.concat(stdout), stderr: "spawn error" }),
    );
    child.on("close", (code) =>
      resolve({
        status: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await run(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    cwd,
  );
  return result.status === 0 && result.stdout.toString("utf8").trim() === "true";
}

/**
 * Build a gzip tarball of the working directory to seed a remote /workspace.
 *
 * In a git repo, uses `git ls-files -co --exclude-standard` so the archive
 * honors .gitignore precisely AND includes uncommitted working-tree files.
 * Outside a git repo, falls back to tar with a coarse exclude list.
 */
/**
 * Approximate .gitignore in the non-git tar fallback: each plain pattern of
 * the ROOT .gitignore becomes a tar --exclude. Comments and `!` negations are
 * skipped; a trailing `/` is dropped (tar excludes match path components at
 * any depth, like unanchored gitignore dir patterns); a leading `/` anchors
 * the pattern to the archive root (`./`). Patterns that would drop migrated
 * session state (`.remote`, `.claude`) are ignored — the conversation under
 * .remote/sessions must always travel with the workspace.
 */
function rootGitignoreExcludes(cwd: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const excludes: string[] = [];
  for (const line of raw.split("\n")) {
    const pattern = line.trim();
    if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) continue;
    const cleaned = pattern.replace(/\/+$/, "");
    if (!cleaned) continue;
    const bare = cleaned.replace(/^\/+/, "");
    if (bare === ".remote" || bare === ".claude") continue;
    excludes.push(
      `--exclude=${cleaned.startsWith("/") ? `./${bare}` : cleaned}`,
    );
  }
  return excludes;
}

export async function buildWorkspaceArchive(cwd: string): Promise<Buffer> {
  const git = await isGitRepo(cwd);
  let archive: Buffer;
  if (git) {
    const list = await run(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      cwd,
    );
    if (list.status !== 0) {
      throw new Error(`git ls-files failed: ${list.stderr}`);
    }
    if (list.stdout.byteLength === 0) {
      throw new Error("no files to sync (git ls-files returned nothing)");
    }
    // Force-include persisted conversation state under .remote/sessions even
    // though .gitignore typically excludes it (the nested `.claude/` path
    // segment trips a `.claude/` ignore rule). This is how a migrated session
    // carries its in-progress conversation onto the remote workspace PVC, where
    // the session-agent restores it into HOME before the CLI starts.
    const sessionState = await run(
      "git",
      [
        "ls-files",
        "-o",
        "-z",
        "--",
        ".remote/sessions",
        ".remote/git.json",
        ".claude/settings.json",
        ".claude/settings.local.json",
      ],
      cwd,
    );
    // Force-include the .git directory (git ls-files never lists it) so the
    // remote workspace is a real git repo — commit/push works in the Pod and
    // the remote/branch config travels. Size-gated: huge histories blow the
    // archive cap and the tunnel, so over MAX_GIT_BYTES we skip the objects and
    // let the user restore git in-Pod (git fetch/clone — gh auth is bundled).
    let gitDir = Buffer.alloc(0);
    if (existsSync(join(cwd, ".git"))) {
      const gitBytes = await dirSizeBytes(join(cwd, ".git"));
      if (gitBytes <= MAX_GIT_BYTES) {
        gitDir = Buffer.from(".git\0", "utf8");
      } else {
        process.stderr.write(
          `[remote] .git is ${(gitBytes / 1024 / 1024).toFixed(0)} MiB (> ${MAX_GIT_BYTES / 1024 / 1024} MiB) — not shipped; ` +
            `restore git in the Pod with 'git fetch'/'git clone' (gh auth is bundled if you pass --with gh)\n`,
        );
      }
    }
    const fileList = Buffer.concat([
      list.stdout,
      sessionState.status === 0 ? sessionState.stdout : Buffer.alloc(0),
      gitDir,
    ]);
    const tar = await runWithStdin(
      "tar",
      ["-czf", "-", "--null", "-T", "-"],
      cwd,
      fileList,
    );
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    archive = tar.stdout;
  } else {
    const tar = await run(
      "tar",
      [
        "-czf",
        "-",
        "--exclude=./.git",
        "--exclude=./node_modules",
        ...rootGitignoreExcludes(cwd),
        ".",
      ],
      cwd,
    );
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    archive = tar.stdout;
  }
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `workspace archive is ${(archive.byteLength / 1024 / 1024).toFixed(1)} MiB, over the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB cap; add large paths to .gitignore`,
    );
  }
  return archive;
}

function runWithStdin(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  input: Buffer,
): Promise<{ status: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", () =>
      resolve({ status: 127, stdout: Buffer.concat(stdout), stderr: "spawn error" }),
    );
    child.on("close", (code) =>
      resolve({
        status: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.write(input);
    child.stdin.end();
  });
}

export async function uploadWorkspaceArchive(
  baseUrl: string,
  sessionId: string,
  archive: Buffer,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${baseUrl.replace(/\/$/, "")}/sessions/${sessionId}/workspace`,
    {
      method: "POST",
      headers: { "content-type": "application/gzip", ...authHeaders() },
      body: archive as unknown as BodyInit,
    },
  );
  if (!response.ok) {
    throw new Error(
      `workspace upload failed: ${response.status} ${response.statusText}`,
    );
  }
}
