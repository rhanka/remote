# Changelog

All notable changes to Sentropic Remote are documented here.
The project uses date-based, image-tagged releases (`vMAJOR.MINOR.PATCH`);
container images `ghcr.io/rhanka/sentropic-remote-{control-plane,session-agent}`
are tagged to match.

## v0.5.5 — 2026-06-10

Headline: **headful browser-in-pod via noVNC** — complete a 2FA / login
challenge on an authenticated site, by hand, inside a remote session Pod.

- **`remote browser open <sessionId>`** `[--local-port] [--policy] [--ttl]
  [--view-only]` — prints the two-step flow: `remote forward <id> 6080` then a
  token-gated noVNC URL. Interactive by default (you drive the 2FA);
  `--view-only` for read-only.
- **Opt-in sidecar** (`sentropic-remote-browser` image: Xvfb + headful Chromium
  + x11vnc + websockify + noVNC), added as a 2nd Pod container only when the
  session descriptor sets `metadata.browser` — not baked into every session
  image. Resource-capped (1 CPU / 1Gi), shares the Pod network namespace
  (binds the port `remote forward` reaches) and the workspace volume.
- **Auth**: a per-session 128-bit noVNC token, injected at runtime
  (`NOVNC_TOKEN`, websockify `--token-plugin`) — never in the image/manifest;
  a token-less forwarded URL is refused.
- **`uat-exposure-policy`** enforced: `operator-only` (operator), `session-private`
  (operator/owner + token, anonymous denied), `public-expiring` (any + token +
  finite TTL). Real `browser.*` protocol messages replace the stub. 494 cli +
  46 browser-bridge tests.
- Needs live-cluster validation (build/push the browser image; e2e
  sidecar→forward→noVNC→2FA) and a control-plane field to set `metadata.browser`
  on session create — tracked as follow-ups.

## v0.5.4 — 2026-06-10

Headline: **durable workspace id aligned with h2a/track** — `conductor-launch`
now computes the same `ws:<hex>` id the maintainer puts on the envelope.

- `computeDurableWorkspaceId` switched from a remote-url hash to the
  byte-identical h2a 0.68 / track algorithm:
  `ws:` + sha256(`rootCommitSHA` + "\n" + `worktreeRelPath`), where
  `rootCommitSHA` = all `git rev-list --max-parents=0 HEAD` roots sorted/joined
  and `worktreeRelPath` = "" for the primary worktree else `basename(git-dir)`.
  Invariant across clone/fork/path/machine. Pinned vectors shared with track
  are asserted in tests; `/src/remote` → `ws:febb5c4c…`. 488 tests.

## v0.5.3 — 2026-06-10

Headline: **remote fan-out** — launch a fleet of N concurrent remote sessions
in one command, each on its own workspace subPath of the shared RWX volume.

- **`remote <profile> --remote --count N [--name <base>]`** (claude/codex/agy/
  opencode/shell) — creates N concurrent remote session Pods named `<base>-NN`,
  each with its OWN `createWorkspace` → distinct `subPath` on the ONE shared
  RWX File-Storage volume (never one PVC per session; RWX mounts RW on many
  nodes, so N concurrent pods is fine). Prints a `NAME/SESSION/WORKSPACE/STATUS`
  table; never auto-attaches a fleet. `--count 1` is a byte-for-byte passthrough.
- Bounded-concurrent creation, cap `DEFAULT_FANOUT_MAX = 16` (mirrors the
  delegation default). `--count>1` rejects `--resume`/`--sync`/mapped-workspace;
  dead Pods drop off the live list via the existing `listRemoteSessions`
  reconciliation. 487 tests.

## v0.5.2 — 2026-06-10

Headline: **skills follow the session to the Pod** — remote claude sessions now
get the same Claude Code skills & plugins as local ones.

- **`remote plugin sync-skills`** `[--pod <name>|--all] [--dry-run] [--remote <url>]`
  — propagates the local Claude Code skill/plugin state into a Pod's
  `$HOME/.claude/` so delegated/remote claude sessions have the same
  capabilities (superpowers, track, the h2a skill, graphify, sent-tech-design).
  Deterministic "copy the resolved cache" approach (the marketplace-reinstall
  fork is documented but not the default).
