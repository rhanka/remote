/**
 * Soft credential refresh: push fresh local creds INTO a running session Pod and
 * relaunch the CLI in place — WITHOUT recreating the Pod (keeps HOME parity, the
 * conversation, the node, no image pull). Fixes the recurring ~8h token logout
 * (the CLI can't self-refresh OAuth in a headless Pod). Also patches the auth
 * Secret so the fresh token survives a future Pod restart.
 *
 * Steps (all via kubectl against the configured tunnel):
 *  1. materialize each bundled cred file into $HOME/<rel> in the Pod,
 *  2. patch session-<id>-auth Secret keys (durability),
 *  3. respawn the Pod's tmux `main` pane: `<cli> --resume <newestConv>` with a
 *     UTF-8 locale, dropping to a shell on exit (never kills the session).
 *
 * Unchanged-creds gating (`skipIfUnchanged`, used by `refresh --all/--watch`):
 * the respawn INTERRUPTS the Pod's CLI, so it must only happen when the pushed
 * creds actually differ. We sha256 the bundle and compare it with the previous
 * pass (`previousHash`, in-memory --watch state) and with the hash recorded in
 * the Pod ($HOME/.remote-creds.sha256, written after every push). Identical
 * creds = silent no-op: nothing pushed, no Secret patch, NO respawn.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { collectProfileAuth } from "./auth-bundle.js";
import { collectToolAuth, localCredsExistFor } from "./auth-tools.js";
import { getTunnel, type TunnelConfig } from "./config.js";
import {
  buildHealthProbeCommand,
  isProbeableTool,
  parseHealthResult,
  type HealthResult,
  type ProbeableTool,
} from "./cred-health.js";

/** Secret data key for a HOME-relative cred path (matches the orchestrator). */
function credentialSecretKey(rel: string): string {
  return rel.replace(/^\.+/, "").replace(/\//g, "_");
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function kubeEnv(tunnel: TunnelConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  return env;
}

/** Run kubectl, optionally piping `input` to stdin. Throws on non-zero. */
function kubectl(
  tunnel: TunnelConfig,
  args: ReadonlyArray<string>,
  input?: string,
): string {
  const r = spawnSync("kubectl", ["-n", tunnel.namespace, ...args], {
    encoding: "utf8",
    env: kubeEnv(tunnel),
    ...(input !== undefined ? { input } : {}),
  });
  if (r.status !== 0) {
    throw new Error(
      `kubectl ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`,
    );
  }
  return r.stdout;
}

/** Exec a bash -lc script in the session-agent container. */
function execPod(
  tunnel: TunnelConfig,
  pod: string,
  script: string,
  input?: string,
): string {
  const base = ["exec"];
  if (input !== undefined) base.push("-i");
  return kubectl(
    tunnel,
    [...base, pod, "-c", "session-agent", "--", "bash", "-lc", script],
    input,
  );
}

/**
 * Exec a tool's argv DIRECTLY in the session-agent container — NO `bash -lc`
 * string-concat (the argv comes from `buildHealthProbeCommand`, static tokens
 * only). Returns the exit code + stdout; NEVER throws (a non-zero exit IS the
 * 401 signal we want to read). Used by the additive pod-side health probe.
 */
function execPodArgv(
  tunnel: TunnelConfig,
  pod: string,
  argv: ReadonlyArray<string>,
): { status: number; stdout: string } {
  const r = spawnSync(
    "kubectl",
    ["-n", tunnel.namespace, "exec", pod, "-c", "session-agent", "--", ...argv],
    { encoding: "utf8", env: kubeEnv(tunnel) },
  );
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** `<cli> --resume <id>` per profile, when the profile has a verified resume form. */
function resumeCommand(profile: string, convId: string): string | undefined {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  switch (profile) {
    case "codex":
      return `codex resume ${q(convId)}`;
    case "agy":
    case "antigravity":
      return `agy --resume ${q(convId)}`;
    case "claude":
    case "claude-code":
      return `claude --resume ${q(convId)}`;
    default:
      return undefined;
  }
}

/** HOME-relative file in the Pod recording the sha256 of the last pushed bundle. */
export const CREDS_HASH_FILE = ".remote-creds.sha256";

/**
 * Bundle rels that are CONFIG, not credentials. They ride along on a push but
 * must NOT gate it: `.claude.json` is rewritten constantly by every running
 * local claude session (statsig/lastUsed churn), so hashing it would make
 * `--watch` respawn the Pod CLI on nearly every pass. Only the actual
 * credential files decide "changed".
 */
const CONFIG_ONLY_RELS: ReadonlySet<string> = new Set([
  ".claude.json",
  ".claude/settings.json",
  ".codex/config.toml",
  ".gemini/antigravity-cli/settings.json",
]);

/**
 * Deterministic sha256 of an auth bundle (profile + sorted rel -> base64 value),
 * SKIPPING config-only rels (see CONFIG_ONLY_RELS). Values stay opaque: the
 * hash never leaks any secret material.
 */
export function hashAuthBundle(
  profile: string,
  bundle: Readonly<Record<string, string>>,
): string {
  const h = createHash("sha256");
  h.update(profile);
  h.update("\0");
  for (const rel of Object.keys(bundle).sort()) {
    if (CONFIG_ONLY_RELS.has(rel)) continue;
    h.update(rel);
    h.update("\0");
    h.update(bundle[rel]!);
    h.update("\0");
  }
  return h.digest("hex");
}

export type SoftRefreshResult = {
  /** false = creds identical to the Pod's last push — nothing pushed, NO respawn. */
  changed: boolean;
  /** sha256 of the local bundle — feed back as `previousHash` on the next pass. */
  hash: string;
  filesPushed: string[];
  secretKeysPatched: string[];
  convId: string | undefined;
  respawned: boolean;
};

export type SoftRefreshOptions = {
  /**
   * Compare the bundle hash with `previousHash` and/or the hash recorded in the
   * Pod, and no-op (no push, no Secret patch, NO respawn) when identical.
   */
  skipIfUnchanged?: boolean;
  /** Bundle hash from the previous pass (in-memory --watch state): when it matches, skip without even reading the Pod. */
  previousHash?: string;
  stderr?: NodeJS.WriteStream;
};

/**
 * Push the profile's fresh creds into the Pod, patch the Secret, and relaunch
 * the CLI in place. `bundle` is the already-collected creds (rel -> content).
 */
export async function softRefreshSession(
  sessionId: string,
  profile: string,
  options: SoftRefreshOptions = {},
): Promise<SoftRefreshResult> {
  const stderr = options.stderr ?? process.stderr;
  const tunnel = getTunnel();
  if (!tunnel) {
    throw new Error(
      "soft refresh needs a tunnel configured (remote config tunnel …)",
    );
  }
  const pod = `session-${sessionId}`;
  const secret = `${pod}-auth`;

  const bundle = await collectProfileAuth(
    profile as Parameters<typeof collectProfileAuth>[0],
  );
  const rels = Object.keys(bundle);
  if (rels.length === 0) {
    throw new Error(`no local credentials found for profile "${profile}"`);
  }

  // 0. unchanged-creds gating: identical bundle = silent no-op WITHOUT respawn
  // (the respawn interrupts the Pod's CLI session — only worth it for new creds).
  const hash = hashAuthBundle(profile, bundle);
  if (options.skipIfUnchanged) {
    let podHash: string | undefined;
    if (options.previousHash === hash) {
      podHash = hash; // in-memory state matches: skip even the Pod read
    } else {
      try {
        podHash = execPod(
          tunnel,
          pod,
          `cat "$HOME/${CREDS_HASH_FILE}" 2>/dev/null || true`,
        ).trim();
      } catch {
        // Pod state unreadable — fall through; the push will surface the real error.
      }
    }
    if (podHash === hash) {
      // Creds unchanged — but if the Pod's CLI DIED (pane dropped to the
      // wrapper shell, e.g. it exited on a 401 before fresh creds landed),
      // "unchanged" must still bring the session back: respawn with the creds
      // already in place. Probe ONLY when we already read the Pod this pass
      // (previousHash mismatch): the in-memory watch match stays zero-I/O.
      let paneDead = false;
      let paneCmd = "";
      if (options.previousHash !== hash) {
        try {
          // The relaunch wrapper keeps the CLI as a CHILD of a bash script, so
          // pane_current_command alone reads "bash" even when claude is alive.
          // Dead = pane at bash/sh AND no child process (idle drop-to-shell).
          // /proc PPid scan because the runtime image has no ps/pgrep.
          const probe = execPod(
            tunnel,
            pod,
            `pp=$(tmux display -p -t main "#{pane_pid}" 2>/dev/null); ` +
              `cmd=$(tmux display -p -t main "#{pane_current_command}" 2>/dev/null); ` +
              `kids=$(awk -v p="$pp" '$1=="PPid:" && $2==p {c++} END{print c+0}' /proc/[0-9]*/status 2>/dev/null); ` +
              `echo "$cmd $kids"`,
          )
            .trim()
            .split(/\s+/);
          paneCmd = probe[0] ?? "";
          const kids = Number(probe[1] ?? "1") || 0;
          paneDead = (paneCmd === "bash" || paneCmd === "sh") && kids === 0;
        } catch {
          // tmux unreadable — treat as alive; the next changed-creds pass heals it.
        }
      }
      if (!paneDead) {
        return {
          changed: false,
          hash,
          filesPushed: [],
          secretKeysPatched: [],
          convId: undefined,
          respawned: false,
        };
      }
      stderr.write(
        `[remote] ${pod}: creds unchanged but the CLI is down (pane at ${paneCmd || "?"}) — respawning\n`,
      );
      const convId = detectNewestConversation(tunnel, pod);
      const respawned = convId
        ? respawnPane(tunnel, pod, profile, convId, stderr)
        : false;
      if (!convId) {
        stderr.write(`[remote] no conversation found to resume in ${pod}\n`);
      }
      return {
        changed: false,
        hash,
        filesPushed: [],
        secretKeysPatched: [],
        convId,
        respawned,
      };
    }
  }

  // 1. materialize each cred file into the Pod's HOME.
  const filesPushed: string[] = [];
  for (const rel of rels) {
    // collectProfileAuth already returns base64 — decode it ONCE into the file
    // (do NOT re-encode, or the file ends up containing base64 text).
    execPod(
      tunnel,
      pod,
      `mkdir -p "$(dirname "$HOME/${rel}")" && base64 -d > "$HOME/${rel}" && chmod 600 "$HOME/${rel}"`,
      bundle[rel]!,
    );
    filesPushed.push(rel);
  }
  stderr.write(
    `[remote] pushed ${filesPushed.length} cred file(s) into ${pod}\n`,
  );

  // Record the pushed bundle's hash in the Pod so future --all/--watch passes
  // can no-op (and NOT respawn) when the local creds haven't changed.
  try {
    execPod(tunnel, pod, `printf %s '${hash}' > "$HOME/${CREDS_HASH_FILE}"`);
  } catch (error) {
    stderr.write(
      `[remote] warn: could not record creds hash in Pod: ${String(error).slice(0, 120)}\n`,
    );
  }

  // 2. patch the Secret so the fresh creds survive a Pod restart.
  const secretKeysPatched: string[] = [];
  const runDir = join(
    process.env.XDG_RUNTIME_DIR ??
      join(homedir(), ".config", "sentropic", "remote-cli"),
    "sentropic-remote-run",
  );
  mkdirSync(runDir, { recursive: true });
  let patchN = 0;
  for (const rel of rels) {
    const key = credentialSecretKey(rel);
    // Secret data values ARE base64, and collectProfileAuth already returns
    // base64 — use it as-is (do NOT re-encode).
    // Patch via a temp --patch-file so large creds (the full account file) don't
    // blow the command-line length limit (inline -p) nor hit the spawn stdin
    // /dev/stdin quirk.
    const patchFile = join(runDir, `patch-${process.pid}-${patchN++}.json`);
    try {
      writeFileSync(
        patchFile,
        JSON.stringify({ data: { [key]: bundle[rel]! } }),
        "utf8",
      );
      kubectl(tunnel, [
        "patch",
        "secret",
        secret,
        "--type",
        "merge",
        "--patch-file",
        patchFile,
      ]);
      secretKeysPatched.push(key);
    } catch (error) {
      stderr.write(
        `[remote] warn: could not patch Secret key ${key}: ${String(error).slice(0, 120)}\n`,
      );
    } finally {
      rmSync(patchFile, { force: true });
    }
  }
  stderr.write(
    `[remote] patched ${secretKeysPatched.length} Secret key(s) (durable across restart)\n`,
  );

  // 3. detect the newest conversation in the Pod and respawn the CLI in tmux.
  const convId = detectNewestConversation(tunnel, pod);

  let respawned = false;
  if (convId) {
    respawned = respawnPane(tunnel, pod, profile, convId, stderr);
  } else {
    stderr.write(`[remote] creds pushed; no conversation found to resume\n`);
  }

  return {
    changed: true,
    hash,
    filesPushed,
    secretKeysPatched,
    convId,
    respawned,
  };
}

/** Newest conversation id present in the Pod (claude projects / codex rollouts). */
function detectNewestConversation(
  tunnel: TunnelConfig,
  pod: string,
): string | undefined {
  return execPod(
    tunnel,
    pod,
    `ls -t "$HOME"/.claude/projects/*/*.jsonl "$HOME"/.codex/sessions/**/*.jsonl 2>/dev/null | head -1 | xargs -r basename | sed 's/\\.jsonl$//; s/^rollout-//'`,
  )
    .trim()
    .split("\n")
    .filter(Boolean)[0];
}

/**
 * Write a relaunch script + respawn the durable tmux pane (drop-to-shell on
 * exit so the session is never killed). Single-quoted heredoc keeps it intact.
 */
function respawnPane(
  tunnel: TunnelConfig,
  pod: string,
  profile: string,
  convId: string,
  stderr: NodeJS.WriteStream,
): boolean {
  const resume = resumeCommand(profile, convId);
  if (!resume) {
    stderr.write(
      `[remote] creds pushed but ${profile} has no verified resume command for ${convId}; restart the CLI in the Pod manually\n`,
    );
    return false;
  }
  const script = [
    `cat > "$HOME/.remote-relaunch.sh" <<'RL'`,
    `#!/bin/bash`,
    `export LANG=C.UTF-8 LC_ALL=C.UTF-8`,
    `cd "$WORKSPACE_PATH" 2>/dev/null || true`,
    resume,
    `printf '\\n[remote] %s exited — shell.\\n' "$0"`,
    `exec bash -l`,
    `RL`,
    `chmod +x "$HOME/.remote-relaunch.sh"`,
    `tmux respawn-pane -t main -k "$HOME/.remote-relaunch.sh" 2>/dev/null && echo respawned || echo no-tmux`,
  ].join("\n");
  const out = execPod(tunnel, pod, script).trim();
  const respawned = out.endsWith("respawned");
  stderr.write(
    respawned
      ? `[remote] relaunched ${profile} (--resume ${convId}) in the Pod's tmux\n`
      : `[remote] creds pushed but no tmux 'main' to respawn — restart the CLI in the Pod manually\n`,
  );
  return respawned;
}

// ---------------------------------------------------------------------------
// Slice 2 — POD-SIDE 401 health probe → push-on-fail (ADDITIVE; gh/npm/docker).
//
// An EXTRA trigger, NOT a new mechanism: each watch pass, for each live pod, we
// run a cheap read-only probe (cred-health.buildHealthProbeCommand) for the
// covered tools; when one reports ok:false we RE-BUNDLE that tool's local creds
// (collectToolAuth — the established tool bundling) and materialize them into
// the Pod + patch the Secret using the IDENTICAL primitives the profile push
// uses (base64 -d > $HOME/<rel>; kubectl patch secret merge). It does NOT touch
// the profile push/hash path (softRefreshSession / hashAuthBundle /
// CREDS_HASH_FILE) and never implements a different overwrite rule — it pushes
// the LOCAL file to the Pod exactly as the current code does.
// ---------------------------------------------------------------------------

/** Result of a per-pod, per-tool probe→push pass. */
export type ToolHealthAction = {
  readonly tool: ProbeableTool;
  readonly health: HealthResult;
  /** true when ok:false drove a re-bundle+push of this tool's creds. */
  readonly pushed: boolean;
  /** HOME-relative files materialized into the Pod (empty when not pushed / none local). */
  readonly filesPushed: ReadonlyArray<string>;
  readonly secretKeysPatched: ReadonlyArray<string>;
};

/**
 * Injectable seams so the executor is unit-testable WITHOUT shelling out to
 * kubectl or reading ~/. Production defaults wire the real plumbing.
 */
export type ToolHealthDeps = {
  /** Run the argv-safe probe in the Pod (default: execPodArgv against the tunnel). */
  exec: (argv: ReadonlyArray<string>) => { status: number; stdout: string };
  /** Re-bundle the LOCAL creds for the tools (default: collectToolAuth). */
  collect: (
    tools: ReadonlyArray<string>,
  ) => Promise<{ bundle: Record<string, string>; bundled: string[] }>;
  /** Materialize one base64 file into the Pod's $HOME (default: execPod base64 -d). */
  materialize: (rel: string, base64: string) => void;
  /** Patch one Secret data key with a base64 value (default: kubectl patch). */
  patchSecretKey: (key: string, base64: string) => void;
  stderr?: { write: (s: string) => unknown };
};

/**
 * Probe ONE covered tool in a live Pod and, if it's unauthenticated, push the
 * tool's LOCAL creds (re-bundle + materialize + Secret patch — the same
 * mechanism as today, an extra trigger). Pure-ish: all IO is injected via
 * `deps`. Returns what happened (probe result + whether/what was pushed).
 * Exported for tests.
 */
export async function probeAndPushToolHealth(
  tool: ProbeableTool,
  deps: ToolHealthDeps,
): Promise<ToolHealthAction> {
  const stderr = deps.stderr ?? { write: () => true };
  const probe = deps.exec(buildHealthProbeCommand(tool));
  const health = parseHealthResult(tool, probe.status, probe.stdout);
  if (health.ok) {
    return {
      tool,
      health,
      pushed: false,
      filesPushed: [],
      secretKeysPatched: [],
    };
  }
  // ok:false → re-bundle + push this tool's LOCAL creds (same path as today).
  // Tool/status only — NEVER a secret value.
  stderr.write(
    `[remote] pod 401: ${health.reason} — pushing fresh ${tool} creds\n`,
  );
  const { bundle } = await deps.collect([tool]);
  const rels = Object.keys(bundle);
  const filesPushed: string[] = [];
  const secretKeysPatched: string[] = [];
  for (const rel of rels) {
    deps.materialize(rel, bundle[rel]!);
    filesPushed.push(rel);
    const key = credentialSecretKey(rel);
    deps.patchSecretKey(key, bundle[rel]!);
    secretKeysPatched.push(key);
  }
  if (filesPushed.length === 0) {
    stderr.write(
      `[remote] no local ${tool} creds to push — run \`${tool} login\` locally\n`,
    );
  }
  return {
    tool,
    health,
    pushed: filesPushed.length > 0,
    filesPushed,
    secretKeysPatched,
  };
}

/**
 * Production wiring for `probeAndPushToolHealth` against a configured tunnel +
 * live pod. Builds the default `ToolHealthDeps` (real kubectl exec / patch /
 * collectToolAuth) and probes EACH covered tool, pushing on a 401. Best-effort:
 * a probe/push error for one tool is logged and the others continue. Returns the
 * per-tool actions. NOT pure (does IO); the pure decision lives in
 * `probeAndPushToolHealth` + cred-health. Used by the watch loop.
 */
export async function probePodCredHealth(
  sessionId: string,
  tools: ReadonlyArray<string> = ["gh", "npm", "docker"],
  options: { stderr?: NodeJS.WriteStream } = {},
): Promise<ToolHealthAction[]> {
  const stderr = options.stderr ?? process.stderr;
  const tunnel = getTunnel();
  if (!tunnel)
    throw new Error("pod cred health probe needs a tunnel configured");
  const pod = `session-${sessionId}`;
  const secret = `${pod}-auth`;

  const runDir = join(
    process.env.XDG_RUNTIME_DIR ??
      join(homedir(), ".config", "sentropic", "remote-cli"),
    "sentropic-remote-run",
  );

  const deps: ToolHealthDeps = {
    exec: (argv) => execPodArgv(tunnel, pod, argv),
    collect: (t) => collectToolAuth(t),
    materialize: (rel, base64) => {
      execPod(
        tunnel,
        pod,
        `mkdir -p "$(dirname "$HOME/${rel}")" && base64 -d > "$HOME/${rel}" && chmod 600 "$HOME/${rel}"`,
        base64,
      );
    },
    patchSecretKey: (key, base64) => {
      mkdirSync(runDir, { recursive: true });
      const patchFile = join(runDir, `tool-patch-${process.pid}-${key}.json`);
      try {
        writeFileSync(
          patchFile,
          JSON.stringify({ data: { [key]: base64 } }),
          "utf8",
        );
        kubectl(tunnel, [
          "patch",
          "secret",
          secret,
          "--type",
          "merge",
          "--patch-file",
          patchFile,
        ]);
      } finally {
        rmSync(patchFile, { force: true });
      }
    },
    stderr,
  };

  const actions: ToolHealthAction[] = [];
  for (const tool of tools) {
    if (!isProbeableTool(tool)) continue;
    // GUARD (slice-2 regression fix): only probe/push a tool when the LOCAL
    // machine actually has non-empty creds for it. With no local creds, pushing
    // is pointless — the Pod's probe stays 401 and the next pass repeats the same
    // useless push forever. No local creds → skip ENTIRELY (no probe, no push, no
    // log). Tools WITH valid local creds are byte-identical to before.
    if (!localCredsExistFor(tool)) continue;
    try {
      actions.push(await probeAndPushToolHealth(tool, deps));
    } catch (error) {
      stderr.write(
        `[remote] ${pod}: ${tool} health probe/push errored: ${String(error).slice(0, 120)}\n`,
      );
    }
  }
  return actions;
}
