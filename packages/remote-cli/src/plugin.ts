/**
 * `remote plugin` — install npm "plugin" packages (a CLI + an MCP server, e.g.
 * @sentropic/track shipping bins `track` and `track-mcp`) for every agent CLI
 * (claude, codex, agy), both LOCALLY (npm i -g + MCP registration) and inside
 * live REMOTE session Pods (`remote plugin sync`: kubectl exec → npm i -g +
 * per-profile MCP registration).
 *
 * agy (Antigravity CLI) has NO `agy mcp` subcommand: MCP servers are declared
 * in ~/.gemini/config/mcp_config.json, a Claude-style `{"mcpServers": {…}}`
 * JSON file (the agy changelog 1.0.3 calls this the "migrated" path; the old
 * ~/.gemini/antigravity/mcp_config.json is legacy). We merge idempotently and
 * keep a one-shot `.bak.<epoch>` backup the first time we touch a non-empty
 * file.
 *
 * KNOWN PITFALL — broken entrypoint guard through the npm-global symlink:
 * some packages (track@0.2.0) guard their entry script with a
 * "was-I-run-directly?" check that compares argv[1] with the module path;
 * invoked through the npm-global bin SYMLINK the two differ and the guard
 * never fires (the CLI/MCP silently does nothing). So MCP servers are ALWAYS
 * registered as `node <realpathSync(script)>` — never the bare bin name.
 *
 * Baking plugins into the session image is a separate TODO that belongs in
 * packages/session-agent/Dockerfile (left untouched here): until then a Pod
 * restart loses globally-installed plugins and `remote plugin sync` must be
 * re-run.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { listRemoteSessions } from "./attach.js";
import {
  getPlugins,
  getTunnel,
  setPlugins,
  type PluginEntry,
  type PluginInstall,
  type PluginMcp,
  type TunnelConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** MCP server names end up as TOML bare keys and shell words: keep them tame. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
/** npm package name, optionally scoped. */
const SAFE_PKG = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** Version as installed (1.2.3, 1.2.3-rc.1+build, …). */
const SAFE_VERSION = /^[0-9A-Za-z.+-]+$/;
/** Package-relative script path embedded in the Pod sync script. */
const SAFE_REL = /^[A-Za-z0-9_@./-]+$/;

function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(
      `invalid MCP server name "${name}" (allowed: letters, digits, "_", "-")`,
    );
  }
}

function assertSafePkg(pkg: string): void {
  if (!SAFE_PKG.test(pkg)) throw new Error(`invalid npm package name "${pkg}"`);
}

/**
 * The shell install command for a plugin + a one-line label. Pure, exported for
 * tests. npm (default): `npm install -g <pkg>@<ver>`. curl: pipe an https
 * installer (`curl -fsSL <url> | bash`) — the url is single-quoted and must be
 * a clean https URL. script: an arbitrary shell line straight from the user's
 * own config (no extra guard — it is the user's command). Same command runs
 * locally (pluginAdd) and in the Pod (buildPodSyncScript).
 */
