/**
 * h2a bridge (`remote h2a bridge`): connect the LOCAL h2a agent network — a
 * file store under ~/h2a-workspace/.h2a where agents exchange JSON envelopes
 * by dropping them into inbox/<instance-dir>/ — with a remote session Pod, so
 * the Pod's agent is reachable/wakeable from the local bus and vice versa.
 *
 * Everything rides `kubectl exec` against the configured tunnel (same pattern
 * as soft-refresh/sync), base64 on the wire — encoded exactly ONCE per
 * direction, never double-encoded. Two flows per pass:
 *
 *  PULL  Pod → local: envelopes the Pod's agent EMITTED toward non-Pod
 *        instances (every Pod inbox/<dir>/ except the Pod's own instances')
 *        land in the same-named local inbox dir.
 *  PUSH  local → Pod: envelopes locally addressed TO the Pod's instances
 *        (local inbox/<pod-instance-dir>/) land in the Pod's inbox.
 *
 * Idempotent by FILE NAME: a file that already exists on the destination is
 * skipped — never overwritten. The bridge NEVER deletes anything on either
 * side: acks/cleanup belong to h2a itself, the bridge is transport only.
 *
 * The Pod's instances are the union of a default mapping
 * `<tool>:remote:<sessionId>` (tool from the session profile) and whatever is
 * registered in the Pod's own registry/instances.jsonl. Instance ids map to
 * inbox dir names by encoding ":" as "__" (h2a convention, e.g.
 * `claude:remote:abc123` → `claude__remote__abc123`).
 *
 * A Pod without ~/h2a-workspace/.h2a gets the skeleton (inbox/) plus a
 * README.md documenting the envelope-drop convention, so agents in the Pod
 * can participate by writing plain JSON files — no h2a binary required.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getTunnel, type TunnelConfig } from "./config.js";

/** h2a store root in the Pod, relative to $HOME (used as "$HOME/<this>"). */
export const H2A_POD_ROOT = "h2a-workspace/.h2a";

/** Local h2a store root (the agent network's shared filesystem). */
export function defaultLocalH2aRoot(): string {
  return join(homedir(), "h2a-workspace", ".h2a");
}

/** Inbox dir name for an instance id — h2a encodes ":" as "__" on disk. */
export function instanceInboxDir(instance: string): string {
  return instance.replace(/:/g, "__");
}

/**
 * Tool segment of the default Pod instance, from the session profile (same
 * mapping as the local registry's coerceRegistryTool; unknown profiles keep
 * their own name so the dir stays predictable).
 */
function profileTool(profile: string | undefined): string {
  switch (profile) {
    case "claude":
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    case "agy":
    case "antigravity":
      return "agy";
    case "gemini":
    case "mistral":
      return profile;
    default:
      return profile && profile.length > 0 ? profile : "claude";
  }
}

/** Default h2a instance id for a session Pod's agent: <tool>:remote:<sessionId>. */
export function defaultPodInstance(
  sessionId: string,
  profile?: string,
): string {
  return `${profileTool(profile)}:remote:${sessionId}`;
}

/**
 * Names embedded in kubectl-exec scripts are restricted to this shape (the
 * observed h2a convention: `claude__track__abc/env__...json`). Anything else
 * — path tricks, quotes, whitespace — is IGNORED, never executed.
 */
const SAFE_ENTRY =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

export type BridgeFile = { dir: string; file: string };

export type BridgePlan = {
  /** Pod → local: new envelopes the Pod's agent emitted toward non-Pod instances. */
  pull: BridgeFile[];
  /** local → Pod: new envelopes locally addressed to the Pod's instances. */
  push: BridgeFile[];
  /** Files already present on their destination — skipped, NEVER overwritten. */
  skipped: number;
  /** Entries with unsafe/malformed names, ignored entirely. */
  ignored: number;
};

/**
 * Pure sync plan: given the two inbox listings ("dir/file" entries) and the
 * set of inbox dirs owned by the Pod's instances, decide what moves where.
 * No deletion exists in the model — the plan can only copy or skip.
 */
export function planBridge(args: {
  podFiles: ReadonlyArray<string>;
  localFiles: ReadonlyArray<string>;
  podInstanceDirs: ReadonlySet<string>;
}): BridgePlan {
  const { podInstanceDirs } = args;
  const split = (entry: string): BridgeFile => {
    const slash = entry.indexOf("/");
    return { dir: entry.slice(0, slash), file: entry.slice(slash + 1) };
  };

  let skipped = 0;
  let ignored = 0;
  const podSet = new Set<string>();
  const pull: BridgeFile[] = [];
  const push: BridgeFile[] = [];

  for (const entry of args.podFiles) {
    if (!SAFE_ENTRY.test(entry)) {
      ignored += 1;
      continue;
    }
    podSet.add(entry);
  }
  const localSet = new Set<string>();
  for (const entry of args.localFiles) {
    if (!SAFE_ENTRY.test(entry)) {
      ignored += 1;
      continue;
    }
    localSet.add(entry);
  }

  // PULL: Pod inbox dirs that are NOT the Pod's own — outbound envelopes.
  for (const entry of podSet) {
    const f = split(entry);
    if (podInstanceDirs.has(f.dir)) continue; // the Pod's own inbox: inbound, not pulled
    if (localSet.has(entry)) skipped += 1;
    else pull.push(f);
  }

  // PUSH: local envelopes addressed to the Pod's instances.
  for (const entry of localSet) {
    const f = split(entry);
    if (!podInstanceDirs.has(f.dir)) continue;
    if (podSet.has(entry)) skipped += 1;
    else push.push(f);
  }

  return { pull, push, skipped, ignored };
}

