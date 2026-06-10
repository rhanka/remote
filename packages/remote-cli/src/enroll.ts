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
  advanceJob,
  coerceRegistryTool,
  enroll,
  loadRegistry,
  markEnded,
  resolveRegistryPath,
  type RegistryEntry,
} from "./registry.js";
import { emitJobDone, type EmitJobDoneResult } from "./h2a-jobs.js";

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

export type HookResult = {
  ok: boolean;
  error?: string;
  /** Set when claude-end finished a delegated job (role:"job") and a job.done
   * callback was attempted. For diagnostics/tests only. */
  callback?: EmitJobDoneResult;
  /** The job id this hook resolved/finished (diagnostics/tests only). */
  jobId?: string;
};

/** Injectable so tests never touch the real ~/h2a-workspace / process.env. */
export type HandleClaudeHookOpts = {
  emit?: (job: RegistryEntry) => EmitJobDoneResult;
  /** Process env (so tests can inject REMOTE_JOB_ID). Defaults to process.env. */
  env?: Record<string, string | undefined>;
};

/**
 * Resolve the delegated JOB an ending/starting claude session belongs to.
 *
 * H1 — a job spawned via `remote delegate` is enrolled under a SLUG (the jobId),
 * NOT under claude's conversation uuid (`session_id`). The SessionEnd hook only
 * receives `session_id`, so matching the job by `id === session_id` NEVER hits →
 * an interactive tmux job stays `running` forever. The fix gives the hook a
 * stable handle on the jobId, two complementary ways:
 *  1. `REMOTE_JOB_ID` — stamped into the tmux session's env by `startJob`, so the
 *     claude process (and its hook child) inherit it. Authoritative when present.
 *  2. `convId` link — at SessionStart we record `session_id` onto the job entry's
 *     convId (a no-op when no REMOTE_JOB_ID), so SessionEnd can also resolve a job
 *     whose env didn't survive (some shells scrub it) by `convId === session_id`.
 * Pure over the registry snapshot, exported for tests.
 */
export function resolveJobForHook(
  entries: ReadonlyArray<RegistryEntry>,
  sessionId: string,
  envJobId: string | undefined,
): RegistryEntry | undefined {
  // 1. REMOTE_JOB_ID — authoritative (the slug stamped on the tmux env).
  if (envJobId) {
    const byEnv = entries.find((e) => e.id === envJobId && e.role === "job");
    if (byEnv) return byEnv;
  }
  // 2. convId link recorded at SessionStart (env didn't survive into the hook).
  const byConv = entries.find((e) => e.role === "job" && e.convId === sessionId);
  if (byConv) return byConv;
  // 3. Back-compat: a job whose registry id IS the conversation uuid (e.g. a
  //    manually-enrolled job, or one keyed by its session_id).
  return entries.find((e) => e.id === sessionId && e.role === "job");
}

/**
 * Handle a Claude Code hook payload. Never throws — the caller reports
 * `error` on stderr and exits 0 regardless (a registry bug must not take the
 * user's claude session down with it).
 *
 * P3: on claude-end, if the ending session is a DELEGATED JOB (role:"job" in
 * the registry), advance it to `done` and emit a best-effort `job.done` h2a
 * envelope to its parent (callbackTo). The hook STILL always succeeds — a
 * callback failure is recorded in `callback`, never surfaced as `ok:false`.
 */
export function handleClaudeHook(
  hook: string,
  rawPayload: string,
  registryPath: string = resolveRegistryPath(),
  opts: HandleClaudeHookOpts = {},
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
    const env = opts.env ?? process.env;
    const envJobId = env.REMOTE_JOB_ID;
    if (hook === "claude-start") {
      // H1 — if this claude session IS a delegated job (REMOTE_JOB_ID stamped on
      // its tmux env by startJob), LINK its conversation uuid onto the job entry
      // (convId) so SessionEnd can resolve the job even if the env is later
      // scrubbed. Otherwise enroll a plain session as before.
      if (envJobId) {
        const job = loadRegistry(registryPath).find(
          (e) => e.id === envJobId && e.role === "job",
        );
        if (job) {
          enroll(
            {
              id: job.id,
              tool: job.tool,
              kind: job.kind,
              cwd: job.cwd,
              source: job.source,
              convId: id,
              role: "job",
            },
            registryPath,
          );
          return { ok: true, jobId: job.id };
        }
      }
      enroll(
        { id, tool: "claude", kind: "local", cwd, convId: id, source: "hook" },
        registryPath,
      );
      return { ok: true };
    }
    // claude-end: is this session a DELEGATED JOB? Resolve by REMOTE_JOB_ID (the
    // env stamped by startJob) or by the convId link recorded at SessionStart —
    // NOT by `id === session_id` (the job lives under its slug, not the uuid).
    const job = resolveJobForHook(loadRegistry(registryPath), id, envJobId);
    if (job) {
      // Advance to done (no-op if already terminal), keyed by the JOB's id (its
      // slug) — NOT the session uuid. The interactive agent ending its session IS
      // the success signal; a non-zero exit isn't observable from SessionEnd, so
      // "done" is the right default.
      const advanced = advanceJob(job.id, "done", registryPath) ?? job;
      let callback: EmitJobDoneResult;
      try {
        const emit = opts.emit ?? ((j: RegistryEntry) => emitJobDone(j, { state: advanced.jobState ?? "done" }));
        callback = emit(advanced);
      } catch (error) {
        // a callback failure must NEVER fail the hook
        callback = { emitted: false, reason: "error", error: String(error) };
      }
      return { ok: true, callback, jobId: job.id };
    }
    // Not a job — enroll-if-missing so the end of an unknown session still
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
