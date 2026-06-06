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
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { collectProfileAuth } from "./auth-bundle.js";
import { getTunnel, type TunnelConfig } from "./config.js";

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

/** `<cli> --resume <id>` per profile. */
function resumeCommand(profile: string, convId: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  switch (profile) {
    case "codex":
      return `codex resume ${q(convId)}`;
    case "agy":
    case "antigravity":
      return `agy --resume ${q(convId)}`;
    default: // claude / claude-code
      return `claude --resume ${q(convId)}`;
  }
}

export type SoftRefreshResult = {
  filesPushed: string[];
  secretKeysPatched: string[];
  convId: string | undefined;
  respawned: boolean;
};

/**
 * Push the profile's fresh creds into the Pod, patch the Secret, and relaunch
 * the CLI in place. `bundle` is the already-collected creds (rel -> content).
 */
export async function softRefreshSession(
  sessionId: string,
  profile: string,
  stderr: NodeJS.WriteStream = process.stderr,
): Promise<SoftRefreshResult> {
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
  stderr.write(`[remote] pushed ${filesPushed.length} cred file(s) into ${pod}\n`);

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
  stderr.write(`[remote] patched ${secretKeysPatched.length} Secret key(s) (durable across restart)\n`);

  // 3. detect the newest conversation in the Pod and respawn the CLI in tmux.
  const convId = execPod(
    tunnel,
    pod,
    `ls -t "$HOME"/.claude/projects/*/*.jsonl "$HOME"/.codex/sessions/**/*.jsonl 2>/dev/null | head -1 | xargs -r basename | sed 's/\\.jsonl$//; s/^rollout-//'`,
  )
    .trim()
    .split("\n")
    .filter(Boolean)[0];

  let respawned = false;
  if (convId) {
    const resume = resumeCommand(profile, convId);
    // Write a relaunch script + respawn the durable tmux pane (drop-to-shell on
    // exit so the session is never killed). Single-quoted heredoc keeps it intact.
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
    respawned = out.endsWith("respawned");
    stderr.write(
      respawned
        ? `[remote] relaunched ${profile} (--resume ${convId}) in the Pod's tmux\n`
        : `[remote] creds pushed but no tmux 'main' to respawn — restart the CLI in the Pod manually\n`,
    );
  } else {
    stderr.write(`[remote] creds pushed; no conversation found to resume\n`);
  }

  return { filesPushed, secretKeysPatched, convId, respawned };
}
