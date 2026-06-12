/**
 * `remote restore` — relaunch recent local dev sessions (claude/codex) in their
 * layout, each tab a remote-managed tmux session (durable, live-named).
 *
 * This OWNS the launcher logic in the CLI (discovery + grouping + layout +
 * terminal launch), so `~/bin/resume-dev-sessions` is just `exec remote
 * restore`. SCW sessions and persisted positions come later.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  getLayoutConfig,
  resolveConfigPath,
  type LayoutConfig,
} from "./config.js";
import { listLive, type RegistryEntry } from "./registry.js";
import { listLocalSessions, slugify } from "./tmux.js";

export type DiscoveredSession = {
  project: string;
  mtimeMs: number;
  tool: "claude" | "codex" | "agy";
  sid: string;
  cwd: string;
  /** "registry" = enrolled live session (reliable); "scan" = mtime guess. */
  origin?: "registry" | "scan";
  /** Preferred tab label (registry entries carry a reliable one). */
  label?: string;
};

export type LayoutTab = {
  cwd: string;
  label: string;
  /** local resume (claude/codex tmux) */
  tool?: string;
  sid?: string;
  /** SCW session attached via `remote attach <id> --exec` */
  remoteId?: string;
  /** discovery provenance, shown as [registry]/[guess] in --dry-run */
  origin?: "registry" | "scan";
};

export type LayoutWindow = { title: string; tabs: LayoutTab[] };

/** A pre-resolved SCW tab for a remote group (built by the caller from `remote ls`). */
export type RemoteTab = { id: string; label: string; cwd: string };

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

/**
 * REGISTRY-FIRST discovery: live registry entries (local kinds) mapped to
 * discovered sessions. label/cwd/convId come straight from enrolment, no
 * mtime guessing. `entries` is injectable for tests (defaults to listLive()).
 */
export function registrySessions(
  home: string = homedir(),
  entries: RegistryEntry[] = listLive(),
): DiscoveredSession[] {
  const src = join(home, "src");
  const out: DiscoveredSession[] = [];
  for (const e of entries) {
    if (e.kind === "remote") continue; // remote groups are filled from SCW
    if (!e.cwd.startsWith(`${src}/`)) continue;
    const project = e.cwd.slice(src.length + 1).split("/")[0];
    if (!project) continue;
    const seen = Date.parse(e.lastSeenAt);
    const session: DiscoveredSession = {
      project,
      mtimeMs: Number.isFinite(seen) ? seen : Date.now(),
      tool: e.tool,
      sid: e.convId ?? "",
      cwd: e.cwd,
      origin: "registry",
    };
    if (e.label !== undefined) session.label = e.label;
    out.push(session);
  }
  return out;
}

/**
 * Merge discovery sources: registry entries win; the filesystem scan only
 * completes projects that have NO registry entry (tagged origin "scan").
 */
export function mergeDiscovered(
  registry: DiscoveredSession[],
  scanned: DiscoveredSession[],
): DiscoveredSession[] {
  const covered = new Set(registry.map((s) => s.project));
  return [
    ...registry,
    ...scanned
      .filter((s) => !covered.has(s.project))
      .map((s) => ({ ...s, origin: "scan" as const })),
  ];
}

/**
 * Identity slug used to dedup a LOCAL discovered session against a REMOTE tab
 * (bug #3). Both sides are reduced to lowercase alnum runs so "Sentropic
 * Remote"/"sentropic-remote"/"sentropic_remote" collapse to one key. A `#N`
 * fan-out suffix is kept distinct (it is a different session).
 */
export function sessionIdentitySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Bug #3 — a session that was MOVED to a remote Pod keeps reappearing as a fresh
 * LOCAL tmux because the local conversation files (claude .jsonl / codex
 * rollout) and any stale local registry entry survive the move, so the local
 * discovery still emits a tab for that project. Drop every local discovered
 * session whose project/label identity is already covered by a REMOTE tab: the
 * remote group owns it, and re-launching it locally would spawn a ghost
 * duplicate. Match is by identity slug of the local `label` (else `project`)
 * against the remote tab `label` — the remote tab's cwd is the Pod path (often
 * absent locally) so cwd can't be the key; the friendly name is. Pure; the
 * remote-backed locals are returned separately so the caller can report them.
 */
