/**
 * On-demand tunnel management. When the configured control-plane URL is not
 * directly routable (no public ingress), the CLI brings up a `kubectl
 * port-forward` itself — managed as a detached background child with a pidfile
 * — so the user never runs a port-forward by hand. `ensureConnected()` is called
 * by the remote-targeting commands (connect/ls/attach/migrate); it is a no-op
 * when the URL is already reachable (e.g. a real ingress).
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { authHeaders, getTunnel, resolveConfigPath, type TunnelConfig } from "./config.js";

function runtimeDir(): string {
  return join(dirname(resolveConfigPath()), "run");
}
function pidFile(): string {
  return join(runtimeDir(), "tunnel.pid");
}
function logFile(): string {
  return join(runtimeDir(), "tunnel.log");
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** True if the control-plane answers at all (any HTTP status = reachable). */
export async function isReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${url.replace(/\/$/, "")}/sessions`, {
      signal: controller.signal,
      headers: authHeaders(),
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function tunnelPid(): number | undefined {
  if (!existsSync(pidFile())) return undefined;
  const pid = Number(readFileSync(pidFile(), "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** True if our managed tunnel process is currently alive. */
export function tunnelAlive(): boolean {
  const pid = tunnelPid();
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawn a detached `kubectl port-forward` and record its pid. */
export function startTunnelProcess(tunnel: TunnelConfig): void {
  mkdirSync(runtimeDir(), { recursive: true });
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  const out = openSync(logFile(), "a");
  const child = spawn(
    "kubectl",
    [
      "-n",
      tunnel.namespace,
      "port-forward",
      `svc/${tunnel.service}`,
      `${tunnel.localPort}:${tunnel.remotePort}`,
    ],
    { detached: true, stdio: ["ignore", out, out], env },
  );
  if (child.pid !== undefined) writeFileSync(pidFile(), String(child.pid));
  child.unref();
}

/** Kill the managed tunnel, if any. Returns true if one was running. */
export function stopTunnel(): boolean {
  const pid = tunnelPid();
  rmSync(pidFile(), { force: true });
  if (pid === undefined) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the control-plane at `url` is reachable. No-op if it already is.
 * Otherwise, if a tunnel is configured, (re)start it and wait until reachable.
 * Throws a helpful error if unreachable and no tunnel is configured.
 */
export async function ensureConnected(
  url: string,
  stderr: NodeJS.WriteStream = process.stderr,
): Promise<void> {
  // No tunnel configured → nothing to manage (the URL may be a real ingress, or
  // the request will surface its own connection error). Only act when the user
  // has configured a tunnel for this CLI.
  const tunnel = getTunnel();
  if (!tunnel) return;

  if (await isReachable(url)) return;

  if (!tunnelAlive()) {
    stderr.write(
      `[remote] control-plane unreachable — opening tunnel (kubectl port-forward ${tunnel.service} :${tunnel.localPort})\n`,
    );
    startTunnelProcess(tunnel);
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise<void>((r) => setTimeout(r, 500));
    if (await isReachable(url)) {
      stderr.write(`[remote] tunnel up\n`);
      return;
    }
  }
  throw new Error(
    `tunnel started but ${url} is still unreachable after 15s — check the kubeconfig/namespace/service (logs: ${logFile()})`,
  );
}
