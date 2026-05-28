# Changelog

All notable changes to Sentropic Remote are documented here.
The project uses date-based, image-tagged releases (`vMAJOR.MINOR.PATCH`);
container images `ghcr.io/rhanka/sentropic-remote-{control-plane,session-agent}`
are tagged to match.

## Unreleased

Follow-ups on top of v0.4.0's multi-tenant base (no release tag cut yet).

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