- **Whitelist-only, never leaks auth**: transfers exactly `.claude/skills`,
  `.claude/plugins/{installed_plugins.json,marketplaces,cache}` and nothing
  else — `settings.json`, `.credentials.json`, `~/.claude.json`, `projects/`
  are explicitly excluded (asserted by tests). Archive rides stdin
  (`tar -c … | kubectl exec -i -- tar -x`); no path/content ever interpolated
  into a `bash -lc` string. `--all` enumerates running session Pods; `--dry-run`
  prints the plan and transfers nothing. 469 tests.

## v0.5.1 — 2026-06-10

Headline: **cross-type async delegation** — `remote` can now delegate an agent
of any type (claude/codex/agy) into a tmux session, local **or** on a Pod,
supervise it, and close the loop when it finishes.

- **`remote delegate <type> "<task>"`** `[--remote] [--headless] [--name]
  [--cwd] [--parent] [--on-done] [--max-concurrent N (default 16)]
  [--max-depth] [--track]` — spawns a claude/codex/agy agent that lives in an
  attachable tmux session (interactive by default; `--headless` runs-once-exits).
  Task payload is passed as argv, never concatenated into `bash -lc`.
- **`remote jobs ls|status|attach|logs|decisions|decide|conduct`** — a job
  registry (`role:"job"`, jobState pending→running→done|failed) with liveness
  guards (tmux has-session, pid+/proc cmdline, boot-time guard) and a
  foreground conductor watch loop (`conduct`) — not a daemon.
- **h2a callback**: a finished job emits a signed `job.done` envelope; the
  parent/conductor reconciles via the claude hook (`REMOTE_JOB_ID`) and by
  reading `result.json` under the job's `originCwd`. Decision channel
  (`decisions`/`decide`) shipped **EXPERIMENTAL** (relies on the agent polling
  its h2a inbox).
- **`remote conductor-launch`** `[--confirm] [--watch <min>] [--cooldown <min>]`
  — handler for h2a's `conductor-launch-request` contract: when h2a reports a
  workspace with stalled work and no live conductor, this launches one via the
  delegation path (host = first available of `hostPref`), idempotently (dedup on
  a deterministic conductor slug + best-effort `h2a discover`), gated by
  `--confirm`, with a per-workspace cooldown (default 30 min).
- **Hardening** (from the a2a-cli adversarial review): registry mutations
  serialized under `flock` with an atomic check-cap+enroll; `job.done`/
  `decision.reply` envelopes authenticated on `actor.instance`; stale-job sweep;
  remote delegation depth clamped. Job result read at `originCwd` (was process
  cwd → false failures). 449 tests.

## v0.5.0 — 2026-06-07

Headline: **the launcher grows up** — real live-session registry instead of
guessing, ONE shared RWX volume for all workspaces, self-healing fleet auth,
and plugins/h2a wired across local *and* deported sessions.

- **Shared RWX workspace volume** (`SESSION_SHARED_WORKSPACE_PVC`): all
  workspaces live as subPaths of ONE File Storage volume (Scaleway minimum is
  100G *per volume*, and the CSI mounts at most one File Storage volume per
  node) — sessions pack onto one node instead of spreading, and storage stops
  multiplying. `workspace rm` never deletes the shared volume.
- **Explicit GC** (`remote workspace gc [--older-than N] [--apply --yes]`):
  ephemeral janitor pod mounts the volume root (affinity to session nodes —
  the only placement the 1-volume/node CSI guarantees), keep-list = every
  workspace known to the store re-checked *inside* the pod, candidates are
  tar'd to on-volume `.trash/` before any `rm`. Dry-run by default.
- **Live-session registry + autoenrollment** (`remote enroll`): claude
  SessionStart/End hooks (installed once via `--install-hooks`, with backup)
  enroll every session into `registry.json`; `remote run` enrolls its tmux
  sessions; `remote ls` shows `[registry]` vs `[guess]`; `remote restore` is
  registry-first (filesystem scan only fills the gaps) and auto-records the
  launched layout (`remote layout show`).
