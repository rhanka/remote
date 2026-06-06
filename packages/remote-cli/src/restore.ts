/**
 * `remote restore` — relaunch recent local dev sessions (claude/codex) in their
 * layout, each tab a remote-managed tmux session (durable, live-named).
 *
 * This OWNS the launcher logic in the CLI (discovery + grouping + layout +
 * terminal launch), so `~/bin/resume-dev-sessions` is just `exec remote
 * restore`. SCW sessions and persisted positions come later.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getLayoutConfig, type LayoutConfig } from "./config.js";

export type DiscoveredSession = {
  project: string;
  mtimeMs: number;
  tool: "claude" | "codex";
  sid: string;
  cwd: string;
};

export type LayoutTab = {
  cwd: string;
  label: string;
  tool: string;
  sid: string;
};

export type LayoutWindow = { title: string; tabs: LayoutTab[] };

/** claude encodes a cwd into its project-dir name by replacing "/" with "-". */
function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/** Discover claude + codex sessions under ~/src/* newer than maxAgeMs. */
export function discoverSessions(
  maxAgeMs: number,
  home: string = homedir(),
): DiscoveredSession[] {
  const src = join(home, "src");
  const cutoff = Date.now() - maxAgeMs;
  const out: DiscoveredSession[] = [];

  // --- claude: <home>/.claude/projects/<encode(~/src/<proj>)…>/<sid>.jsonl ---
  const claudeRoot = join(home, ".claude", "projects");
  const claudePrefix = `${encodeCwd(src)}-`;
  if (existsSync(claudeRoot)) {
    for (const dirName of readdirSync(claudeRoot)) {
      if (!dirName.startsWith(claudePrefix)) continue;
      // claude encodes the full cwd as "/"→"-"; the remainder after the
      // ~/src/ prefix IS the project for a direct child of ~/src. Keep it
      // whole (project names contain "-": sent-tech-design-system) and skip
      // anything that isn't an existing ~/src/<project> dir (sub-paths encode
      // ambiguously and the workdir wouldn't exist anyway).
      const project = dirName.slice(claudePrefix.length);
      const cwd = join(src, project);
      const cst = safeStat(cwd);
      if (!cst || !statSync(cwd).isDirectory()) continue;
      const dir = join(claudeRoot, dirName);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const st = safeStat(join(dir, f));
        if (!st || st.mtimeMs < cutoff) continue;
        out.push({
          project,
          mtimeMs: st.mtimeMs,
          tool: "claude",
          sid: f.replace(/\.jsonl$/, ""),
          cwd: join(src, project),
        });
      }
    }
  }

  // --- codex: <home>/.codex/sessions/**/rollout-*.jsonl (cwd+id in line 1) ---
  const codexRoot = join(home, ".codex", "sessions");
  if (existsSync(codexRoot)) {
    for (const file of walk(codexRoot)) {
      const base = file.split("/").pop() ?? "";
      if (!base.startsWith("rollout-") || !base.endsWith(".jsonl")) continue;
      const st = safeStat(file);
      if (!st || st.mtimeMs < cutoff) continue;
      const meta = firstLineJson(file);
      const cwd: string | undefined = meta?.payload?.cwd;
      const id: string | undefined = meta?.payload?.id;
      if (!cwd || !id || !cwd.startsWith(`${src}/`)) continue;
      const project = cwd.slice(src.length + 1).split("/")[0]!;
      out.push({ project, mtimeMs: st.mtimeMs, tool: "codex", sid: id, cwd });
    }
  }

  return out;
}

