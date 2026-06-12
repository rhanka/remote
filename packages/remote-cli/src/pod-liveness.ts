/**
 * Shared, DEFENSIVE pod-liveness guard for the watch loops (ADDITIVE).
 *
 * The `refresh --soft --all --watch` creds loop and the `h2a bridge --watch`
 * loop both `kubectl exec` into every live session Pod each pass. When a Pod is
 * Evicted/OOM-killed (phase=Failed) or has completed (phase=Succeeded), every
 * exec fails with `cannot exec into a container in a completed pod; current
 * phase is Failed`, so the loops hammer the dead Pod and log a per-pass error.
 *
 * This guard lets each loop CHEAPLY ask the Pod's phase ONCE per pass (one
 * `kubectl get pod -o jsonpath={.status.phase}`) and SKIP the Pod entirely when
 * it is not Running — emitting a single concise advisory instead of a cascade of
 * exec errors. Healthy Running Pods are byte-identical: the guard returns
 * executable=true and the loop proceeds exactly as before.
 *
 * The PURE decision (`isExecutablePhase`) is split from the thin executor
 * (`podPhase`) so tests never shell out.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TunnelConfig } from "./config.js";

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function kubeEnv(tunnel: TunnelConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  return env;
}

/**
 * Is a Pod in `phase` safe to `kubectl exec` into? ONLY `Running` is. Anything
 * else — `Pending`, `Failed` (Evicted/OOM, exit 137), `Succeeded` (completed),
 * `Unknown`, an empty string (NotFound / unreadable), or any future phase — is
 * NOT executable: exec'ing would error per-pass. PURE, exported for tests.
 */
export function isExecutablePhase(phase: string | undefined): boolean {
  return phase === "Running";
}

/**
 * Read ONE Pod's `.status.phase` via a single cheap `kubectl get pod`. Returns
 * the phase string (e.g. "Running", "Failed", "Succeeded", "Pending"), or "" on
 * any failure (NotFound, no permission, unreachable API) — "" is NOT executable,
 * the safe default. NEVER throws: the watch loops must keep going. Thin executor
 * — the decision lives in `isExecutablePhase`.
 */
export function podPhase(tunnel: TunnelConfig, pod: string): string {
  const r = spawnSync(
    "kubectl",
    [
      "-n",
      tunnel.namespace,
      "get",
      "pod",
      pod,
      "-o",
      "jsonpath={.status.phase}",
    ],
    { encoding: "utf8", env: kubeEnv(tunnel) },
  );
  if (r.status !== 0) return "";
  return (r.stdout ?? "").trim();
}

/**
 * One-line, secret-free advisory for a non-Running Pod a watch loop is skipping
 * this pass. PURE, exported for tests. `phase` "" (NotFound/unreadable) reads as
 * "gone".
 */
export function deadPodAdvisory(sessionId: string, phase: string): string {
  const shown = phase || "gone";
  return `[remote] session ${sessionId}: pod ${shown} — skipping (evicted/dead)`;
}

/**
 * Convenience for the watch loops: read the phase and decide in one call.
 * Returns `{ phase, executable }`. The loop logs `deadPodAdvisory` and continues
 * when `!executable`, otherwise execs exactly as before. Thin (does IO); pure
 * decision is `isExecutablePhase`.
 */
export function checkPodLiveness(
  tunnel: TunnelConfig,
  pod: string,
): { phase: string; executable: boolean } {
  const phase = podPhase(tunnel, pod);
  return { phase, executable: isExecutablePhase(phase) };
}
