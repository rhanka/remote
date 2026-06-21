/**
 * WP16 Layer-C — local LLM account pool.
 *
 * Descriptor store: ~/.sentropic/accounts.json (0600) — id, provider, label, enrolledAt.
 * Token store:      ~/.sentropic/accounts-tokens.json (0600) — secrets only, separate file.
 *
 * Invariants:
 *  - No tokens ever appear in descriptors, stdout, logs, or track.
 *  - Both files are 0600 (owner-only). mkdirSync enforces ~/.sentropic/ exists.
 *  - selectAccount() is pure: no I/O, just candidates + policy → one descriptor.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AccountProvider = "claude-code" | "codex";

export type AccountDescriptor = {
  readonly id: string;
  readonly provider: AccountProvider;
  readonly label: string;
  readonly enrolledAt: string;
};

export type AccountCandidate = AccountDescriptor & {
  readonly accessToken: string;
};

export function sentropicDir(): string {
  return join(homedir(), ".sentropic");
}

export function accountsDescriptorPath(dir: string = sentropicDir()): string {
  return join(dir, "accounts.json");
}

export function accountsTokensPath(dir: string = sentropicDir()): string {
  return join(dir, "accounts-tokens.json");
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeSecret(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Descriptor store (no tokens)
// ---------------------------------------------------------------------------

export function loadDescriptors(dir?: string): AccountDescriptor[] {
  return readJson<AccountDescriptor[]>(accountsDescriptorPath(dir)) ?? [];
}

function saveDescriptors(descs: AccountDescriptor[], dir?: string): void {
  writeSecret(accountsDescriptorPath(dir), descs);
}

// ---------------------------------------------------------------------------
// Token store (secrets only — never mixed with descriptors)
// ---------------------------------------------------------------------------

function loadTokenMap(dir?: string): Record<string, string> {
  return readJson<Record<string, string>>(accountsTokensPath(dir)) ?? {};
}

function saveTokenMap(map: Record<string, string>, dir?: string): void {
  writeSecret(accountsTokensPath(dir), map);
}

// ---------------------------------------------------------------------------
// Enroll
// ---------------------------------------------------------------------------

export type EnrollOpts = {
  provider: AccountProvider;
  label: string;
  accessToken: string;
  id?: string;
  dir?: string;
};

export type EnrollResult =
  | { ok: true; descriptor: AccountDescriptor }
  | { ok: false; error: string };

export function enrollAccount(opts: EnrollOpts): EnrollResult {
  if (!opts.accessToken.trim()) {
    return { ok: false, error: "access token is empty" };
  }
  const descs = loadDescriptors(opts.dir);
  const id = opts.id ?? `${opts.provider}-${Math.floor(Date.now() / 1000)}`;
  if (descs.some((d) => d.id === id)) {
    return {
      ok: false,
      error: `account "${id}" already enrolled; use --id to specify a unique id`,
    };
  }
  const descriptor: AccountDescriptor = {
    id,
    provider: opts.provider,
    label: opts.label,
    enrolledAt: new Date().toISOString(),
  };
  saveDescriptors([...descs, descriptor], opts.dir);
  const tokens = loadTokenMap(opts.dir);
  tokens[id] = opts.accessToken;
  saveTokenMap(tokens, opts.dir);
  return { ok: true, descriptor };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function listAccounts(dir?: string): AccountDescriptor[] {
  return loadDescriptors(dir);
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export type RemoveResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export function removeAccount(id: string, dir?: string): RemoveResult {
  const descs = loadDescriptors(dir);
  if (!descs.some((d) => d.id === id)) {
    return { ok: false, error: `account "${id}" not found` };
  }
  saveDescriptors(
    descs.filter((d) => d.id !== id),
    dir,
  );
  const tokens = loadTokenMap(dir);
  delete tokens[id];
  saveTokenMap(tokens, dir);
  return { ok: true, id };
}

// ---------------------------------------------------------------------------
// Load candidates (descriptor + token) — internal, never surfaced to user
// ---------------------------------------------------------------------------

export function loadCandidates(
  provider?: AccountProvider,
  dir?: string,
): AccountCandidate[] {
  const descs = loadDescriptors(dir);
  const tokens = loadTokenMap(dir);
  return descs
    .filter((d) => !provider || d.provider === provider)
    .flatMap((d) => {
      const accessToken = tokens[d.id];
      if (!accessToken) return [];
      return [{ ...d, accessToken }];
    });
}

// ---------------------------------------------------------------------------
// selectAccount — pure planner (no I/O, no secrets)
//
// Round-robin: given candidate descriptors + the last-used id, returns the
// next descriptor. Advancing past lastUsedId; wraps around.
// ---------------------------------------------------------------------------

export type SelectPolicy = "round-robin";

export function selectAccount(
  candidates: ReadonlyArray<AccountDescriptor>,
  lastUsedId?: string,
  _policy: SelectPolicy = "round-robin",
): AccountDescriptor | undefined {
  if (candidates.length === 0) return undefined;
  if (!lastUsedId) return candidates[0];
  const idx = candidates.findIndex((c) => c.id === lastUsedId);
  if (idx === -1) return candidates[0];
  return candidates[(idx + 1) % candidates.length];
}

// ---------------------------------------------------------------------------
// Sticky binding (Layer-C local stub)
//
// Aligns with SPEC_EVOL_LLM_MESH_ACCOUNT_TRANSPORTS: non-secret affinityKey,
// durable per-session binding, NO silent rebind when account is exhausted.
// A binding created at session launch persists until the session ends or an
// explicit `remote account rm-binding` clears it.
// ---------------------------------------------------------------------------

export type SessionBinding = {
  readonly affinityKey: string;
  readonly accountId: string;
  readonly provider: AccountProvider;
  readonly boundAt: string;
};

export function bindingsPath(dir: string = sentropicDir()): string {
  return join(dir, "session-bindings.json");
}

function loadBindings(dir?: string): Record<string, SessionBinding> {
  return (
    readJson<Record<string, SessionBinding>>(bindingsPath(dir)) ?? {}
  );
}

function saveBindings(
  bindings: Record<string, SessionBinding>,
  dir?: string,
): void {
  writeSecret(bindingsPath(dir), bindings);
}

/** Write (or overwrite) a sticky binding for an affinityKey. */
export function stickyBind(
  affinityKey: string,
  accountId: string,
  provider: AccountProvider,
  dir?: string,
): SessionBinding {
  const bindings = loadBindings(dir);
  const binding: SessionBinding = {
    affinityKey,
    accountId,
    provider,
    boundAt: new Date().toISOString(),
  };
  bindings[affinityKey] = binding;
  saveBindings(bindings, dir);
  return binding;
}

/** Return the binding for affinityKey, or undefined if not yet bound. */
export function lookupBinding(
  affinityKey: string,
  dir?: string,
): SessionBinding | undefined {
  return loadBindings(dir)[affinityKey];
}

/** Remove a binding (explicit rebind path — not silent). */
export function clearBinding(affinityKey: string, dir?: string): void {
  const bindings = loadBindings(dir);
  delete bindings[affinityKey];
  saveBindings(bindings, dir);
}

// ---------------------------------------------------------------------------
// Gateway constants (Layer-B wire — stable per architect spec)
// ---------------------------------------------------------------------------

export const MESH_GATEWAY_URL = "https://mesh.sent-tech.ca";

/**
 * Returns the env vars to inject into a session so it routes through the
 * mesh-gateway. Requires a valid sentropic S2S DPoP token for pod auth
 * (injected separately by the control-plane auth flow, not here).
 */
export function meshGatewayEnv(): { ANTHROPIC_BASE_URL: string } {
  return { ANTHROPIC_BASE_URL: MESH_GATEWAY_URL };
}
