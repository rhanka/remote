import type {
  CreateSessionResponse,
  ListSessionsResponse,
  SessionDescriptor,
  StopSessionResponse,
} from "@sentropic/remote-protocol";

const DEFAULT_API = "http://localhost:8080";

export function resolveApiBase(): string {
  if (typeof window === "undefined") return DEFAULT_API;
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("api") ??
    window.localStorage.getItem("sentropic.api") ??
    DEFAULT_API
  );
}

export function persistApiBase(value: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("sentropic.api", value);
}

function join(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

export async function listSessions(base: string): Promise<SessionDescriptor[]> {
  const res = await fetch(join(base, "/sessions"));
  if (!res.ok) throw new Error(`listSessions ${res.status}`);
  const json = (await res.json()) as ListSessionsResponse;
  return json.sessions;
}

export async function createSession(
  base: string,
  body: { profile: string; target: string; displayName?: string },
): Promise<SessionDescriptor> {
  const res = await fetch(join(base, "/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createSession ${res.status}`);
  const json = (await res.json()) as CreateSessionResponse;
  return json.session;
}

export async function stopSession(
  base: string,
  id: string,
  reason?: string,
): Promise<boolean> {
  const res = await fetch(join(base, `/sessions/${id}/stop`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok) throw new Error(`stopSession ${res.status}`);
  const json = (await res.json()) as StopSessionResponse;
  return json.accepted;
}

export async function sendTerminalInput(
  base: string,
  id: string,
  data: string,
): Promise<void> {
  await fetch(join(base, `/sessions/${id}/terminal/input`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terminalId: "operator-ui",
      data,
      encoding: "utf8",
    }),
  });
}

export async function sendTerminalResize(
  base: string,
  id: string,
  columns: number,
  rows: number,
): Promise<void> {
  await fetch(join(base, `/sessions/${id}/terminal/resize`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terminalId: "operator-ui", columns, rows }),
  });
}

export function sessionEventStreamUrl(base: string, id: string): string {
  return join(base, `/sessions/${id}/events`);
}
