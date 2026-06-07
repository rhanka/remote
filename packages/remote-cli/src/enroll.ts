/**
 * `remote enroll` plumbing — feeds the live-session registry.
 *
 *  - Hook mode (`--hook claude-start|claude-end`): called by Claude Code's
 *    SessionStart/SessionEnd hooks with the hook JSON on stdin. This path MUST
 *    never break the host session: parse errors are reported on stderr only
 *    and the command always exits 0.
 *  - `--install-hooks`: idempotent merge of those two hooks into
 *    ~/.claude/settings.json (path injectable for tests), with a
 *    settings.json.bak.<epoch> backup before the first modification. Existing
 *    hooks are NEVER overwritten; our entry is detected by its command string.
 *  - Manual mode (`--tool …`): direct enrolment for scripts.
 *
 * codex has no reliable session hook: codex sessions enter the registry via
 * `remote run` (source "run") and the restore filesystem-scan fallback.
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  coerceRegistryTool,
  enroll,
  markEnded,
  resolveRegistryPath,
} from "./registry.js";

// ---------------------------------------------------------------------------
// Hook mode
// ---------------------------------------------------------------------------

/** Subset of the JSON Claude Code pipes to SessionStart/SessionEnd hooks. */
export type ClaudeHookPayload = {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
};

export function readStdin(
  stream: NodeJS.ReadStream = process.stdin,
): Promise<string> {
  return new Promise((resolvePromise) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolvePromise(data));
    stream.on("error", () => resolvePromise(data));
  });
}

export type HookResult = { ok: boolean; error?: string };

/**
 * Handle a Claude Code hook payload. Never throws — the caller reports
 * `error` on stderr and exits 0 regardless (a registry bug must not take the
 * user's claude session down with it).
 */
export function handleClaudeHook(
  hook: string,
  rawPayload: string,
  registryPath: string = resolveRegistryPath(),
): HookResult {
  try {
    if (hook !== "claude-start" && hook !== "claude-end") {
      return { ok: false, error: `unknown hook "${hook}"` };
    }
    const payload = JSON.parse(rawPayload) as ClaudeHookPayload;
    const id = payload.session_id;
    if (!id || typeof id !== "string") {
      return { ok: false, error: "hook payload has no session_id" };
    }
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    if (hook === "claude-start") {
      enroll(
        { id, tool: "claude", kind: "local", cwd, convId: id, source: "hook" },
        registryPath,
      );
      return { ok: true };
    }
    // claude-end: enroll-if-missing so the end of an unknown session still
    // leaves a (terminated) trace, then mark it ended.
    if (!markEnded(id, registryPath)) {
      enroll(
        { id, tool: "claude", kind: "local", cwd, convId: id, source: "hook" },
        registryPath,
      );
      markEnded(id, registryPath);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// ---------------------------------------------------------------------------
// Manual mode
// ---------------------------------------------------------------------------

export type ManualEnrollOpts = {
  tool: string;
  cwd?: string;
  conv?: string;
  pid?: string;
  label?: string;
};

export function manualEnroll(
  opts: ManualEnrollOpts,
  registryPath: string = resolveRegistryPath(),
): HookResult {
  const tool = coerceRegistryTool(opts.tool);
  if (!tool) {
    return {
      ok: false,
      error: `unknown tool "${opts.tool}" (known: claude, codex, agy)`,
    };
  }
  const cwd = resolve(opts.cwd ?? process.cwd());
  const id = opts.conv ?? opts.label ?? basename(cwd);
  const pid = opts.pid !== undefined ? Number.parseInt(opts.pid, 10) : undefined;
  if (opts.pid !== undefined && !Number.isInteger(pid)) {
    return { ok: false, error: `invalid --pid "${opts.pid}"` };
  }
  enroll(
    {
      id,
      tool,
      kind: "local",
      cwd,
      source: "run",
      ...(opts.conv !== undefined ? { convId: opts.conv } : {}),
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(pid !== undefined ? { pid } : {}),
    },
    registryPath,
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// --install-hooks
// ---------------------------------------------------------------------------

const HOOK_COMMANDS: ReadonlyArray<readonly [event: string, command: string]> = [
  ["SessionStart", "remote enroll --hook claude-start"],
  ["SessionEnd", "remote enroll --hook claude-end"],
];

export function defaultClaudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export type InstallHooksResult = {
  settingsPath: string;
  changed: boolean;
  /** Hook events newly added by this run (empty when already installed). */
  installed: string[];
  backupPath?: string;
};

type HookMatcher = { hooks?: Array<{ type?: string; command?: string }> };

/**
 * Idempotently merge the enroll hooks into Claude Code's settings.json.
 * Duplicate detection is by command string; existing hooks are kept verbatim.
 * The pre-existing file is backed up to settings.json.bak.<epoch> before the
 * first modification. A corrupt settings file ABORTS (never overwritten).
 */
export function installClaudeHooks(
  settingsPath: string = defaultClaudeSettingsPath(),
): InstallHooksResult {
  let settings: Record<string, unknown> = {};
  let existed = false;
  let raw: string | undefined;
  try {
    raw = readFileSync(settingsPath, "utf8");
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `cannot read ${settingsPath}: ${(error as Error).message}`,
      );
    }
  }
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `${settingsPath} is not valid JSON (${(error as Error).message}); fix it manually — refusing to overwrite`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${settingsPath} is not a JSON object; refusing to modify`);
    }
    settings = parsed as Record<string, unknown>;
  }

  const hooksRaw = settings.hooks ?? {};
  if (!hooksRaw || typeof hooksRaw !== "object" || Array.isArray(hooksRaw)) {
    throw new Error(
      `${settingsPath} has a non-object "hooks" field; refusing to modify`,
    );
  }
  const hooks = hooksRaw as Record<string, unknown>;

  const installed: string[] = [];
  for (const [event, command] of HOOK_COMMANDS) {
    const matchers: HookMatcher[] = Array.isArray(hooks[event])
      ? (hooks[event] as HookMatcher[])
      : [];
    const already = matchers.some(
      (m) =>
        Array.isArray(m?.hooks) &&
        m.hooks.some((h) => h?.command === command),
    );
    if (already) continue;
    matchers.push({ hooks: [{ type: "command", command }] });
    hooks[event] = matchers;
    installed.push(event);
  }
  if (installed.length === 0) {
    return { settingsPath, changed: false, installed };
  }
  settings.hooks = hooks;

  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${settingsPath}.bak.${Math.floor(Date.now() / 1000)}`;
    copyFileSync(settingsPath, backupPath);
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  renameSync(tmp, settingsPath);
  return {
    settingsPath,
    changed: true,
    installed,
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}
