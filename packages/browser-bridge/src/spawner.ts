/**
 * Real (impure) BrowserSpawner used inside the Pod.
 *
 * It launches the browser sidecar entrypoint, which brings up the headful
 * stack: Xvfb (virtual X display) → Chromium (headful, on that display) →
 * x11vnc (VNC server bound to the display) → websockify + noVNC static assets
 * (the noVNC port `remote forward` exposes).
 *
 * The token is passed as an ARGV element and via an env var — NEVER
 * concatenated into a `bash -lc` string (project rule). The entrypoint reads
 * NOVNC_TOKEN from the environment and configures websockify's token gate from
 * it. Geometry/display/port likewise travel as discrete argv/env.
 *
 * This file is intentionally thin and side-effecting; the testable logic lives
 * in bridge.ts/policy.ts/etc. The default entrypoint path matches the sidecar
 * image (see deploy + the browser Dockerfile).
 */

import { spawn, type ChildProcess } from "node:child_process";

import type {
  BrowserHandle,
  BrowserSpawner,
  BrowserSpawnConfig,
} from "./bridge.js";

/** Default path of the sidecar entrypoint inside the browser image. */
export const DEFAULT_ENTRYPOINT = "/opt/browser/start-headful.sh";

export type ChildProcessSpawnerOptions = {
  /** Entrypoint script that brings up Xvfb+Chromium+x11vnc+websockify+noVNC. */
  readonly entrypoint?: string;
  /** Injectable spawn (defaults to node:child_process spawn) — for tests. */
  readonly spawnFn?: typeof spawn;
};

/**
 * Spawns the sidecar entrypoint as a long-lived child. `kill` SIGTERMs the
 * process group. One headful browser per Pod (single fixed port), so the
 * spawner tracks a single child.
 */
export class ChildProcessBrowserSpawner implements BrowserSpawner {
  private readonly entrypoint: string;
  private readonly spawnFn: typeof spawn;
  private child: ChildProcess | undefined;

  constructor(opts: ChildProcessSpawnerOptions = {}) {
    this.entrypoint = opts.entrypoint ?? DEFAULT_ENTRYPOINT;
    this.spawnFn = opts.spawnFn ?? spawn;
  }

  async spawn(config: BrowserSpawnConfig): Promise<BrowserHandle> {
    // Token + geometry as DISCRETE argv — never interpolated into a shell line.
    const args = [
      "--display",
      config.display,
      "--geometry",
      config.geometry,
      "--port",
      String(config.podPort),
      config.interactive ? "--interactive" : "--view-only",
    ];
    const child = this.spawnFn(this.entrypoint, args, {
      // Token via env, not argv visible in `ps` for other tenants of the box.
      env: { ...process.env, NOVNC_TOKEN: config.token },
      stdio: "ignore",
      detached: true,
    });
    this.child = child;
    if (child.pid === undefined) {
      throw new Error("browser sidecar failed to spawn (no pid)");
    }
    return { pid: String(child.pid) };
  }

  async kill(_handle: BrowserHandle): Promise<void> {
    if (!this.child) return;
    try {
      // Negative pid → kill the whole detached process group (Xvfb/Chromium/…).
      if (this.child.pid !== undefined)
        process.kill(-this.child.pid, "SIGTERM");
    } catch {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
  }
}