- **Fleet auth that heals itself**: the agent announce now carries
  `home`/`startupArgs`/`cliSessionId`, so a control-plane restart loses
  nothing and a refresh resumes the *freshest* conversation (not the one the
  pod was created with). `remote refresh --soft --all [--watch <min>]`
  re-pushes local credentials to every live session — respawn gated on a
  sha256 of the credential files only (volatile `.claude.json` churn doesn't
  thrash pods), and a dead pod CLI is revived even when creds are unchanged.
- **Single-writer guard** (`conv-guard`): `remote run -r <conv>` and
  `remote migrate forward -r <conv>` refuse to resume a conversation that
  already has a live writer (local registry + remote `cliSessionId`), with a
  loud `--force` override. Conversation `.jsonl` files are the asset; two
  writers corrupt them.
- **`remote sync <id> --session push|pull` and `remote diff --files`**:
  guarded conversation copy (line-count guard + `.bak-<epoch>` backups, base64
  encoded exactly once) and git-state comparison local vs Pod (names/HEAD
  only, content never transferred).
- **`remote plugin add/ls/sync`**: install an npm plugin package (CLI + MCP
  server, e.g. `@sentropic/track`) locally and into every live session Pod,
  registering its MCP server(s) with **claude + codex + agy** (Antigravity's
  `~/.gemini/config/mcp_config.json` discovered and supported). MCPs are
  registered as `node <realpath>` — the npm-global symlink breaks some
  entrypoint guards.
- **h2a wiring**: `remote run --h2a` starts the h2a MCP server in a side tmux
  window (launcher contract), and `remote h2a bridge [--watch]` transports
  envelopes pod↔local (pull emitted, push addressed, idempotent by file name,
  never deletes — acks belong to h2a).
- **Wheel scrolls the conversation, everywhere**: the Pod image's tmux conf
  and the local server (`ensureScrollConfig` at every run/attach) both bind
  WheelUp → copy-mode; `mouse on` so the wheel stops cycling the CLI's input
  history. Native selection: Shift+drag; OSC52 preserved.
- **Images**: `runtime-slim` variant (1.26GB vs 2.47GB fat — no Go/Rust/
  build-essential) published as `:vX-slim`/`:main-slim`; pre-pull DaemonSet
  (`deploy/scw/40-prepull.yaml`, `make scw-prepull`) keeps the fat image warm
  on the session pool so cold starts stop costing 6-9 min.
- **Fixes**: per-profile resume argv (`codex resume <id>` subcommand — the
  old `--continue <id>` was invalid; bare claude `--resume` opened an
  interactive picker), hono 4.12.23 (4 moderate advisories), restore surfaces
  gnome-terminal spawn errors, `refresh` survives create-while-terminating
  (409 retry), conversation mounts under the shared volume subPath.

## v0.4.3 — 2026-06-05

Headline: **tmux-backed sessions**, local and remote, for simpler juggling and
robust detach/reattach.

- **Local sessions** (`remote run <profile> [path]`): start a CLI (claude/codex/…)
  in a local tmux session and manage it like a remote one — `remote ls` lists
  LOCAL (tmux) and REMOTE (control-plane) sessions uniformly, `remote attach
  <slug>` / `remote stop <slug>` operate on local sessions by their workdir slug.
- **In-Pod tmux** (`SESSION_TMUX=1`, default for interactive profiles): the
  session-agent runs the wrapped CLI inside a durable tmux session and proxies a
  tmux *client* over the WS. Detaching (Ctrl-b d, or an `--exec` client leaving)
  no longer ends the session — a reattach loop keeps the proxy alive; the session
  ends only when the tmux session itself ends.
- **`remote attach <id> --exec`**: attach straight into the Pod's tmux via
  `kubectl exec -it` — the local terminal owns scrollback and copy-to-clipboard
  (OSC52), with no WS proxy in the middle. Fixes "I can't copy what the CLI
  printed". The agent image ships `tmux` + `/etc/tmux.conf` (50k history,
  `set-clipboard on`, `mouse on`).

## v0.4.2 — 2026-06-02

Headline: the control-plane becomes **restart-durable**, and a control-plane
crash can no longer take down every running session.

### Fixed
- **A failed provision no longer crashes the control-plane.** A rejecting
  `K8sSessionProvisioner.provision` (e.g. a k8s `403 exceeded quota`) used to be
  an unhandled rejection that killed the process — and since the session store
  is in-process, *every* running session was orphaned. It is now caught: emit a
  `failed` lifecycle event and clean up the orphaned record.

