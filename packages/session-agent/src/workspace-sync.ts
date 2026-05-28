import { spawn } from "node:child_process";

export type FetchArchive = (url: string) => Promise<Uint8Array | null>;

const DEFAULT_RETRIES = 12;
const DEFAULT_DELAY_MS = 1000;

/** Bearer header for the session-agent's callbacks under auth; empty otherwise. */
function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function makeFetchArchive(token: string | undefined): FetchArchive {
  return async (url: string): Promise<Uint8Array | null> => {
    const response = await fetch(url, { headers: authHeaders(token) });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`workspace fetch failed: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

function extractTarGz(archive: Uint8Array, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", "-", "-C", dest], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}`));
    });
    child.stdin.write(archive);
    child.stdin.end();
  });
}

function archiveTarGz(srcDir: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", "-", "-C", srcDir, "."], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(chunks)));
      else reject(new Error(`tar exited with code ${code}`));
    });
  });
}

export type ExportWorkspaceOptions = {
  readonly controlPlaneEndpoint: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  /** Per-session service token; sent as Authorization: Bearer when set. */
  readonly token?: string;
  readonly archive?: (srcDir: string) => Promise<Uint8Array>;
  readonly upload?: (url: string, body: Uint8Array) => Promise<void>;
};

function makeUpload(
  token: string | undefined,
): (url: string, body: Uint8Array) => Promise<void> {
  return async (url: string, body: Uint8Array): Promise<void> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/gzip", ...authHeaders(token) },
      body: body as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(`workspace export upload failed: ${response.status}`);
    }
  };
}

/**
 * Tar /workspace and POST it to the control-plane export endpoint so the CLI
 * (`remote workspace pull`) can download and 3-way merge it locally.
 */
export async function exportWorkspace(
  options: ExportWorkspaceOptions,
): Promise<number> {
  const archive = options.archive ?? archiveTarGz;
  const upload = options.upload ?? makeUpload(options.token);
  const url = `${options.controlPlaneEndpoint.replace(/\/$/, "")}/sessions/${options.sessionId}/workspace/export`;
  const bytes = await archive(options.workspacePath);
  await upload(url, bytes);
  return bytes.byteLength;
}

export type MaterializeWorkspaceOptions = {
  readonly controlPlaneEndpoint: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  /** Per-session service token; sent as Authorization: Bearer when set. */
  readonly token?: string;
  readonly fetchArchive?: FetchArchive;
  readonly extract?: (archive: Uint8Array, dest: string) => Promise<void>;
  readonly retries?: number;
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * Fetch the workspace archive the CLI uploaded to the control-plane (with a
 * short retry to absorb the upload/Pod-start race) and extract it into the
 * workspace. Returns true if an archive was extracted, false if none was
 * staged within the retry window.
 */
export async function materializeWorkspace(
  options: MaterializeWorkspaceOptions,
): Promise<boolean> {
  const fetchArchive = options.fetchArchive ?? makeFetchArchive(options.token);
  const extract = options.extract ?? extractTarGz;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = `${options.controlPlaneEndpoint.replace(/\/$/, "")}/sessions/${options.sessionId}/workspace`;

  for (let attempt = 0; attempt < retries; attempt++) {
    const archive = await fetchArchive(url);
    if (archive && archive.byteLength > 0) {
      await extract(archive, options.workspacePath);
      return true;
    }
    if (attempt < retries - 1) await sleep(delayMs);
  }
  return false;
}
