import { spawn } from "node:child_process";

import { authHeaders } from "./config.js";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024; // 50 MiB safety cap

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
    const tar = await runWithStdin(
      "tar",
      ["-czf", "-", "--null", "-T", "-"],
      cwd,
      list.stdout,
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
