import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MARKER_DIR = ".remote";
const MARKER_FILE = "workspace.json";
const BASE_FILE = "base.tgz";

export function baseSnapshotPath(cwd: string): string {
  return join(cwd, MARKER_DIR, BASE_FILE);
}

export function readBaseSnapshot(cwd: string): Buffer | null {
  const path = baseSnapshotPath(cwd);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

export function writeBaseSnapshot(cwd: string, archive: Buffer): void {
  const path = baseSnapshotPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, archive);
}

export type WorkspaceMarker = {
  readonly remote: string;
  readonly workspaceId: string;
};

export function markerPath(cwd: string): string {
  return join(cwd, MARKER_DIR, MARKER_FILE);
}

export function readWorkspaceMarker(cwd: string): WorkspaceMarker | undefined {
  try {
    const raw = readFileSync(markerPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkspaceMarker>;
    if (
      parsed &&
      typeof parsed.remote === "string" &&
      typeof parsed.workspaceId === "string"
    ) {
      return { remote: parsed.remote, workspaceId: parsed.workspaceId };
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `failed to read ${MARKER_DIR}/${MARKER_FILE}: ${(error as Error).message}`,
    );
  }
}

export function writeWorkspaceMarker(
  cwd: string,
  marker: WorkspaceMarker,
): void {
  const path = markerPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2) + "\n", "utf8");
}

type WorkspaceDescriptor = {
  id: string;
  createdAt: string;
  displayName?: string;
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

export async function createWorkspace(
  baseUrl: string,
  body: { displayName?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<WorkspaceDescriptor> {
  const response = await fetchImpl(joinUrl(baseUrl, "/workspaces"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `createWorkspace: ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as { workspace: WorkspaceDescriptor };
  return json.workspace;
}

export async function listWorkspaces(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadonlyArray<WorkspaceDescriptor>> {
  const response = await fetchImpl(joinUrl(baseUrl, "/workspaces"));
  if (!response.ok) {
    throw new Error(`listWorkspaces: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as {
    workspaces: WorkspaceDescriptor[];
  };
  return json.workspaces;
}

export async function deleteWorkspace(
  baseUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetchImpl(
    joinUrl(baseUrl, `/workspaces/${workspaceId}`),
    { method: "DELETE" },
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `deleteWorkspace: ${response.status} ${response.statusText}`,
    );
  }
  return true;
}

export async function downloadWorkspaceExport(
  baseUrl: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer | null> {
  const response = await fetchImpl(
    joinUrl(baseUrl, `/sessions/${sessionId}/workspace/export`),
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `downloadWorkspaceExport: ${response.status} ${response.statusText}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

export type LockResult =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly holder: string; readonly since: string };

export async function acquireWorkspaceLock(
  baseUrl: string,
  workspaceId: string,
  holder: string,
  ttlSeconds = 300,
  fetchImpl: typeof fetch = fetch,
): Promise<LockResult> {
  const response = await fetchImpl(
    joinUrl(baseUrl, `/workspaces/${workspaceId}/lock`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ holder, ttlSeconds }),
    },
  );
  if (response.ok) return { acquired: true };
  if (response.status === 409) {
    const body = (await response.json()) as {
      holder?: string;
      acquiredAt?: string;
    };
    return {
      acquired: false,
      holder: body.holder ?? "unknown",
      since: body.acquiredAt ?? "unknown",
    };
  }
  throw new Error(
    `acquireWorkspaceLock: ${response.status} ${response.statusText}`,
  );
}

export async function releaseWorkspaceLock(
  baseUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await fetchImpl(joinUrl(baseUrl, `/workspaces/${workspaceId}/lock`), {
    method: "DELETE",
  }).catch(() => {});
}

export function lockHolderId(): string {
  const user = process.env.USER ?? process.env.USERNAME ?? "user";
  const host =
    process.env.HOSTNAME ?? process.env.HOST ?? "local";
  return `${user}@${host}`;
}
