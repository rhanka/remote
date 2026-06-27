# Sentropic Remote

Kubernetes-native orchestration for delegated CLI sessions.

Repository: `rhanka/remote` (codename was `remote-controle` during scaffold).

## Stack

- Backend: TypeScript control plane.
- Frontend: Svelte 5 operator UI.
- UI design system: `@sent-tech/components-svelte`.
- Workspace: npm monorepo.
- First runtime target: k3s, then Scaleway Kapsule, then GKE.

## Docs

- Initial brief: `docs/brief-as-is.md`
- Traceability: `docs/traceability/2026-05-09-intention-spec-decisions.md`
- Naming and packaging: `docs/decisions/2026-05-10-naming-and-packaging.md`
- MVP spec: `docs/superpowers/specs/2026-05-09-remote-controle-mvp-design.md`
- Protocol/events spec: `docs/superpowers/specs/2026-05-11-remote-protocol-events-design.md`
- Plan 0 scaffold: `docs/superpowers/plans/2026-05-09-remote-controle-plan-0-scaffold.md`
- Multi-tenant sessions spec: `docs/superpowers/specs/2026-05-27-multi-tenant-sessions-design.md`
- Multi-tenant sessions plan: `docs/superpowers/plans/2026-05-27-multi-tenant-sessions.md`
- Enabling multi-tenant auth (operator guide): `docs/multi-tenant-auth.md`

## Build

```bash
corepack npm install
corepack npm run verify
```

This is an npm workspaces monorepo (`package-lock.json`); do not use pnpm/yarn/bun.

## The `remote` CLI

`remote` is the unified launcher and lifecycle manager for delegated CLI
sessions — local (tmux) and deported (Scaleway Kapsule) alike. `remote
<command> --help` prints the authoritative flags; the groups below are a map.

### Launch & attach

- `remote run <profile> [path]` — start a LOCAL session in tmux (claude/codex/
  agy/opencode/shell) in `path` (default cwd). Manage it like a remote one.
  `-r/--resume <conv>` resumes a conversation, `--name <slug>` keeps several
  sessions of one project distinct, `--h2a` also starts the h2a MCP server in a
  side window. Remote applies its embedded scroll-safe tmux profile at launch
  (`history-limit 50000`, mouse/copy-mode wheel scrolling, passthrough, title
  propagation); no matching `~/.tmux.conf` is required. Detach with `Ctrl-b d`;
  the session keeps running.
- `remote attach <slug|id> [sessionId]` — attach to a LOCAL tmux session (by
  slug) or, failing that, a remote one. For remote, `--exec` (default with a
  tunnel) execs straight into the Pod's tmux (native scrollback + OSC52).
- `remote ls` / `remote status` — list LOCAL (tmux) and REMOTE (control-plane)
  sessions uniformly; `status` adds agent health + local tool auth correlation.
- `remote stop <slug|id>` — kill a local session or stop a remote one.
- `remote restore [group]` — relaunch sessions into their saved layout (one
  window per group, one tab per session). No arg = all groups; `[group]` =
  that batch only (e.g. `remote restore "full remote"`). Registry-first.
- `remote layout` — show the layout auto-recorded by the last `restore`.

### Live-session registry & autoenrollment

- `remote enroll --install-hooks` — wire claude SessionStart/End hooks (idempotent,
  backs up `settings.json`) so every session auto-enrolls into the registry that
  feeds `ls`/`restore`. `--hook …` is the plumbing (always exits 0); manual mode:
  `--tool/--cwd/--conv/--pid/--label`. codex sessions enroll via `remote run`
  and the restore filesystem-scan fallback.

### Deport, sync & migrate

- `remote workspace` — map the current project to a persistent remote workspace
  and sync files. `remote workspace gc [--older-than N] [--apply --yes]` garbage-
  collects stale subdirs of the shared RWX volume (dry-run by default; archives
  to on-volume `.trash/` before deleting).
- `remote migrate forward|back` — round-trip a local session to a remote one
  and back (`-r <conv>` to resume; guarded against double-writers).
- `remote sync <id> --session push|pull` — copy the conversation log local↔Pod
  (guarded by line count, `.bak-<epoch>` backup, `--force` to override).
- `remote diff [id]` — is the remote session in sync? Conversation log
  (`--session`, default) or git workspace state (`--files`).

### Credentials & plugins

- `remote auth` / `remote secrets` — inspect/manage the local credentials sent
  to sessions and audit what was transmitted.
- `remote refresh [id] [--soft]` — re-bundle local credentials into a session.
  `--soft --all [--watch <min>]` re-pushes to every live session, in a loop;
  respawn is gated on a credential hash and revives a dead Pod CLI. Run the
  watch in a dedicated tmux window for hands-off token rotation.
- `remote plugin add <pkg>` / `ls` / `sync` — install an npm plugin (CLI + MCP
  server, e.g. `@sentropic/track`) locally and into every live Pod, registering
  its MCP server(s) with claude + codex + agy.

### Agent network (h2a)

- `remote h2a bridge [id] [--watch <min>]` — transport h2a envelopes Pod↔local
  (pull emitted, push addressed; idempotent by file name, never deletes).

### Connectivity & config

- `remote install <url>` / `remote config` — set the default remote URL and
  manage endpoint configuration. `install` and `config set` also apply remote's
  embedded local tmux profile idempotently. `remote config tmux-profile <name>`
  keeps the profile marker configurable for compatibility while the scroll-safe
  options remain owned by remote.
- `remote connect` / `remote disconnect` — open/close the managed control-plane
  tunnel (a `kubectl port-forward`, opened on demand by most commands).
- `remote check <profile>` — end-to-end smoke probe (create → terminal.opened →
  stop), non-zero on failure.