### Added
- **Control-plane durability via agent re-announce.** The session-agent's WS
  transport now self-heals (reconnect with full-jitter backoff) and the agent
  process lifetime is decoupled from the socket — a transient drop
  (control-plane restart) no longer ends the agent; only the wrapped PTY exiting
  does. On every (re)connect the agent sends a `session.announce` frame, and the
  control-plane repopulates its `SessionStore` + tenant mapping from it. After a
  restart, running sessions re-announce themselves and become listable /
  attachable / stoppable again — no datastore, no new RBAC, self-correcting
  (a terminated agent never reconnects, so no zombies). The store stays behind an
  interface so a future sentropic-provided DB swaps in unchanged.
  (Protocol: `session.announce` agent→control-plane frame.)
- **RWX workspaces** (Scaleway File Storage CSI): the session workspace PVC can
  be `ReadWriteMany` on a POP2 pool, env-driven (`SESSION_STORAGE_CLASS`,
  `SESSION_STORAGE_ACCESS_MODE`, `SESSION_WORKSPACE_SIZE`, `SESSION_NODE_SELECTOR`)
  — enables multiple agents on one workspace.
- **`remote migrate forward --no-attach`**: create the remote session without
  hijacking the terminal (bulk migration / reconnect-your-own-terminal); and
  `migrate forward` now bundles the profile's credentials into the session.

### Notes
- SCW deployment tracks the `:main` image tag (migration POC); pinned consumers
  (k3s manifests, Makefile, the session-agent default) move to `:v0.4.2`.
- Known gap (deferred): the narrow window where a `201` is returned before the
  Pod is durable in etcd; the durable fix lands with the sentropic DB.

## v0.4.1 — 2026-05-28

Follow-ups on top of v0.4.0's multi-tenant base.

### Added
- **Per-session service token for session-agent callbacks under bearer**: when
  `REMOTE_AUTH` is enabled, the control-plane mints a short-lived JWT
  (`sub`/`sid`, `aud: remote-session-agent`) per session and injects it as
  `REMOTE_TOKEN` into the session container; the agent sends it on its workspace
  fetch/export and `cli-session` callbacks. Signed with `REMOTE_SESSION_TOKEN_SECRET`
  (falls back to `REMOTE_AUTH_SECRET`). Off-mode injects/sends nothing.
- Security hardening: the `remote-session-agent` audience is reserved (user
  tokens carrying it are rejected), the token is bound to its one session
  (`sid` enforced on `/sessions/:id/*`), and the control-plane warns at startup
  if auth is enabled with no session secret.
- **Operator guide** `docs/multi-tenant-auth.md` (all auth env vars + caveats).
- **OpenAPI**: declares the `bearerAuth` security scheme, applies it
  document-wide (with `/healthz` public), documents `401` on protected routes,
  and now covers the `/workspaces` routes and `POST /sessions/:id/terminal/input`.