export function buildInstallCommand(plugin: PluginEntry): {
  cmd: string;
  label: string;
} {
  const method = plugin.install?.method ?? "npm";
  if (method === "npm") {
    assertSafePkg(plugin.pkg);
    assertSafeVersion(plugin.version);
    const spec = `${plugin.pkg}@${plugin.version}`;
    return { cmd: `npm install -g '${spec}'`, label: `installed ${spec}` };
  }
  if (method === "curl") {
    const url = plugin.install?.spec ?? "";
    if (!/^https:\/\/[^'"\s]+$/.test(url)) {
      throw new Error(`invalid curl install url "${url}" (need a clean https URL)`);
    }
    return { cmd: `curl -fsSL '${url}' | bash`, label: `installed ${plugin.pkg} (curl)` };
  }
  // script: the user's own shell command, run verbatim.
  const sh = (plugin.install?.spec ?? "").trim();
  if (!sh) throw new Error(`empty script install for "${plugin.pkg}"`);
  return { cmd: sh, label: `installed ${plugin.pkg} (script)` };
}

function assertSafeVersion(version: string): void {
  if (!SAFE_VERSION.test(version)) throw new Error(`invalid version "${version}"`);
}

function assertSafeRel(rel: string): void {
  if (!SAFE_REL.test(rel) || rel.split("/").includes("..")) {
    throw new Error(`invalid package-relative script path "${rel}"`);
  }
}

/** Split `pkg[@version]` (scope-aware: the leading @ is not a version sep). */
export function splitNpmSpec(spec: string): { pkg: string; version?: string } {
  const at = spec.indexOf("@", 1);
  if (at === -1) return { pkg: spec };
  return { pkg: spec.slice(0, at), version: spec.slice(at + 1) };
}

export type McpRequest = { name: string; bin: string };

/** Parse one `--mcp <name>=<bin>` spec. */
export function parseMcpSpec(spec: string): McpRequest {
  const eq = spec.indexOf("=");
  if (eq <= 0 || eq === spec.length - 1) {
    throw new Error(
      `invalid --mcp "${spec}" — expected <name>=<bin> (e.g. track=track-mcp)`,
    );
  }
  const name = spec.slice(0, eq).trim();
  const bin = spec.slice(eq + 1).trim();
  assertSafeName(name);
  if (!bin) throw new Error(`invalid --mcp "${spec}" — empty bin`);
  return { name, bin };
}

export function parseMcpSpecs(specs: readonly string[]): McpRequest[] {
  return specs.map(parseMcpSpec);
}

/**
 * Heuristic when no --mcp is given: every bin ending in `-mcp` is an MCP
 * server named after the bin minus the suffix (track-mcp → track).
 */
export function detectMcpBins(bins: Readonly<Record<string, string>>): McpRequest[] {
  const requests: McpRequest[] = [];
  for (const bin of Object.keys(bins).sort()) {
    if (!bin.endsWith("-mcp")) continue;
    const name = bin.slice(0, -"-mcp".length);
    if (!name || !SAFE_NAME.test(name)) continue;
    requests.push({ name, bin });
  }
  return requests;
}

/** Normalize a package.json `bin` field (string or map) to name -> rel path. */
export function normalizeBins(
  pkgName: string,
  bin: unknown,
): Record<string, string> {
  if (typeof bin === "string") {
    const name = pkgName.split("/").pop() ?? pkgName;
    return { [name]: bin };
  }
  if (bin && typeof bin === "object") {
    const out: Record<string, string> = {};
    for (const [name, rel] of Object.entries(bin as Record<string, unknown>)) {
      if (typeof rel === "string") out[name] = rel;
    }
    return out;
  }
  return {};
}

/** The `[mcp_servers.<name>]` TOML section for ~/.codex/config.toml. */
export function codexMcpServerBlock(
  name: string,
  command: string,
  args: readonly string[],
): string {
  assertSafeName(name);
  return [
    `[mcp_servers.${name}]`,
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`,
  ].join("\n");
}

/**
 * Idempotently upsert the `[mcp_servers.<name>]` section in a config.toml
 * body: an existing section (up to the next `[…]` header) is replaced in
 * place, otherwise the block is appended. Applying twice is a no-op.
 */
export function upsertCodexMcpServer(
  toml: string,
  name: string,
  command: string,
  args: readonly string[],
): string {
  const block = codexMcpServerBlock(name, command, args); // validates the name
  // SAFE_NAME chars ([A-Za-z0-9_-]) are all regex-literal outside classes.
  const headerRe = new RegExp(`^\\s*\\[mcp_servers\\.${name}\\]\\s*$`);
  const lines = toml.split("\n");
  const start = lines.findIndex((line) => headerRe.test(line));
  if (start === -1) {
    const body = toml.replace(/\n+$/, "");
    return (body ? `${body}\n\n` : "") + block + "\n";
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  const replacement = block.split("\n");
  if (end < lines.length) replacement.push("");
  const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join(
    "\n",
  );
  // A section at EOF swallows the final-newline "" line element — restore it.
  return end >= lines.length && toml.endsWith("\n") && !next.endsWith("\n")
    ? next + "\n"
    : next;
}

/**
 * Idempotently merge `mcpServers.<name>` into a JSON config body (the shape
 * shared by ~/.claude.json and agy's mcp_config.json). Empty input starts a
 * fresh object; invalid JSON throws (never clobber the user's state). All
 * sibling keys are preserved.
 */
function mergeMcpServersJson(
  json: string,
  name: string,
  command: string,
  args: readonly string[],
  label: string,
): string {
  assertSafeName(name);
  let root: Record<string, unknown> = {};
  if (json.trim()) {
    const parsed: unknown = JSON.parse(json); // throws on corrupt input — on purpose
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} root is not an object — not touching it`);
    }
    root = parsed as Record<string, unknown>;
  }
  const existing = root.mcpServers;
  const servers =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  servers[name] = { command, args: [...args] };
  root.mcpServers = servers;
  return JSON.stringify(root, null, 2) + "\n";
}

