/**
 * `remote plugin sync-skills` — propagate the LOCAL user's Claude Code skills
 * and plugin state into each live session Pod's `$HOME/.claude/`, so delegated /
 * remote claude sessions get the same capabilities (superpowers, track, h2a,
 * graphify, sent-tech-design, …) the operator has locally.
 *
 * APPROACH — "copy the resolved cache" (the chosen DEFAULT). We tar a short,
 * explicit WHITELIST of skill+plugin paths and untar it into the Pod. This is
 * deterministic: the Pod gets byte-for-byte the same resolved plugin cache the
 * operator already vetted locally, with no network/marketplace fetch in-Pod.
 *   Reversible fork (NOT implemented — documented for the conductor): instead of
 *   shipping the cache, re-install marketplaces in-Pod (`claude plugin
 *   marketplace add … && claude plugin install …`). That re-resolves remotely
 *   (non-deterministic, needs network + auth in the Pod) and is therefore the
 *   non-default. If we ever want it, it slots in as an alternate plan builder
 *   here; the CLI surface stays the same.
 *
 * CRITICAL SAFETY — we NEVER tar the whole `~/.claude` (it holds settings.json,
 * .credentials.json, OAuth tokens, project transcripts under projects/, and
 * ~/.claude.json). Only the four paths in SKILLS_SYNC_WHITELIST are archived,
 * each a leaf path so no broader directory can sweep a secret in with it. The
 * SAFETY tests assert no credential/transcript path is ever a tar member.
 *
 * Payloads are argv ARRAYS (tar argv, kubectl argv) — never a `bash -lc` string
 * with interpolated paths — so a $HOME (or any path) with shell metacharacters
 * is just a single argument, never a parsed shell word. The archive itself
 * rides stdin (`kubectl exec -i … -- tar -x`), so no file content is ever
 * interpolated either.
 *
 * Idempotent: re-running untars over the existing tree (`--overwrite`), so the
 * Pod's skills/plugins converge to the local state on every run.
 */

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { listRemoteSessions } from "./attach.js";
import { getTunnel, type TunnelConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * The ONLY paths synced to Pods, relative to `$HOME`. Skills dir + the three
 * plugin-state pieces that make the resolved plugin cache deterministic. Each
 * is a leaf path: no entry is a parent of a secret file (so tarring it can
 * never drag settings.json / .credentials.json / transcripts along). Anything
 * outside this list — including the rest of ~/.claude/plugins (blocklist.json,
 * known_marketplaces.json, plugin-catalog-cache.json, data/) — is excluded.
 */
export const SKILLS_SYNC_WHITELIST: readonly string[] = [
  ".claude/skills",
  ".claude/plugins/installed_plugins.json",
  ".claude/plugins/marketplaces",
  ".claude/plugins/cache",
];

/** The explicit whitelist as a fresh array (callers cannot mutate the source). */
export function skillsSyncWhitelist(): string[] {
  return [...SKILLS_SYNC_WHITELIST];
}

/**
 * `tar` argv that archives ONLY the whitelisted paths, relative to `$HOME`, as
 * a gzip stream on stdout (`-f -`). `-C <home>` keeps members relative so they
 * untar cleanly into the Pod's `$HOME`. `--ignore-failed-read` lets a partial
 * local install still sync (a missing member is skipped, not fatal). Members
 * follow `--` so a leading-dash path can never be mistaken for a flag.
 */
export function buildSkillsTarArgs(home: string): string[] {
  return [
    "-c",
    "-z",
    "--ignore-failed-read",
    "-C",
    home,
    "-f",
    "-",
    "--",
    ...skillsSyncWhitelist(),
  ];
}

/**
 * In-Pod `tar` argv: extract the gzip stream from stdin (`-f -`) into the Pod's
 * `$HOME` (`-C <podHome>`), `--overwrite` so a re-run replaces the existing
 * skills/plugins in place (idempotent). No member is named — extraction takes
 * whatever the archive carries, and the archive only ever carries the
 * whitelist (constrained on the tar side).
 */
export function buildPodUntarArgs(podHome: string): string[] {
  return ["-x", "-z", "--overwrite", "-C", podHome, "-f", "-"];
}

/** A live session resolved to a Pod target for the skills sync. */
export type SyncPod = {
  sessionId: string;
  profile: string;
  /** Pod `$HOME` (extraction root); defaults to /root (session-agent runs as root). */
  podHome?: string;
};

/** Default Pod `$HOME` — the session-agent container runs as root. */
const DEFAULT_POD_HOME = "/root";

export type SkillsSyncPlan = {
  /** The Pod name (`session-<id>`). */
  pod: string;
  sessionId: string;
  profile: string;
  /** Local archive command: `tar <args>` writing gzip to stdout. */
  tar: { cmd: "tar"; args: string[] };
  /** In-Pod extraction command: `tar <args>` reading gzip from stdin. */
  untar: { cmd: "tar"; args: string[] };
  /** The whitelist actually transferred (for the recap / dry-run). */
  whitelist: string[];
  /** One-line human-readable plan for `--dry-run` (transfers nothing). */
  dryRun: string;
};

/**
 * Compose the local-tar | pod-untar plan for one Pod. Pure: it builds the two
 * argv arrays and a dry-run line, but spawns nothing — the actual transfer is
 * behind the `runSkillsSync` seam so tests never shell out.
 */
export function buildSkillsSyncPlan(input: {
  home: string;
  pod: SyncPod;
}): SkillsSyncPlan {
  const { home, pod } = input;
  const podHome = pod.podHome ?? DEFAULT_POD_HOME;
  const tarArgs = buildSkillsTarArgs(home);
  const untarArgs = buildPodUntarArgs(podHome);
  const podName = `session-${pod.sessionId}`;
  const dryRun =
    `${podName} (${pod.profile}): tar ${tarArgs.join(" ")} ` +
    `| kubectl exec -i ${podName} -- tar ${untarArgs.join(" ")} ` +
    `[whitelist: ${skillsSyncWhitelist().join(", ")}]`;
  return {
    pod: podName,
    sessionId: pod.sessionId,
    profile: pod.profile,
    tar: { cmd: "tar", args: tarArgs },
    untar: { cmd: "tar", args: untarArgs },
    whitelist: skillsSyncWhitelist(),
    dryRun,
  };
}

/**
 * Resolve which live sessions to sync. `--all` => every session; `--pod <ref>`
 * => the single session whose id (or `session-<id>` Pod name) matches. Throws
 * when neither is given, or when `--pod` matches nothing live.
 */
export function selectSyncPods(
  sessions: ReadonlyArray<{ id: string; profile: string }>,
  opts: { pod?: string; all?: boolean },
): SyncPod[] {
  if (opts.all) {
    return sessions.map((s) => ({ sessionId: s.id, profile: s.profile }));
  }
  if (opts.pod) {
    const id = opts.pod.startsWith("session-")
      ? opts.pod.slice("session-".length)
      : opts.pod;
    const match = sessions.find((s) => s.id === id);
    if (!match) {
      throw new Error(`no live session matches --pod "${opts.pod}"`);
    }
    return [{ sessionId: match.id, profile: match.profile }];
  }
  throw new Error("select sessions with --pod <name> or --all");
}

// ---------------------------------------------------------------------------
// Spawn seam (thin — tests stub this, never shell out)
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function kubeEnv(tunnel: TunnelConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  return env;
}

/**
 * Pipe `tar <tarArgs>` (local) → `kubectl exec -i <pod> -- tar <untarArgs>`
 * (Pod). Both ends are pure argv arrays; the gzip archive rides the pipe on
 * stdin so no path/content is ever interpolated into a shell. Resolves on a
 * clean (0/0) exit of both processes, rejects with the first non-zero status.
 */
export type SkillsSyncRunner = (
  plan: SkillsSyncPlan,
  tunnel: TunnelConfig,
) => Promise<void>;

const spawnSkillsSync: SkillsSyncRunner = (plan, tunnel) =>
  new Promise<void>((resolve, reject) => {
    const kubectlArgs = [
      "-n",
      tunnel.namespace,
      "exec",
      "-i",
      plan.pod,
      "-c",
      "session-agent",
      "--",
      plan.untar.cmd,
      ...plan.untar.args,
    ];
    const env = kubeEnv(tunnel);
    const tar = spawn(plan.tar.cmd, plan.tar.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const kube = spawn("kubectl", kubectlArgs, {
      stdio: ["pipe", "inherit", "pipe"],
      env,
    });
    let tarErr = "";
    let kubeErr = "";
    tar.stderr.on("data", (d: Buffer) => {
      tarErr += d.toString();
    });
    kube.stderr.on("data", (d: Buffer) => {
      kubeErr += d.toString();
    });
    tar.on("error", reject);
    kube.on("error", reject);
    tar.stdout.pipe(kube.stdin);

    let tarDone = false;
    let kubeDone = false;
    let failed = false;
    const settle = () => {
      if (tarDone && kubeDone && !failed) resolve();
    };
    tar.on("close", (code) => {
      tarDone = true;
      if (code !== 0 && !failed) {
        failed = true;
        reject(new Error(`tar exited ${code}: ${tarErr.trim().slice(0, 200)}`));
        return;
      }
      settle();
    });
    kube.on("close", (code) => {
      kubeDone = true;
      if (code !== 0 && !failed) {
        failed = true;
        reject(
          new Error(`kubectl exec ${plan.pod} exited ${code}: ${kubeErr.trim().slice(0, 200)}`),
        );
        return;
      }
      settle();
    });
  });

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `remote plugin sync-skills [--pod <name>|--all] [--dry-run]` — copy the local
 * Claude Code skills + plugin cache (whitelist only) into the selected live
 * session Pod(s). `--dry-run` prints the tar/exec plan and transfers nothing.
 */
export async function syncSkills(
  url: string,
  opts: { pod?: string; all?: boolean; dryRun?: boolean },
  stderr: NodeJS.WriteStream = process.stderr,
  run: SkillsSyncRunner = spawnSkillsSync,
): Promise<void> {
  const tunnel = getTunnel();
  if (!tunnel) {
    throw new Error(
      "plugin sync-skills needs a tunnel configured (remote config tunnel …)",
    );
  }
  const sessions = await listRemoteSessions(url);
  if (sessions.length === 0) {
    stderr.write("[remote] no live remote sessions to sync\n");
    return;
  }
  const pods = selectSyncPods(sessions, opts);
  const home = homedir();

  if (opts.dryRun) {
    stderr.write(
      `[remote] sync-skills DRY-RUN — whitelist (relative to $HOME): ${skillsSyncWhitelist().join(", ")}\n`,
    );
    for (const pod of pods) {
      stderr.write(`    ${buildSkillsSyncPlan({ home, pod }).dryRun}\n`);
    }
    stderr.write("[remote] dry-run: nothing transferred\n");
    return;
  }

  // Fail fast if local tar is missing (clearer than a spawn ENOENT mid-loop).
  if (spawnSync("tar", ["--version"], { stdio: "ignore" }).status !== 0) {
    throw new Error("local `tar` not found — required to archive the skills cache");
  }

  let failures = 0;
  for (const pod of pods) {
    const plan = buildSkillsSyncPlan({ home, pod });
    stderr.write(`[remote] ${plan.sessionId} (${plan.profile}): sync-skills…\n`);
    try {
      await run(plan, tunnel);
      stderr.write(
        `    skills/plugins synced (${plan.whitelist.length} whitelist path(s)) -> ${plan.pod}:$HOME\n`,
      );
    } catch (error) {
      failures++;
      stderr.write(`    sync-skills FAILED: ${String(error).slice(0, 200)}\n`);
    }
  }
  stderr.write(
    `[remote] sync-skills done: ${pods.length} pod(s)${failures > 0 ? `, ${failures} failure(s)` : ""}\n`,
  );
  if (failures > 0) process.exitCode = 1;
}