### Notes
- Remaining for a real multi-tenant rollout (tracked, not in this repo's flow):
  the poc-k8s `POST /tenants` operator, an optional `SentropicOIDCAuthenticator`,
  and moving `REMOTE_TOKEN` from a plain env var to a mounted Secret.

## v0.4.0 — 2026-05-28

Headline: the control-plane becomes **multi-tenant**. Each request authenticates
to a `userId`, resolves a per-user Kubernetes namespace, and every session and
workspace operation is scoped to it — a user can neither see nor act on another
user's resources. Backward compatible: `REMOTE_AUTH=off` (the default) keeps the
single-namespace `sentropic-remote` behavior with zero config.

### Added
- **Pluggable `Authenticator` seam** (`apps/control-plane/src/auth/`):
  `OffAuthenticator` (default → user `default`) and `BearerAuthenticator`
  (HS256 shared secret or JWKS, `sub` → `userId`), selected via `REMOTE_AUTH`
  (`off` | bearer) + `REMOTE_AUTH_SECRET` / `REMOTE_AUTH_JWKS_URL` /
  `REMOTE_AUTH_ISSUER`. Hono `authMiddleware` runs it on `/sessions*` and
  `/workspaces*`, sets `c.var.auth`, and returns `401 auth.unauthorized` on
  failure. Health and OpenAPI stay public.
- **Per-user namespace resolution** (`tenancy/namespace.ts`):
  `tenantNamespace(userId)` maps `default` → `sentropic-remote`, any other id →
  a deterministic, DNS-safe `user-<sha8>`.
- **`TenantProvisioner`** (`tenancy/tenant-provisioner.ts`):
  `StubTenantProvisioner` (dev/no-auth) and `PocK8sTenantProvisioner` (lazy,
  cached `POST {POC_K8S_TENANTS_URL}/tenants`), selected via env. The
  control-plane holds no namespace-create power; poc-k8s owns tenant lifecycle.
- **`remote config token <value>`** + `REMOTE_TOKEN` env: the CLI sends
  `Authorization: Bearer` on every control-plane call (env wins over stored).
- **Two-user isolation e2e** (`make e2e-isolation`, docker backend): user B
  cannot list or stop user A's session (404, no existence leak).

### Changed
- `K8sSessionProvisioner` is **namespace-per-call**: `ProvisionOptions.namespace`
  and `destroy(sessionId, emit, namespace?)` override the constructor namespace.
  InMemory/Docker backends accept the parameter for parity and ignore it.
- `SessionStore` is **partitioned by owner**: `put/get/list/delete` take a
  `userId`; cross-user `get`/`delete` return undefined/false, `list` is filtered.

### Notes
- Real multi-tenant rollout still needs the poc-k8s `POST /tenants` operator
  (sibling spec) and, optionally, a `SentropicOIDCAuthenticator`. Under bearer
  auth the session-agent's workspace fetch/export will need a user-scoped token
  (tracked separately). None of this affects `REMOTE_AUTH=off` deployments.

## v0.3.1 — 2026-05-26

### Added
- **Operator-UI workspaces panel**: list workspaces with a 🔒 lock badge
  (holder), create, and delete. `GET /workspaces[/:id]` now include the live
  soft-lock. (Push/pull/merge stay CLI — they need the local filesystem.)
- **`remote ls` shows the wrapped CLI's conversation id** in a new `CLI_SESSION`
  column: the session-agent detects it (newest file in the profile's
  conversation dir) and reports it via `POST /sessions/:id/cli-session`;
  `cliSessionId` added to `SessionDescriptor`.

## v0.3.0 — 2026-05-25

Headline: workspaces gain **session continuity** — a CLI conversation started
remotely can resume in a later remote session or be brought back to your local
machine, with conflict-aware restore and h2a presence discovery.

### Added
- **Conversation state persists with the workspace (P2a)**: the session-agent
  restores `<workspace>/.remote/sessions/<profile>/` into HOME on start and
  snapshots it back on the wrapped CLI's exit (`onBeforeExit` hook, before the
  cleanup cascade). codex `.codex/sessions`, claude `.claude/projects`, agy
  `.gemini/antigravity-cli/conversations`.
- **`remote workspace pull --restore-sessions` (P2b)**: brings remote
  conversation state into the local HOME. Per file: write if absent, overwrite
  if remote continues local (prefix), keep local if local is ahead, else
  **conflict** resolved by `--on-conflict backup` (duplicate local under a
  fresh id, keep both) | `keep-local` | block-and-report (default).
- **h2a presence projection (P2c)**: a workspace-bound session writes
  `/workspace/.h2a/presence/remote__<sid>.json` (DEC-059 contract,
  `safePathSegment`) on start and clears it on exit, so peers / an h2a sidecar
  can discover who's on the workspace.
- `SESSION_WORKSPACE_ID` env on session pods (informational, drives presence).

## v0.2.1 — 2026-05-25

### Fixed
- **`remote workspace pull` export race**: the throwaway export session exited
  immediately, so the `terminal.exited` cleanup cascade dropped the in-memory
  export before the CLI downloaded it ("nothing to pull"). The session is now
  kept alive while the CLI polls the export endpoint, then stopped explicitly.
  Validated live on k3d (take-remote, keep-local, and conflict paths).
- Conflict markers from `git merge-file` are now labelled
  `<path> (local|base|remote)` instead of temp file paths.

## v0.2.0 — 2026-05-25

