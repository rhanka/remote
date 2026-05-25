import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MARKER_DIR = ".remote";
const MARKER_FILE = "workspace.json";

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
