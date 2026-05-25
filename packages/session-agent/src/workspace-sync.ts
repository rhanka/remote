import { spawn } from "node:child_process";

export type FetchArchive = (url: string) => Promise<Uint8Array | null>;

const DEFAULT_RETRIES = 12;
const DEFAULT_DELAY_MS = 1000;

async function defaultFetchArchive(url: string): Promise<Uint8Array | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`workspace fetch failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
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

export type MaterializeWorkspaceOptions = {
  readonly controlPlaneEndpoint: string;
  readonly sessionId: string;
  readonly workspacePath: string;
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
  const fetchArchive = options.fetchArchive ?? defaultFetchArchive;
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