/** Idempotent `mcpServers.<name>` merge for a ~/.claude.json body. */
export function mergeClaudeMcpServers(
  json: string,
  name: string,
  command: string,
  args: readonly string[],
): string {
  return mergeMcpServersJson(json, name, command, args, "claude.json");
}

/**
 * Idempotent `mcpServers.<name>` merge for agy's
 * ~/.gemini/config/mcp_config.json (same Claude-style shape — the agy binary
 * schema accepts command/args/env/url per server; we only emit command+args).
 */
export function mergeAgyMcpServers(
  json: string,
  name: string,
  command: string,
  args: readonly string[],
): string {
  return mergeMcpServersJson(json, name, command, args, "mcp_config.json");
}

/**
 * Pure write plan for agy's mcp_config.json: the merged body, whether it
 * differs from `before`, and whether a `.bak.<epoch>` backup is owed (only on
 * the FIRST real modification of a non-empty file — an empty/absent file has
 * nothing worth backing up, and an unchanged file is never rewritten).
 */
export function planAgyMcpConfigUpdate(
  before: string,
  name: string,
  command: string,
  args: readonly string[],
): { next: string; changed: boolean; needsBackup: boolean } {
  const next = mergeAgyMcpServers(before, name, command, args);
  const changed = next !== before;
  return { next, changed, needsBackup: changed && before.trim().length > 0 };
}

/**
 * In-Pod ~/.claude.json merge, run as `node -e '<this>' <name> <scriptPath>`.
 * Double quotes only — the snippet is single-quoted inside the bash script.
 */
export const POD_CLAUDE_MERGE_JS =
  'const fs=require("fs");const p=process.env.HOME+"/.claude.json";' +
  'let j={};try{const t=fs.readFileSync(p,"utf8");if(t.trim())j=JSON.parse(t)}' +
  'catch(e){if(e.code!=="ENOENT")throw e}' +
  'if(typeof j!=="object"||j===null||Array.isArray(j))j={};' +
  'const s=j.mcpServers&&typeof j.mcpServers==="object"&&!Array.isArray(j.mcpServers)?j.mcpServers:{};' +
  's[process.argv[1]]={command:"node",args:[process.argv[2]]};j.mcpServers=s;' +
  'fs.writeFileSync(p,JSON.stringify(j,null,2)+"\\n");';

/**
 * In-Pod ~/.gemini/config/mcp_config.json merge, run as
 * `node -e '<this>' <name> <scriptPath>`. Double quotes only — the snippet is
 * single-quoted inside the bash script. Same shape as the claude merge; the
 * config dir may not exist yet in a fresh Pod, hence mkdirSync.
 */