export function dropRemoteBackedLocals(
  locals: DiscoveredSession[],
  remoteTabs: ReadonlyArray<{ label: string }>,
): { kept: DiscoveredSession[]; dropped: DiscoveredSession[] } {
  if (remoteTabs.length === 0) return { kept: locals, dropped: [] };
  const remoteKeys = new Set(
    remoteTabs.map((t) => sessionIdentitySlug(t.label)),
  );
  const kept: DiscoveredSession[] = [];
  const dropped: DiscoveredSession[] = [];
  for (const s of locals) {
    const key = sessionIdentitySlug(s.label ?? s.project);
    if (remoteKeys.has(key)) dropped.push(s);
    else kept.push(s);
  }
  return { kept, dropped };
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
    return arr.map((s, i) => {
      const tab: LayoutTab = {
        cwd: s.cwd,
        label: s.label ?? (i === 0 ? s.project : `${s.project}#${i + 1}`),
        tool: s.tool,
        sid: s.sid,
      };
      if (s.origin !== undefined) tab.origin = s.origin;
      return tab;
    });
  };

  const grouped = new Set<string>();
  const windows: LayoutWindow[] = [];

  for (const g of cfg.groups) {
    if (g.remote) continue; // remote groups are filled from SCW by the caller
    const tabs: LayoutTab[] = [];
    for (const project of g.projects ?? []) {
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

/**
 * Per-tab command: SCW via `attach --exec`; a LOCAL session that is already
 * live → `remote attach <slug>` (do NOT `remote run -r`, which the single-writer
 * guard refuses while that session still holds the conversation — this is what
 * broke a `restore` over still-detached sessions); otherwise create it via
 * `remote run … --resume … --attach`. `liveSlugs` = slugs of currently-live
 * local tmux sessions (empty for the reproducible layout snapshot).
 */
export function tabCommand(
  tab: LayoutTab,
  liveSlugs: ReadonlySet<string> = new Set(),
): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  if (tab.remoteId) {
    // SCW: attach straight into the Pod's tmux (live, copy-friendly).
    return `remote attach ${q(tab.remoteId)} --exec`;
  }
  const slug = slugify(tab.label);
  if (liveSlugs.has(slug)) {
    // Already running (e.g. terminals were closed but tmux kept the session):
    // attach instead of re-running into the guard.
    return `remote attach ${q(slug)}`;
  }
  return (
    `remote run ${q(tab.tool ?? "shell")} ${q(tab.cwd)} ` +
    (tab.sid ? `--resume ${q(tab.sid)} ` : "") +
    `--name ${q(tab.label)} --attach`
  );
}

// gnome-terminal applies ONE trailing `-- command` to EVERY tab of an
// invocation (you cannot give each tab its own `--`). So all tabs run the same
// dispatcher; each claims (under flock) the first map line matching its $PWD
// and runs that tab's command — exactly how ~/bin/resume-dev-sessions worked.
const DISPATCHER = `map="$1"
lock="$map.lock"
exec 9>"$lock"; flock 9
line=$(awk -F'\\t' -v c="$PWD" '$1==c{print;exit}' "$map")
if [ -n "$line" ]; then
  awk -F'\\t' -v c="$PWD" 'BEGIN{d=0} d==0 && $1==c {d=1; next} {print}' "$map" > "$map.tmp" && mv "$map.tmp" "$map"
fi
flock -u 9
cmd=$(printf '%s' "$line" | cut -f2-)
if [ -n "$cmd" ]; then eval "$cmd"; else echo "[remote] rien a reprendre pour $PWD" >&2; fi
exec bash -l`;

let mapCounter = 0;

function runDir(): string {
  const base = process.env.XDG_RUNTIME_DIR
    ? join(process.env.XDG_RUNTIME_DIR, "sentropic-remote")
    : join(homedir(), ".config", "sentropic", "remote-cli", "run");
  mkdirSync(base, { recursive: true });
  return base;
}

/** Launch the layout in gnome-terminal: one window per group, one tab per session. */
export function launchLayout(
  windows: LayoutWindow[],
  stderr: NodeJS.WriteStream = process.stderr,
): void {
  // Sessions already live now: their tabs attach instead of re-running (which
  // the single-writer guard would refuse).
  const liveSlugs = new Set(listLocalSessions().map((s) => s.slug));
  for (const win of windows) {
    // Map keyed by per-tab working directory -> the tab's command. Tabs sharing
    // a cwd (several sessions of one project) each claim a distinct line FIFO.
    const slug = win.title.replace(/[^a-zA-Z0-9]+/g, "-");
    const mapPath = join(
      runDir(),
      `restore-${process.pid}-${slug}-${mapCounter++}.map`,
    );
    const body =
      win.tabs.map((t) => `${t.cwd}\t${tabCommand(t, liveSlugs)}`).join("\n") +
      "\n";
    writeFileSync(mapPath, body, "utf8");

    const args: string[] = [];
    win.tabs.forEach((tab, i) => {
      args.push(
        i === 0 ? "--window" : "--tab",
        `--working-directory=${tab.cwd}`,
        `--title=${tab.label}`,
      );
    });
    // ONE shared dispatcher command for all tabs of this window.
    args.push("--", "bash", "-lc", DISPATCHER, "remote-restore", mapPath);

    stderr.write(
      `[remote] fenêtre "${win.title}" (${win.tabs.length} onglet(s))\n`,
    );
    // Surface gnome-terminal errors (e.g. "Failed to get screen…") instead of
    // silently claiming the window opened.
    const child = spawn("gnome-terminal", args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      env: process.env,
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.write(`[remote] gnome-terminal: ${chunk.toString().trim()}\n`);
    });
    child.unref();
  }
}