function safeStat(p: string): { mtimeMs: number } | undefined {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

function firstLineJson(file: string): any {
  try {
    const buf = readFileSync(file, "utf8");
    const nl = buf.indexOf("\n");
    return JSON.parse(nl === -1 ? buf : buf.slice(0, nl));
  } catch {
    return undefined;
  }
}

function* walk(root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/**
 * Group discovered sessions into terminal windows per the layout config:
 *   - explicit groups first (their projects leave the shared pool),
 *   - the rest round-robin into `sharedWindows` windows,
 *   - capped at `maxPerWindow` tabs each,
 *   - keeping the N most recent sessions per project (`multiSession`, def 1).
 */
export function groupSessions(
  sessions: DiscoveredSession[],
  cfg: LayoutConfig,
): { windows: LayoutWindow[]; dropped: number } {
  // newest-first per project, capped per project
  const byProject = new Map<string, DiscoveredSession[]>();
  for (const s of sessions) {
    const arr = byProject.get(s.project) ?? [];
    arr.push(s);
    byProject.set(s.project, arr);
  }
  const slotsFor = (project: string): LayoutTab[] => {
    const arr = (byProject.get(project) ?? [])
      .slice()
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, cfg.multiSession[project] ?? 1);
    return arr.map((s, i) => ({
      cwd: s.cwd,
      label: i === 0 ? s.project : `${s.project}#${i + 1}`,
      tool: s.tool,
      sid: s.sid,
    }));
  };

  const grouped = new Set<string>();
  const windows: LayoutWindow[] = [];

  for (const g of cfg.groups) {
    const tabs: LayoutTab[] = [];
    for (const project of g.projects) {
      grouped.add(project);
      for (const slot of slotsFor(project)) {
        if (tabs.length >= cfg.maxPerWindow) break;
        tabs.push(slot);
      }
    }
    if (tabs.length > 0) windows.push({ title: g.title, tabs });
  }

  // remaining projects, most-recent project first, round-robin into shared wins
  const remaining = [...byProject.entries()]
    .filter(([p]) => !grouped.has(p))
    .sort((a, b) => projLatest(b[1]) - projLatest(a[1]))
    .map(([p]) => p);
  const sharedSlots: LayoutTab[] = [];
  for (const project of remaining) sharedSlots.push(...slotsFor(project));

  const shared: LayoutTab[][] = Array.from(
    { length: Math.max(1, cfg.sharedWindows) },
    () => [],
  );
  const maxShared = cfg.sharedWindows * cfg.maxPerWindow;
  let placed = 0;
  for (const slot of sharedSlots) {
    if (placed >= maxShared) break;
    shared[placed % cfg.sharedWindows]!.push(slot);
    placed++;
  }
  const dropped = sharedSlots.length - placed;
  shared.forEach((tabs, i) => {
    if (tabs.length > 0)
      windows.push({ title: `fenêtre partagée ${i + 1}`, tabs });
  });

  return { windows, dropped };
}

function projLatest(arr: DiscoveredSession[]): number {
  return arr.reduce((m, s) => Math.max(m, s.mtimeMs), 0);
}

/** Build the per-tab command that relaunches the session via `remote run`. */
function tabCommand(tab: LayoutTab): string {
  // shell-quote args for the inner bash -lc.
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return (
    `remote run ${q(tab.tool)} ${q(tab.cwd)} ` +
    `--resume ${q(tab.sid)} --name ${q(tab.label)} --attach; exec bash`
  );
}

/** Launch the layout in gnome-terminal: one window per group, one tab per session. */
export function launchLayout(
  windows: LayoutWindow[],
  stderr: NodeJS.WriteStream = process.stderr,
): void {
  for (const win of windows) {
    // Each tab gets its OWN `-- bash -lc <resume cmd>` segment, so every tab
    // relaunches its own session (gnome-terminal otherwise applies one trailing
    // command to all tabs of the invocation).
    stderr.write(
      `[remote] fenêtre "${win.title}" (${win.tabs.length} onglet(s))\n`,
    );
    spawn("gnome-terminal", buildGnomeArgs(win), {
      stdio: "ignore",
      detached: true,
      env: process.env,
    }).unref();
  }
}

/** gnome-terminal args: per-tab working-dir + title + its own resume command. */
function buildGnomeArgs(win: LayoutWindow): string[] {
  const args: string[] = [];
  win.tabs.forEach((tab, i) => {
    args.push(
      i === 0 ? "--window" : "--tab",
      `--working-directory=${tab.cwd}`,
      `--title=${tab.label}`,
      "--",
      "bash",
      "-lc",
      tabCommand(tab),
    );
  });
  return args;
}

/** Full restore: discover -> group -> launch. Returns a summary. */
export function restore(
  opts: { dryRun?: boolean; stderr?: NodeJS.WriteStream } = {},
): { windows: LayoutWindow[]; total: number; dropped: number } {
  const cfg = getLayoutConfig();
  const sessions = discoverSessions(cfg.maxAgeHours * 3600 * 1000);
  const { windows, dropped } = groupSessions(sessions, cfg);
  const total = windows.reduce((n, w) => n + w.tabs.length, 0);
  const stderr = opts.stderr ?? process.stderr;
  for (const w of windows) {
    stderr.write(`  ${w.title} (${w.tabs.length}):\n`);
    for (const t of w.tabs)
      stderr.write(`    - ${t.label}  ${t.tool}  ${t.cwd}\n`);
  }
  if (dropped > 0)
    stderr.write(`  (! ${dropped} session(s) ignorée(s), plafond atteint)\n`);
  if (!opts.dryRun && total > 0) launchLayout(windows, stderr);
  return { windows, total, dropped };
}
