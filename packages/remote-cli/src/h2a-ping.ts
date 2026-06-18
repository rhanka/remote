import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultLocalH2aRoot, instanceInboxDir } from "./h2a-bridge.js";
import { H2A_PROTOCOL, H2A_VERSION, type EnvelopeActor } from "./h2a-jobs.js";

const SAFE_INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type H2aPingEnvelope = {
  protocol: typeof H2A_PROTOCOL;
  version: typeof H2A_VERSION;
  id: string;
  type: "h2a.ping";
  actor: EnvelopeActor;
  to: string;
  body: {
    message: string;
    cwd?: string;
  };
  createdAt: string;
};

export type H2aPingResult = {
  path: string;
  written: boolean;
  envelope: H2aPingEnvelope;
};

function assertSafeInstance(instance: string): void {
  if (!SAFE_INSTANCE.test(instance)) {
    throw new Error(
      `unsafe h2a instance "${instance}" (allowed: letters, digits, ".", "_", "-", ":")`,
    );
  }
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function h2aPingFileName(ts: number): string {
  return `env__${ts}__h2a_ping.json`;
}

export function remoteSessionIdFromInstance(
  instance: string,
): string | undefined {
  const match = /^[A-Za-z0-9._-]+:remote:([A-Za-z0-9._-]+)$/.exec(instance);
  return match?.[1];
}

export function buildH2aPingEnvelope(args: {
  to: string;
  from?: string;
  message?: string;
  cwd?: string;
  nowMs?: number;
}): H2aPingEnvelope {
  const ts = args.nowMs ?? Date.now();
  const from = args.from ?? "remote:cli";
  assertSafeInstance(args.to);
  assertSafeInstance(from);
  const body: H2aPingEnvelope["body"] = {
    message: args.message ?? "ping",
  };
  if (args.cwd !== undefined) body.cwd = args.cwd;
  return {
    protocol: H2A_PROTOCOL,
    version: H2A_VERSION,
    id: `env:${ts}:h2a-ping`,
    type: "h2a.ping",
    actor: { instance: from, role: "AGENTS", scope: "scope:default" },
    to: args.to,
    body,
    createdAt: nowIso(ts),
  };
}

export function dropH2aPing(
  envelope: H2aPingEnvelope,
  localRoot: string = defaultLocalH2aRoot(),
): H2aPingResult {
  assertSafeInstance(envelope.to);
  const ts = Date.parse(envelope.createdAt);
  const file = h2aPingFileName(Number.isFinite(ts) ? ts : Date.now());
  const dir = join(localRoot, "inbox", instanceInboxDir(envelope.to));
  const path = join(dir, file);
  if (existsSync(path)) return { path, written: false, envelope };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  return { path, written: true, envelope };
}

export function sendH2aPing(args: {
  to: string;
  from?: string;
  message?: string;
  cwd?: string;
  localRoot?: string;
  nowMs?: number;
}): H2aPingResult {
  const envelope = buildH2aPingEnvelope(args);
  return dropH2aPing(envelope, args.localRoot);
}
