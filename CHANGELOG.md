# Changelog

All notable changes to Sentropic Remote are documented here.
The project uses date-based, image-tagged releases (`vMAJOR.MINOR.PATCH`);
container images `ghcr.io/rhanka/sentropic-remote-{control-plane,session-agent}`
are tagged to match.

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
