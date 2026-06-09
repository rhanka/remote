/**
 * `remote forward` — expose a port of a session Pod on the local machine via
 * `kubectl port-forward`. This is the low-level transport that serves the
 * `uat-expose` capability (see protocol `uat-exposure-policy`): it lets you reach
 * any web UI running inside a session Pod (a mail/UAT control UI, a dev server…)
 * at http://localhost:<localPort>.
 *
 * The forward runs in the FOREGROUND until Ctrl-C (unlike the control-plane
 * tunnel in tunnel.ts, which is a detached, pidfile-managed background child):
 * here the user explicitly wants a live, visible session they tear down by hand.
 *
 * Pure, unit-tested helpers (no I/O) build the kubectl argv and the local URL;
 * the impure runner wires them to a child process + SIGINT.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { getTunnel, type TunnelConfig } from "./config.js";
import { listRemoteSessions } from "./attach.js";

/** A leading ~ is expanded to the user's home dir (matches tunnel.ts/sync.ts). */
export function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Pod name for a session id (matches the orchestrator: `session-<id>`). */
export function sessionPodName(sessionId: string): string {
  return `session-${sessionId}`;
}

/**
 * `localPort:podPort` when a local port is given, else just `podPort` — kubectl
 * then picks a free local port equal to (or, if taken, near) the pod port.
 */
export function portMapping(podPort: number, localPort?: number): string {
  return localPort === undefined ? String(podPort) : `${localPort}:${podPort}`;
}

/**
 * Build the `kubectl port-forward` argv (without the leading "kubectl").
 * Pure so it can be asserted in tests without touching the cluster.
 */
export function buildPortForwardArgs(args: {
  namespace: string;
  sessionId: string;
  podPort: number;
  localPort?: number;
  address?: string;
}): string[] {
  const { namespace, sessionId, podPort, localPort, address } = args;
  return [
    "-n",
    namespace,
    "port-forward",
    `--address=${address ?? "127.0.0.1"}`,
    `pod/${sessionPodName(sessionId)}`,
    portMapping(podPort, localPort),
  ];
}

/** Local URL the user can open once the forward is up. */
export function localForwardUrl(podPort: number, localPort?: number): string {
  return `http://localhost:${localPort ?? podPort}`;
}

export type ForwardOptions = {
  sessionId: string;
  podPort: number;
  localPort?: number;
  address?: string;
  /** Injectable for tests; defaults to the real listRemoteSessions. */
  listSessions?: typeof listRemoteSessions;
  /** Control-plane URL (needed to list sessions). */
  remoteUrl: string;
  stderr?: NodeJS.WriteStream;
  stdout?: NodeJS.WriteStream;
};

/**
 * Verify the session exists on the control-plane. Returns an error message
 * (string) when it does NOT, or undefined when it does. Pure aside from the
 * injected lister, so the "unknown session" path is unit-testable with a mock.
 */
export async function ensureSessionExists(opts: {
  sessionId: string;
  remoteUrl: string;
  listSessions: typeof listRemoteSessions;
}): Promise<string | undefined> {
  const sessions = await opts.listSessions(opts.remoteUrl);
  const found = sessions.some((s) => s.id === opts.sessionId);
  if (found) return undefined;
  const known = sessions.map((s) => s.id);
  return (
    `no remote session "${opts.sessionId}"` +
    (known.length > 0 ? ` (live: ${known.join(", ")})` : " (no live sessions)")
  );
}

/**
 * Run `kubectl port-forward` in the FOREGROUND until Ctrl-C. Returns the process
 * exit code: 0 on a clean SIGINT teardown, non-zero if kubectl itself failed.
 * Verifies the session exists first; resolves with 1 (after printing) if not.
 */
export async function forwardSessionPort(opts: ForwardOptions): Promise<number> {
  const stderr = opts.stderr ?? process.stderr;
  const stdout = opts.stdout ?? process.stdout;
  const tunnel = getTunnel();
  if (!tunnel) {
    stderr.write(
      "[remote] forward needs a tunnel configured (remote config tunnel …)\n",
    );
    return 1;
  }

  const listSessions = opts.listSessions ?? listRemoteSessions;
  const missing = await ensureSessionExists({
    sessionId: opts.sessionId,
    remoteUrl: opts.remoteUrl,
    listSessions,
  });
  if (missing) {
    stderr.write(`[remote] ${missing}\n`);
    return 1;
  }

  const args = buildPortForwardArgs({
    namespace: tunnel.namespace,
    sessionId: opts.sessionId,
    podPort: opts.podPort,
    ...(opts.localPort !== undefined ? { localPort: opts.localPort } : {}),
    ...(opts.address !== undefined ? { address: opts.address } : {}),
  });

  const url = localForwardUrl(opts.podPort, opts.localPort);
  stderr.write(
    `[remote] forwarding ${sessionPodName(opts.sessionId)} :${opts.podPort} → ${url}\n` +
      `[remote] open ${url} — Ctrl-C to stop\n`,
  );

  return runPortForward(tunnel, args, stdout, stderr);
}

/**
 * Spawn kubectl, pipe its output through, and turn Ctrl-C into a clean teardown
 * (SIGINT → kill the child → resolve 0). Kept separate so forwardSessionPort
 * stays readable; the env/KUBECONFIG wiring mirrors tunnel.ts.
 */
function runPortForward(
  tunnel: TunnelConfig,
  args: ReadonlyArray<string>,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): Promise<number> {
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);

  return new Promise<number>((resolve) => {
    const child = spawn("kubectl", [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);

    let interrupted = false;
    const onSigint = (): void => {
      interrupted = true;
      child.kill("SIGINT");
    };
    process.on("SIGINT", onSigint);

    const cleanup = (): void => {
      process.removeListener("SIGINT", onSigint);
    };

    child.on("error", (err) => {
      cleanup();
      stderr.write(`[remote] kubectl port-forward failed: ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => {
      cleanup();
      // A SIGINT teardown is the expected, successful end of a foreground
      // forward — report 0 even though kubectl exits non-zero on the signal.
      resolve(interrupted ? 0 : code ?? 0);
    });
  });
}
