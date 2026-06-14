import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * HOME-relative conversation/state directories each CLI writes, persisted with
 * the workspace so a conversation started in one remote session can be resumed
 * in the next session bound to the same workspace.
 */
const PROFILE_STATE_DIRS: Readonly<Record<string, ReadonlyArray<string>>> = {
  codex: [".codex/sessions"],
  claude: [".claude/projects"],
  agy: [".gemini/antigravity-cli/conversations"],
  // aliases
  "claude-code": [".claude/projects"],
  antigravity: [".gemini/antigravity-cli/conversations"],
};

const STATE_SUBDIR = ".remote/sessions";

function stateDirsFor(profile: string): ReadonlyArray<string> {
  return PROFILE_STATE_DIRS[profile] ?? [];
}

function copyDir(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  return true;
}

/**
 * Make the CLI's conversation/state DURABLE by symlinking each HOME state dir to
 * the retained workspace PVC: `<home>/<relDir>` → `<workspace>/.remote/sessions/
 * <profile>/<relDir>`. The CLI then writes its conversation log directly onto
 * the PVC, so it SURVIVES pod restarts / re-deports (HOME is the pod's ephemeral
 * fs; the PVC is retained). This replaces the old copy-on-start restore, which
 * lost any history written between start and the next snapshot when a Pod died.
 *
 * Seeds the PVC from any pre-existing real HOME dir (without overwriting newer
 * PVC content), then swaps the HOME dir for a symlink. Idempotent.
 */
export function linkSessionState(
  profile: string,
  home: string,
  workspacePath: string,
): ReadonlyArray<string> {
  const linked: string[] = [];
  for (const rel of stateDirsFor(profile)) {
    const pvc = join(workspacePath, STATE_SUBDIR, profile, rel);
    const homeDir = join(home, rel);
    try {
      mkdirSync(pvc, { recursive: true });

      // Already a symlink (re-run)? leave it.
      let isLink = false;
      try {
        isLink = lstatSync(homeDir).isSymbolicLink();
      } catch {
        isLink = false;
      }
      if (isLink) {
        linked.push(rel);
        continue;
      }

      // Real dir with content (claude created it, or a prior copy)? seed the PVC
      // without overwriting newer PVC files, then remove it.
      if (existsSync(homeDir)) {
        cpSync(homeDir, pvc, { recursive: true, force: false, errorOnExist: false });
        rmSync(homeDir, { recursive: true, force: true });
      }

      mkdirSync(dirname(homeDir), { recursive: true });
      symlinkSync(pvc, homeDir);
      linked.push(rel);
    } catch {
      // best-effort: a failure here must not block the session start
    }
  }
  return linked;
}

/**
 * Restore persisted conversation state from the workspace into HOME before the
 * CLI starts. `<workspace>/.remote/sessions/<profile>/<relDir>` → `<home>/<relDir>`.
 */
export function restoreSessionState(
  profile: string,
  home: string,
  workspacePath: string,
): ReadonlyArray<string> {
  const restored: string[] = [];
  for (const rel of stateDirsFor(profile)) {
    const src = join(workspacePath, STATE_SUBDIR, profile, rel);
    const dst = join(home, rel);
    if (copyDir(src, dst)) restored.push(rel);
  }
  return restored;
}

/**
 * Snapshot the CLI's conversation state from HOME back into the workspace so it
 * persists (retained PVC) and rides `remote workspace pull`.
 */
export function snapshotSessionState(
  profile: string,
  home: string,
  workspacePath: string,
): ReadonlyArray<string> {
  const saved: string[] = [];
  for (const rel of stateDirsFor(profile)) {
    const src = join(home, rel);
    const dst = join(workspacePath, STATE_SUBDIR, profile, rel);
    if (copyDir(src, dst)) saved.push(rel);
  }
  return saved;
}

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Best-effort detection of the wrapped CLI's own conversation id: the
 * most-recently-modified conversation file under the profile's state dir,
 * reduced to a uuid (if present in the name) or the filename stem.
 */