Headline: the agent CLI surface becomes **remote-first** and explicit, the
Antigravity CLI (`agy`) replaces gemini-cli, credentials are handled
responsibly, and a session's working directory can be seeded from the local
cwd.

### Added
- **`agy` (Antigravity CLI)** profile, replacing `gemini-cli`. Installed in the
  session-agent image from the official `antigravity.google/cli/install.sh`.
- **`remote auth` sub-verbs**: `status [profile] [--all]` (diagnostic),
  `login <profile>` (drives the local sign-in flow for the
  not-yet-authenticated case), `push [url] <sid> [--all]` (explicit, named
  credential egress to a live session — `--all` seeds every local profile's
  creds into one Pod).
- **`remote check <profile>`** (user-facing health probe; `smoke` kept as a
  hidden alias).
- **`--resume [convId]`** on profile commands, mapped to each CLI's native
  `--continue`/`--resume`/`--conversation` flag.
- **`--sync`** on profile commands: tars the current directory (honoring
  `.gitignore` via `git ls-files`, 50 MiB cap) and seeds the remote
  `/workspace` before the CLI starts. New endpoints
  `POST/GET /sessions/:id/workspace`; the session-agent fetches-with-retry and
  extracts on startup.
- **Ctrl+P Ctrl+Q detach** in `remote attach` — leave the terminal without
  killing the remote session (banner shown on attach).
- **h2a host bridge schema** (`h2aBridgeProfileSchema` + `H2A_BRIDGE_PROFILE_V1`)
  mirroring `@sentropic/h2a` DEC-059; contract identity `remote` aligned with
  `@sentropic/h2a` v0.1.25.
- `SESSION_AGENT_IMAGE_PULL_POLICY` env override on the control-plane (local
  dev can use `IfNotPresent` while production keeps `Always`).
- **Persistent workspaces (epic P1)** — map a project to a remote workspace
  whose retained PVC survives sessions:
  - `Workspace` resource (`POST/GET/DELETE /workspaces`) + retained PVC
    `workspace-<id>`; a session bound via `workspaceId` mounts it at
    `/workspace` instead of an ephemeral volume.
  - `remote workspace link|list|status|push|pull|rm` + `.remote/workspace.json`
    marker; profile commands auto-bind to the mapped workspace
    (`--no-workspace` opts out).
  - `pull` does a **3-way merge** (base snapshot common ancestor, `git
    merge-file`, conflict markers + non-zero exit); `push`/`pull` honor an
    advisory **soft-lock** (`/workspaces/:id/lock`, TTL auto-expiry, `--force`
    to override).

### Changed
- **Remote-first CLI**: a bare `remote <profile>` now targets the configured
  default remote (errors with guidance if none is set). `--remote <url>`
  overrides the URL; `--local` runs the in-process PTY. The previous
  "no `--remote` = local" behavior is gone.
- **Canonical profile ids** `claude` (was `claude-code`) and `agy` (was
  `antigravity`); old names kept as aliases. `remote ls` shows the short names.
- `remote refresh <sid>` auto-detects the session profile (warns on a
  `--profile` mismatch) instead of requiring `--profile`.
- Session creation prints a **disclosure line** naming the credential files it
  sends and the target (no more silent bundling).

### Fixed
- **claude re-auth in Pod**: credentials are now materialized to a writable
  `$HOME` (mode 0600) from a read-only staging mount, so token refresh works.
- **`agy`/profile launch**: documented the image-cache pitfall (session Pods use
  `imagePullPolicy: Always`); local dev uses a dedicated tag + `IfNotPresent`.
- **Session cleanup cascade**: when the wrapped CLI exits (`terminal.exited`),
  the control-plane auto-stops the session (Pod/PVC/Secret removed), so it
  leaves `remote ls` without an explicit `stop`.

### Repository
- Renamed `rhanka/remote-controle` → **`rhanka/remote`** and made it public.

## v0.1.3 and earlier

Pre-CHANGELOG. See git history (`git log v0.1.3`): protocol (Ajv + OpenAPI),
control-plane (Hono REST/SSE/WS), k8s-orchestrator, session-agent (PTY),
remote-cli (local + remote + attach), per-session auth Secret, Scaleway Kapsule
overlay, operator-UI console, Track 2 credential refresh.
