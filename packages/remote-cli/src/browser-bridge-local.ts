import type { UatExposurePolicy } from "./protocol-local.js";

export const NOVNC_POD_PORT = 6080;

export type ExposureRequester = "operator" | "session-owner" | "anonymous";
export type ExposureDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };
export type ExposureRequest = {
  readonly policy: UatExposurePolicy;
  readonly requester: ExposureRequester;
  readonly hasToken: boolean;
  readonly expiresInMs?: number;
};
export type RandomBytes = (length: number) => Uint8Array;

export function evaluateExposure(req: ExposureRequest): ExposureDecision {
  switch (req.policy) {
    case "operator-only":
      return req.requester === "operator"
        ? { allowed: true }
        : { allowed: false, reason: `policy "operator-only" forbids requester "${req.requester}" — only an operator may expose this browser` };
    case "session-private":
      if (req.requester === "anonymous") {
        return { allowed: false, reason: 'policy "session-private" forbids an anonymous requester — only the session owner or an operator may expose this browser' };
      }
      if (!req.hasToken) {
        return { allowed: false, reason: 'policy "session-private" requires a per-session access token on the route (none present)' };
      }
      return { allowed: true };
    case "public-expiring":
      if (!req.hasToken) {
        return { allowed: false, reason: 'policy "public-expiring" requires a per-session access token on the route (none present)' };
      }
      if (req.expiresInMs === undefined || req.expiresInMs <= 0) {
        return { allowed: false, reason: 'policy "public-expiring" requires a finite positive expiry (expiresInMs) — refusing an open-ended public route' };
      }
      return { allowed: true };
  }
}

export function buildForwardCommand(sessionId: string, localPort?: number): string {
  const tail = localPort === undefined ? "" : ` ${localPort}`;
  return `remote forward ${sessionId} ${NOVNC_POD_PORT}${tail}`;
}

export function buildNoVncUrl(opts: { readonly localPort?: number; readonly token: string; readonly interactive?: boolean; readonly autoconnect?: boolean; readonly host?: string }): string {
  const host = opts.host ?? "localhost";
  const port = opts.localPort ?? NOVNC_POD_PORT;
  const interactive = opts.interactive ?? true;
  const autoconnect = opts.autoconnect ?? true;
  const params = new URLSearchParams();
  params.set("path", `websockify?token=${opts.token}`);
  if (autoconnect) params.set("autoconnect", "true");
  if (!interactive) params.set("view_only", "true");
  return `http://${host}:${port}/vnc.html?${params.toString()}`;
}

const defaultRandomBytes: RandomBytes = (length) => {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
};

export function mintNoVncToken(rng: RandomBytes = defaultRandomBytes): string {
  return Array.from(rng(16), (b) => b.toString(16).padStart(2, "0")).join("");
}