/**
 * Parse the single listing exec's output: an `==INSTANCES==` section (one
 * registered instance id per line, from the Pod's registry/instances.jsonl)
 * then a `==FILES==` section ("dir/file" per line, relative to the Pod's
 * inbox/). Anything before the first marker (login-shell noise) is ignored.
 */
export function parsePodListing(out: string): {
  instances: string[];
  files: string[];
} {
  const instances: string[] = [];
  const files: string[] = [];
  let section: "none" | "instances" | "files" = "none";
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line === "==INSTANCES==") {
      section = "instances";
      continue;
    }
    if (line === "==FILES==") {
      section = "files";
      continue;
    }
    if (line.length === 0) continue;
    if (section === "instances") instances.push(line);
    else if (section === "files") files.push(line);
  }
  return { instances, files };
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Exec a bash -lc script in the session-agent container. Throws on non-zero. */
function execPod(
  tunnel: TunnelConfig,
  pod: string,
  script: string,
  input?: string,
): string {
  const args = ["-n", tunnel.namespace, "exec"];
  if (input !== undefined) args.push("-i");
  args.push(pod, "-c", "session-agent", "--", "bash", "-lc", script);
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  const r = spawnSync("kubectl", args, {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  if (r.status !== 0) {
    // stderr only (kubectl/bash diagnostics) — never envelope content.
    throw new Error(
      `kubectl exec failed: ${(r.stderr || "").trim().slice(0, 200)}`,
    );
  }
  return r.stdout;
}

/**
 * README dropped in the Pod when the skeleton is created: documents the
 * envelope-drop convention so agents in the Pod can join the h2a network by
 * writing plain JSON files, with no h2a binary installed.
 */
function podReadme(podInboxDir: string): string {
  return [
    "# h2a store (bridged)",
    "",
    "This directory is an h2a file store kept in sync with the operator's",
    "local ~/h2a-workspace/.h2a by `remote h2a bridge` (no h2a binary needed",
    "in this Pod).",
    "",
    "To MESSAGE another agent, write a JSON envelope",
    '  { "protocol": "sentropic.h2a", "version": "0.1", "id": "env:<ts>:<slug>",',
    '    "type": "event", "actor": { "instance", "role", "scope" }, "body", "createdAt" }',
    "to inbox/<instance-dir>/env__<ts>__<slug>.json, where <instance-dir> is",
    'the target instance id with ":" replaced by "__"',
    "(claude:track:abc -> claude__track__abc).",
    "",
    `Your own inbox is inbox/${podInboxDir}/ — check it for new envelopes.`,
    "The bridge never deletes files; acks/cleanup belong to h2a on the local",
    "side. Existing file names are never overwritten.",
    "",
  ].join("\n");
}

export type H2aBridgeOptions = {
  /** Session profile (claude/codex/…) for the default Pod instance mapping. */
  profile?: string;
  /** Local h2a store root (default ~/h2a-workspace/.h2a; tests: a scratch dir). */
  localRoot?: string;
  stderr?: NodeJS.WriteStream;
};

export type H2aBridgeResult = {
  sessionId: string;
  /** New envelopes copied Pod → local. */
  pulled: number;
  /** New envelopes copied local → Pod. */
  pushed: number;
  /** Already-present (or destination-existing) files left untouched. */
  skipped: number;
  /** Per-file transfer errors (the pass continues; details on stderr). */
  failed: number;
  /** true when the Pod's ~/h2a-workspace/.h2a skeleton was created this pass. */
  scaffolded: boolean;
  /** Inbox dirs treated as the Pod's own (push targets, excluded from pull). */
  podInstanceDirs: string[];
};

/** List local inbox entries as "dir/file" (missing store = empty listing). */
function listLocalInbox(localRoot: string): string[] {
  const inbox = join(localRoot, "inbox");
  if (!existsSync(inbox)) return [];
  const entries: string[] = [];
  for (const dir of readdirSync(inbox, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(inbox, dir.name), {
      withFileTypes: true,
    })) {
      if (f.isFile() && f.name.endsWith(".json"))
        entries.push(`${dir.name}/${f.name}`);
    }
  }
  return entries;
}

/**
 * One bridge pass for a session Pod: scaffold the Pod store if missing, list
 * both sides, then PULL new Pod-emitted envelopes and PUSH new locally
 * addressed ones. Returns counters only — envelope content is transferred
 * verbatim but never printed.
 */
export async function bridgeSession(
  sessionId: string,
  options: H2aBridgeOptions = {},
): Promise<H2aBridgeResult> {
  const stderr = options.stderr ?? process.stderr;
  const tunnel = getTunnel();
  if (!tunnel) {
    throw new Error(
      "h2a bridge needs a tunnel configured (remote config tunnel …)",
    );
  }
  const pod = `session-${sessionId}`;
  const localRoot = options.localRoot ?? defaultLocalH2aRoot();
  const podInbox = `$HOME/${H2A_POD_ROOT}/inbox`;
  const defaultDir = instanceInboxDir(
    defaultPodInstance(sessionId, options.profile),
  );

  // 1. Pod skeleton: create inbox/ + README on first contact, so Pod agents
  // can drop envelopes even without the h2a binary. Never touches an existing
  // store.
  const scaffold = execPod(
    tunnel,
    pod,
    [
      `root="$HOME/${H2A_POD_ROOT}"`,
      `if [ -d "$root/inbox" ]; then echo h2a-store-exists; else`,
      `mkdir -p "$root/inbox/${defaultDir}"`,
      `cat > "$root/README.md" <<'H2ADOC'`,
      podReadme(defaultDir),
      `H2ADOC`,
      `echo h2a-store-created`,
      `fi`,
    ].join("\n"),
  );
  const scaffolded = scaffold.includes("h2a-store-created");

  // 2. One listing exec: the Pod's registered instances + its inbox files.
  const listing = parsePodListing(
    execPod(
      tunnel,
      pod,
      [
        `cd "$HOME/${H2A_POD_ROOT}" 2>/dev/null || exit 0`,
        `echo ==INSTANCES==`,
        `sed -n 's/.*"instance"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' registry/instances.jsonl 2>/dev/null`,
        `echo ==FILES==`,
        `shopt -s nullglob`,
        `for f in inbox/*/*.json; do printf '%s\\n' "\${f#inbox/}"; done`,
      ].join("\n"),
    ),
  );

  const podInstanceDirs = new Set<string>([defaultDir]);
  for (const instance of listing.instances) {
    podInstanceDirs.add(instanceInboxDir(instance));
  }

  // 3. Plan: pure decision over the two listings.
  const plan = planBridge({
    podFiles: listing.files,
    localFiles: listLocalInbox(localRoot),
    podInstanceDirs,
  });
  if (plan.ignored > 0) {
    stderr.write(
      `[remote] h2a bridge ${sessionId}: ignored ${plan.ignored} unsafe inbox entry name(s)\n`,
    );
  }

  let pulled = 0;
  let pushed = 0;
  let skipped = plan.skipped;
  let failed = 0;

  // 4. PULL Pod → local (encoded ONCE in the Pod, decoded ONCE here).
  for (const f of plan.pull) {
    const dst = join(localRoot, "inbox", f.dir, f.file);
    if (existsSync(dst)) {
      skipped += 1; // appeared since the listing — never overwrite
      continue;
    }
    try {
      const b64 = execPod(
        tunnel,
        pod,
        `base64 < "${podInbox}/${f.dir}/${f.file}" | tr -d '\\n'`,
      );
      mkdirSync(join(localRoot, "inbox", f.dir), { recursive: true });
      writeFileSync(dst, Buffer.from(b64.trim(), "base64"));
      pulled += 1;
    } catch (error) {
      failed += 1;
      stderr.write(
        `[remote] h2a bridge ${sessionId}: pull ${f.dir}/${f.file} failed: ${String(
          error instanceof Error ? error.message : error,
        ).slice(0, 160)}\n`,
      );
    }
  }

  // 5. PUSH local → Pod (encoded ONCE here, decoded ONCE in the Pod; the Pod
  // side re-checks existence so a racing writer is never overwritten).
  for (const f of plan.push) {
    const src = join(localRoot, "inbox", f.dir, f.file);
    try {
      const payload = readFileSync(src).toString("base64");
      const out = execPod(
        tunnel,
        pod,
        [
          `d="${podInbox}/${f.dir}"; f="$d/${f.file}"`,
          `mkdir -p "$d"`,
          `if [ -e "$f" ]; then echo h2a-exists; else base64 -d > "$f" && echo h2a-written; fi`,
        ].join("\n"),
        payload,
      );
      if (out.includes("h2a-written")) pushed += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      stderr.write(
        `[remote] h2a bridge ${sessionId}: push ${f.dir}/${f.file} failed: ${String(
          error instanceof Error ? error.message : error,
        ).slice(0, 160)}\n`,
      );
    }
  }

  return {
    sessionId,
    pulled,
    pushed,
    skipped,
    failed,
    scaffolded,
    podInstanceDirs: [...podInstanceDirs].sort(),
  };
}