export const POD_AGY_MERGE_JS =
  'const fs=require("fs");const d=process.env.HOME+"/.gemini/config";' +
  "fs.mkdirSync(d,{recursive:true});" +
  'const p=d+"/mcp_config.json";' +
  'let j={};try{const t=fs.readFileSync(p,"utf8");if(t.trim())j=JSON.parse(t)}' +
  'catch(e){if(e.code!=="ENOENT")throw e}' +
  'if(typeof j!=="object"||j===null||Array.isArray(j))j={};' +
  'const s=j.mcpServers&&typeof j.mcpServers==="object"&&!Array.isArray(j.mcpServers)?j.mcpServers:{};' +
  's[process.argv[1]]={command:"node",args:[process.argv[2]]};j.mcpServers=s;' +
  'fs.writeFileSync(p,JSON.stringify(j,null,2)+"\\n");';

/** claude / claude-code → claude; codex → codex; agy / antigravity → agy. */
export function mcpTargetForProfile(
  profile: string,
): "claude" | "codex" | "agy" | "todo" {
  if (profile === "claude" || profile === "claude-code") return "claude";
  if (profile === "codex") return "codex";
  if (profile === "agy" || profile === "antigravity") return "agy";
  return "todo";
}

/**
 * Bash script run inside a session Pod (`kubectl exec … bash -lc`) by
 * `remote plugin sync`: installs the plugin globally, recomputes each MCP
 * script's realpath against the POD's npm global root (the local realpath is
 * meaningless there), then registers the MCP server for the Pod's profile.
 * Every step echoes one line — the CLI prints them as the per-session recap.
 */