/**
 * Profiles whose conversation files live under a per-cwd, PATH-ENCODED project
 * dir (`<relDir>/<cwd-with-slashes-as-dashes>/<convId>.jsonl`). claude resolves
 * `--resume <id>` only WITHIN the current cwd's project dir, so a conversation
 * staged under a DIFFERENT key is invisible to a Pod running in workspacePath.
 * (codex keys sessions by id, agy by its own scheme — neither needs this.)
 */
const PATH_ENCODED_PROJECT_DIRS: Readonly<Record<string, string>> = {
  claude: ".claude/projects",
  "claude-code": ".claude/projects",
};

/** claude's project-key encoding of an absolute cwd: every "/" → "-". */
export function projectKeyForCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export type ConversationCanonicalization = {
  /** Conversation filename(s) copied into the canonical key dir (empty = no-op). */
  readonly copied: ReadonlyArray<string>;
  /** The cwd-derived project key conversations must live under to resume. */
  readonly canonicalKey: string;
};

/**
 * Make the newest conversation resolvable under the cwd's canonical project key
 * so `claude --resume <id>` (run with cwd=workspacePath) actually finds it.
 *
 * `remote migrate` stages a live conversation under the project key derived
 * from the USER'S LOCAL path (e.g. `-home-antoinefa-src-foo`), but the Pod runs
 * the CLI in `workspacePath` (e.g. `/workspace` → key `-workspace`). claude
 * resolves `--resume <id>` only within the current cwd's project dir, so the
 * resume silently falls back to a fresh shell — the remote-resume bug. This
 * copies the newest `.jsonl` (the main conversation; companion subagent dirs
 * are auxiliary, matching what migrate stages) from whatever key holds it into
 * the canonical key dir.
 *
 * Idempotent + best-effort: if the newest conversation already lives under the
 * canonical key (native remote session, or a prior run's copy — which is newer)
 * nothing is copied, and an existing file at the destination is never clobbered.
 */
export function canonicalizeConversationKey(
  profile: string,
  home: string,
  cwd: string,
): ConversationCanonicalization {
  const relDir = PATH_ENCODED_PROJECT_DIRS[profile];
  const canonicalKey = projectKeyForCwd(cwd);
  if (!relDir) return { copied: [], canonicalKey };

  const projectsRoot = join(home, relDir);
  if (!existsSync(projectsRoot)) return { copied: [], canonicalKey };

  let keys;
  try {
    keys = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return { copied: [], canonicalKey };
  }

  // Newest <key>/<convId>.jsonl across ALL project keys.
  let newest:
    | { key: string; file: string; abs: string; mtime: number }
    | undefined;
  for (const k of keys) {
    if (!k.isDirectory()) continue;
    const keyDir = join(projectsRoot, k.name);
    let files;
    try {
      files = readdirSync(keyDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const abs = join(keyDir, f.name);
      const mtime = statSync(abs).mtimeMs;
      if (!newest || mtime > newest.mtime)
        newest = { key: k.name, file: f.name, abs, mtime };
    }
  }
  // Nothing to resume, or the newest conversation already lives under the
  // canonical key — both no-ops.
  if (!newest || newest.key === canonicalKey)
    return { copied: [], canonicalKey };

  const dstDir = join(projectsRoot, canonicalKey);
  const dst = join(dstDir, newest.file);
  // Never clobber a conversation already present at the canonical key.
  if (existsSync(dst)) return { copied: [], canonicalKey };
  try {
    mkdirSync(dstDir, { recursive: true });
    cpSync(newest.abs, dst);
    return { copied: [newest.file], canonicalKey };
  } catch {
    return { copied: [], canonicalKey };
  }
}

export function detectCliSessionId(
  profile: string,
  home: string,
): string | undefined {
  let newest: { id: string; mtime: number } | undefined;
  for (const rel of stateDirsFor(profile)) {
    const root = join(home, rel);
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(abs);
        } else if (e.isFile()) {
          const mtime = statSync(abs).mtimeMs;
          if (!newest || mtime > newest.mtime) {
            const base = e.name.replace(/\.[^.]+$/, "");
            const id = UUID_RE.exec(e.name)?.[0] ?? base;
            newest = { id, mtime };
          }
        }
      }
    }
  }
  return newest?.id;
}
