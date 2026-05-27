import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