export function buildPodSyncScript(plugin: PluginEntry, profile: string): string {
  const { cmd, label } = buildInstallCommand(plugin);
  const lines: string[] = [
    "set -e",
    `${cmd} >/dev/null 2>&1`,
    `echo "${label}"`,
    `ROOT="$(npm root -g)"`,
  ];
  const target = mcpTargetForProfile(profile);
  for (const mcp of plugin.mcp) {
    assertSafeName(mcp.name);
    if (!mcp.scriptRel) {
      lines.push(
        `echo "mcp ${mcp.name}: no scriptRel recorded — re-run: remote plugin add ${plugin.pkg}"`,
      );
      continue;
    }
    assertSafeRel(mcp.scriptRel);
    if (target === "todo") {
      lines.push(
        `echo "mcp ${mcp.name}: profile ${profile} TODO non câblé (installed only)"`,
      );
      continue;
    }
    // realpath INSIDE the Pod (same symlink pitfall as locally — see header).
    lines.push(
      `REAL="$(node -p 'require("fs").realpathSync(process.argv[1])' "$ROOT/${plugin.pkg}/${mcp.scriptRel}")"`,
    );
    if (target === "claude") {
      lines.push(
        `node -e '${POD_CLAUDE_MERGE_JS}' '${mcp.name}' "$REAL"`,
        `echo "mcp ${mcp.name} -> claude.json (node $REAL)"`,
      );
    } else if (target === "agy") {
      lines.push(
        `node -e '${POD_AGY_MERGE_JS}' '${mcp.name}' "$REAL"`,
        `echo "mcp ${mcp.name} -> agy mcp_config.json (node $REAL)"`,
      );
    } else {
      lines.push(
        `mkdir -p "$HOME/.codex"`,
        `touch "$HOME/.codex/config.toml"`,
        `if grep -q "^\\[mcp_servers\\.${mcp.name}\\]" "$HOME/.codex/config.toml"; then ` +
          `echo "mcp ${mcp.name} already in codex config.toml"; else ` +
          `printf '\\n[mcp_servers.${mcp.name}]\\ncommand = "node"\\nargs = ["%s"]\\n' "$REAL" >> "$HOME/.codex/config.toml"; ` +
          `echo "mcp ${mcp.name} -> codex config.toml (node $REAL)"; fi`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Local side effects (npm, claude/codex registration)
// ---------------------------------------------------------------------------

function npmGlobalRoot(): string {
  const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`npm root -g failed: ${(r.stderr || "").trim()}`);
  }
  return r.stdout.trim();
}

function commandExists(cmd: string): boolean {
  const r = spawnSync("bash", ["-lc", `command -v ${cmd}`], { stdio: "ignore" });
  return r.status === 0;
}

function installGlobally(spec: string, stderr: NodeJS.WriteStream): void {
  const r = spawnSync("npm", ["install", "-g", spec], { encoding: "utf8" });
  if (r.status !== 0) {
    const tail = (r.stderr || r.stdout || "")
      .trim()
      .split("\n")
      .slice(-3)
      .join(" | ");
    throw new Error(`npm install -g ${spec} failed: ${tail}`);
  }
  // stdio summary: npm's "added N packages in Xs" line, not the full wall.
  const summary =
    (r.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^(added|changed|removed|up to date)/.test(line)) ??
    "installed";
  stderr.write(`[remote] npm i -g ${spec}: ${summary}\n`);
}

function readFileIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Register an MCP server with claude: `claude mcp add --scope user` when the
 * CLI is available (remove-first for idempotence — add errors on an existing
 * name), else merge ~/.claude.json mcpServers directly.
 */
function registerClaudeLocal(
  name: string,
  scriptPath: string,
  stderr: NodeJS.WriteStream,
): void {
  if (commandExists("claude")) {
    spawnSync("claude", ["mcp", "remove", "--scope", "user", name], {
      stdio: "ignore",
    });
    const r = spawnSync(
      "claude",
      ["mcp", "add", "--scope", "user", name, "--", "node", scriptPath],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      throw new Error(
        `claude mcp add ${name} failed: ${(r.stderr || r.stdout || "").trim()}`,
      );
    }
    stderr.write(`[remote] claude: MCP ${name} -> node ${scriptPath} (scope user)\n`);
    return;
  }
  const path = join(homedir(), ".claude.json");
  writeFileSync(
    path,
    mergeClaudeMcpServers(readFileIfExists(path), name, "node", [scriptPath]),
    "utf8",
  );
  stderr.write(
    `[remote] claude: MCP ${name} merged into ~/.claude.json (claude CLI not found)\n`,
  );
}

/**
 * Idempotent `mcpServers.<name>` merge into ~/.gemini/config/mcp_config.json
 * (agy has no `mcp add` CLI command — file merge is the only mechanism). The
 * first time a non-empty file is actually modified we keep a `.bak.<epoch>`
 * sibling; an unchanged file is never rewritten.
 */
function registerAgyLocal(
  name: string,
  scriptPath: string,
  stderr: NodeJS.WriteStream,
): void {
  const dir = join(homedir(), ".gemini", "config");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "mcp_config.json");
  const before = readFileIfExists(path);
  const { next, changed, needsBackup } = planAgyMcpConfigUpdate(
    before,
    name,
    "node",
    [scriptPath],
  );
  if (!changed) {
    stderr.write(`[remote] agy: MCP ${name} already in ${path} (unchanged)\n`);
    return;
  }
  if (needsBackup) {
    const backup = `${path}.bak.${Date.now()}`;
    writeFileSync(backup, before, "utf8");
    stderr.write(`[remote] agy: backed up ${path} -> ${backup}\n`);
  }
  writeFileSync(path, next, "utf8");
  stderr.write(
    `[remote] agy: MCP ${name} -> node ${scriptPath} in ~/.gemini/config/mcp_config.json\n`,
  );
}

/** Idempotent `[mcp_servers.<name>]` upsert in ~/.codex/config.toml. */
function registerCodexLocal(
  name: string,
  scriptPath: string,
  stderr: NodeJS.WriteStream,
): void {
  const dir = join(homedir(), ".codex");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.toml");
  writeFileSync(
    path,
    upsertCodexMcpServer(readFileIfExists(path), name, "node", [scriptPath]),
    "utf8",
  );
  stderr.write(
    `[remote] codex: [mcp_servers.${name}] -> node ${scriptPath} in ~/.codex/config.toml\n`,
  );
}

// ---------------------------------------------------------------------------
// kubectl exec into session Pods (pattern: soft-refresh.ts)
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function kubeEnv(tunnel: TunnelConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (tunnel.kubeconfig) env.KUBECONFIG = expandHome(tunnel.kubeconfig);
  return env;
}

/** Exec a bash -lc script in the session-agent container. Throws on non-zero. */
function execPod(tunnel: TunnelConfig, pod: string, script: string): string {
  const r = spawnSync(
    "kubectl",
    [
      "-n",
      tunnel.namespace,
      "exec",
      pod,
      "-c",
      "session-agent",
      "--",
      "bash",
      "-lc",
      script,
    ],
    { encoding: "utf8", env: kubeEnv(tunnel) },
  );
  if (r.status !== 0) {
    throw new Error(
      `kubectl exec ${pod} failed: ${(r.stderr || r.stdout || "").trim()}`,
    );
  }
  return r.stdout;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * `remote plugin add <npmPkg> [--mcp name=bin]...` — npm i -g, register the
 * MCP server(s) with claude + codex + agy, persist in the config.
 */
export function pluginAdd(
  npmSpec: string,
  mcpSpecs: readonly string[],
  stderr: NodeJS.WriteStream = process.stderr,
): PluginEntry {
  const { pkg, version: requestedVersion } = splitNpmSpec(npmSpec);
  assertSafePkg(pkg);
  if (requestedVersion !== undefined) assertSafeVersion(requestedVersion);

  installGlobally(npmSpec, stderr);

  const pkgDir = join(npmGlobalRoot(), pkg);
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    version?: string;
    bin?: unknown;
  };
  const version = pkgJson.version ?? requestedVersion ?? "latest";
  assertSafeVersion(version);
  const bins = normalizeBins(pkg, pkgJson.bin);

  const requests =
    mcpSpecs.length > 0 ? parseMcpSpecs(mcpSpecs) : detectMcpBins(bins);
  if (requests.length === 0) {
    stderr.write(
      `[remote] no MCP bin detected for ${pkg} (none ends in -mcp; bins: ${Object.keys(bins).join(", ") || "none"}) — pass --mcp <name>=<bin>\n`,
    );
  }

  const mcp: PluginMcp[] = [];
  for (const { name, bin } of requests) {
    const rel = bins[bin];
    if (!rel) {
      throw new Error(
        `package ${pkg} has no bin "${bin}" (bins: ${Object.keys(bins).join(", ") || "none"})`,
      );
    }
    // realpathSync: NEVER register the bare bin — the npm-global symlink breaks
    // some packages' entrypoint guard (track@0.2.0). See the module header.
    const scriptPath = realpathSync(join(pkgDir, rel));
    const scriptRel = rel.replace(/^\.\//, "");
    registerClaudeLocal(name, scriptPath, stderr);
    registerCodexLocal(name, scriptPath, stderr);
    registerAgyLocal(name, scriptPath, stderr);
    mcp.push({ name, command: "node", args: [scriptPath], scriptRel });
  }

  const entry: PluginEntry = { pkg, version, mcp };
  setPlugins([...getPlugins().filter((p) => p.pkg !== pkg), entry]);
  stderr.write(
    `[remote] plugin ${pkg}@${version} installed — ${mcp.length} MCP server(s) registered; persisted in remote config\n`,
  );
  stderr.write(
    `[remote] propagate to live remote sessions with: remote plugin sync\n`,
  );
  return entry;
}

/**
 * `remote plugin add <name> --curl <url>` / `--install "<shell>"` — register a
 * NON-npm plugin (a tool installed by piping an https script, or an arbitrary
 * shell command). No local install is run (unlike the npm path, which must read
 * the package to detect MCP bins): the installer runs in each Pod on
 * `remote plugin sync`. Validates the command up front so a bad URL fails now.
 */
export function pluginAddInstaller(
  name: string,
  install: PluginInstall,
  stderr: NodeJS.WriteStream = process.stderr,
): PluginEntry {
  assertSafePkg(name);
  const entry: PluginEntry = { pkg: name, version: "installer", mcp: [], install };
  buildInstallCommand(entry); // throws on a bad curl url / empty script
  setPlugins([...getPlugins().filter((p) => p.pkg !== name), entry]);
  stderr.write(
    `[remote] plugin ${name} (${install.method}) persisted — installs in Pods on \`remote plugin sync\`\n`,
  );
  return entry;
}

/** `remote plugin ls` — pkg / version / MCPs / where (local ok, remote ?). */
export function pluginLs(stdout: NodeJS.WriteStream = process.stdout): void {
  const plugins = getPlugins();
  if (plugins.length === 0) {
    stdout.write("[remote] no plugins configured (remote plugin add <npmPkg>)\n");
    return;
  }
  let root: string | undefined;
  try {
    root = npmGlobalRoot();
  } catch {
    root = undefined;
  }
  const w = (s: string, n: number) => s.padEnd(n);
  stdout.write(
    `${w("PKG", 28)} ${w("VERSION", 9)} ${w("MCPS", 20)} ${w("LOCAL", 8)} REMOTE\n`,
  );
  for (const p of plugins) {
    const local =
      root && existsSync(join(root, p.pkg, "package.json")) ? "ok" : "missing";
    const mcps = p.mcp.map((m) => m.name).join(",") || "-";
    stdout.write(
      `${w(p.pkg, 28)} ${w(p.version, 9)} ${w(mcps, 20)} ${w(local, 8)} ?\n`,
    );
  }
  stdout.write(
    "\n(REMOTE \"?\": per-Pod state is not tracked — `remote plugin sync` installs/refreshes every live session.)\n",
  );
}

/**
 * `remote plugin sync` — for every live remote session: kubectl exec into the
 * Pod, `npm i -g <pkg>@<version>`, then register the MCP servers for the
 * Pod's profile. Prints a per-session recap. Needs the configured tunnel.
 */
export async function pluginSync(
  url: string,
  stderr: NodeJS.WriteStream = process.stderr,
): Promise<void> {
  const plugins = getPlugins();
  if (plugins.length === 0) {
    stderr.write("[remote] no plugins configured (remote plugin add <npmPkg>)\n");
    return;
  }
  const tunnel = getTunnel();
  if (!tunnel) {
    throw new Error(
      "plugin sync needs a tunnel configured (remote config tunnel …)",
    );
  }
  const sessions = await listRemoteSessions(url);
  if (sessions.length === 0) {
    stderr.write("[remote] no live remote sessions to sync\n");
    return;
  }
  let failures = 0;
  for (const session of sessions) {
    const pod = `session-${session.id}`;
    stderr.write(`[remote] ${session.id} (${session.profile}):\n`);
    for (const plugin of plugins) {
      try {
        const out = execPod(tunnel, pod, buildPodSyncScript(plugin, session.profile));
        for (const line of out.trim().split("\n").filter(Boolean)) {
          stderr.write(`    ${line}\n`);
        }
      } catch (error) {
        failures++;
        stderr.write(
          `    ${plugin.pkg}@${plugin.version} FAILED: ${String(error).slice(0, 200)}\n`,
        );
      }
    }
  }
  stderr.write(
    `[remote] plugin sync done: ${sessions.length} session(s), ${plugins.length} plugin(s)${failures > 0 ? `, ${failures} failure(s)` : ""}\n`,
  );
  if (failures > 0) process.exitCode = 1;
}
