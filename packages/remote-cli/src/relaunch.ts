/**
 * `remote relaunch` — bring back local tmux sessions whose CLI has dropped to a
 * shell (in situ, keeping the windows), each resuming ITS OWN conversation.
 *
 * Why a dedicated command: closing the terminal windows does NOT kill the tmux
 * sessions, and `remote restore` goes through `remote run -r`, which the
 * single-writer guard refuses while the (idle) session still holds the
 * conversation. This relaunches the CLI inside the existing session — no
 * `remote run`, no guard fight — and crucially resumes each session's OWN
 * convId (from the registry), never "most recent", so the N sessions that share
 * a cwd never collide on one .jsonl.
 */

import { isCliProfile, resolveProfile, resumeArgsFor } from "./profiles.js";

/** The shell command that resumes `convId` for `profile`, or undefined if the */
/** profile has no resume form (e.g. shell). */
export function resumeCommandFor(
  profile: string,
  convId: string,
): string | undefined {
  if (!isCliProfile(profile)) return undefined;
  const cfg = resolveProfile(profile);
  const args = resumeArgsFor(cfg, convId);
  if (args.length === 0) return undefined;
  return [cfg.command, ...args].join(" ");
}

export type RelaunchCandidate = {
  /** short name, e.g. `sentropic#2` */
  slug: string;
  /** full tmux session name, e.g. `remote-sentropic#2` */
  name: string;
  profile: string;
  /** true when the pane is an idle shell (CLI gone) — only these are relaunched */
  idle: boolean;
  /** this session's own conversation id, from the registry */
  convId?: string;
};

export type RelaunchAction = {
  slug: string;
  name: string;
  profile: string;
  convId: string;
  /** the command to run in the session (e.g. `claude --resume <id>`) */
  cmd: string;
};

export type RelaunchSkip = { slug: string; reason: string };

export type RelaunchPlan = {
  actions: RelaunchAction[];
  skipped: RelaunchSkip[];
};

/**
 * Decide what to relaunch. Pure: takes fully-resolved candidates (idle flag +
 * convId already gathered) so it is unit-testable without tmux/registry I/O.
 * Skips running sessions (never disturb a live CLI), sessions with no known
 * convId (relaunch by hand rather than guess and risk a collision), and
 * profiles with no resume form. Also refuses to point two sessions at the SAME
 * convId (defensive: the registry should already be 1:1).
 */
export function planRelaunch(
  candidates: ReadonlyArray<RelaunchCandidate>,
): RelaunchPlan {
  const actions: RelaunchAction[] = [];
  const skipped: RelaunchSkip[] = [];
  const claimed = new Map<string, string>(); // convId -> slug that took it
  for (const c of candidates) {
    if (!c.idle) {
      skipped.push({ slug: c.slug, reason: "CLI is running — left alone" });
      continue;
    }
    if (!c.convId) {
      skipped.push({
        slug: c.slug,
        reason: "no convId in the registry — relaunch manually",
      });
      continue;
    }
    const prior = claimed.get(c.convId);
    if (prior) {
      skipped.push({
        slug: c.slug,
        reason: `conversation ${c.convId} already taken by ${prior} — would collide`,
      });
      continue;
    }
    const cmd = resumeCommandFor(c.profile, c.convId);
    if (!cmd) {
      skipped.push({
        slug: c.slug,
        reason: `profile "${c.profile}" has no resume form`,
      });
      continue;
    }
    claimed.set(c.convId, c.slug);
    actions.push({
      slug: c.slug,
      name: c.name,
      profile: c.profile,
      convId: c.convId,
      cmd,
    });
  }
  return { actions, skipped };
}
