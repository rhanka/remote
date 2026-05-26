import { cpSync, existsSync, mkdirSync } from "node:fs";
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