export type RestoreOptions = {
  dryRun?: boolean;
  /** Launch only the group whose title matches (exact or slug-normalized). */
  group?: string;
  /** Pre-resolved SCW tabs (from `remote ls`), used to fill `remote: true` groups. */
  remoteTabs?: RemoteTab[];
  stderr?: NodeJS.WriteStream;
};

function titleMatches(title: string, query: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return norm(title) === norm(query);
}

/** Full restore: discover (local) + inject SCW (remote) -> order -> filter -> launch. */
export function restore(
  opts: RestoreOptions = {},
): { windows: LayoutWindow[]; total: number; dropped: number } {
  const cfg = getLayoutConfig();
  const stderr = opts.stderr ?? process.stderr;

  // Remote tabs resolved by the caller from `remote ls` (fill `remote: true`
  // groups). Computed up-front so they can ALSO dedup the local discovery.
  const remoteTabs = opts.remoteTabs ?? [];

  // Local windows (groups + shared) — REGISTRY-FIRST: live enrolled sessions
  // are the truth; the filesystem scan only completes uncovered projects.
  const scanned = discoverSessions(cfg.maxAgeHours * 3600 * 1000);
  const allLocal = mergeDiscovered(registrySessions(), scanned);
  // Bug #3: a session moved to a remote Pod must NOT also be re-launched as a
  // ghost LOCAL tmux. Drop locals already covered by a remote tab.
  const { kept: sessions, dropped: remoteBacked } = dropRemoteBackedLocals(
    allLocal,
    remoteTabs,
  );
  if (remoteBacked.length > 0) {
    stderr.write(
      `[remote] ${remoteBacked.length} session(s) déjà sur le contrôle distant — pas de relance locale: ${[
        ...new Set(remoteBacked.map((s) => s.label ?? s.project)),
      ].join(", ")}\n`,
    );
  }
  const { windows: localWindows, dropped } = groupSessions(sessions, cfg);
  const localByTitle = new Map(localWindows.map((w) => [w.title, w]));

  // Remote windows: each `remote: true` group is filled with the SCW tabs.
  const remoteByTitle = new Map<string, LayoutWindow>();
  for (const g of cfg.groups) {
    if (!g.remote) continue;
    const tabs: LayoutTab[] = remoteTabs
      .slice(0, cfg.maxPerWindow)
      .map((t) => ({ label: t.label, cwd: t.cwd, remoteId: t.id }));
    if (tabs.length > 0) remoteByTitle.set(g.title, { title: g.title, tabs });
  }

  // Order: follow cfg.groups (local or remote), then any shared windows.
  let windows: LayoutWindow[] = [];
  for (const g of cfg.groups) {
    const w = g.remote ? remoteByTitle.get(g.title) : localByTitle.get(g.title);
    if (w) windows.push(w);
  }
  for (const w of localWindows) {
    if (!cfg.groups.some((g) => g.title === w.title)) windows.push(w);
  }

  // Scope to a single group/batch if requested.
  if (opts.group) windows = windows.filter((w) => titleMatches(w.title, opts.group!));

  const total = windows.reduce((n, w) => n + w.tabs.length, 0);
  for (const w of windows) {
    stderr.write(`  ${w.title} (${w.tabs.length}):\n`);
    for (const t of w.tabs) {
      const what = t.remoteId
        ? `SCW:${t.remoteId}`
        : `${t.tool} (local) [${t.origin === "registry" ? "registry" : "guess"}]`;
      stderr.write(`    - ${t.label}  ${what}  ${t.cwd}\n`);
    }
  }
  if (dropped > 0 && !opts.group)
    stderr.write(`  (! ${dropped} session(s) ignorée(s), plafond atteint)\n`);
  if (!opts.dryRun && total > 0) {
    launchLayout(windows, stderr);
    // Auto-record the launched layout (inspect with `remote layout show`).
    try {
      writeLastLayout(windows, opts.group);
    } catch {
      // best-effort: the windows are open regardless
    }
  }
  return { windows, total, dropped };
}

// ---------------------------------------------------------------------------
// layout-last.json — auto-recorded snapshot of the last launched layout
// ---------------------------------------------------------------------------

export type LastLayout = {
  at: string;
  group?: string;
  windows: Array<{
    title: string;
    tabs: Array<{ cwd: string; label: string; cmd: string }>;
  }>;
};

export function lastLayoutPath(): string {
  return join(dirname(resolveConfigPath()), "layout-last.json");
}

/** Persist the just-launched layout to <configDir>/layout-last.json (atomic). */
export function writeLastLayout(
  windows: LayoutWindow[],
  group?: string,
): void {
  const data: LastLayout = {
    at: new Date().toISOString(),
    ...(group !== undefined ? { group } : {}),
    windows: windows.map((w) => ({
      title: w.title,
      tabs: w.tabs.map((t) => ({
        cwd: t.cwd,
        label: t.label,
        cmd: tabCommand(t),
      })),
    })),
  };
  const path = lastLayoutPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

/** Read the recorded layout, or undefined when none was launched yet. */
export function readLastLayout(): LastLayout | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lastLayoutPath(), "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as LastLayout;
  } catch {
    return undefined;
  }
}
