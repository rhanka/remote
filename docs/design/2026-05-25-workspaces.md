# Design + plan — Workspaces (project↔workspace mapping + local/remote sync)

Date: 2026-05-25
Status: accepted decisions, executing
Supersedes the deferred half of `2026-05-24-workspace-mapping.md` (which shipped
Option C `--sync`). This is the persistent-workspace epic.

## Locked decisions (Q/R 2026-05-25)

1. **Persistent Workspace + marker.** A first-class `Workspace` resource on the
   control-plane backs a **retained** PVC (survives sessions, addressable by
   `workspaceId`). A `.remote/workspace.json` marker in the project dir records
   `{ remote, workspaceId }`. `remote <profile>` in a mapped dir auto-binds a
   session to that workspace instead of a fresh empty PVC.
2. **Phasing: P1 files → P2 sessions → P3 web UI.** Each phase shippable.
3. **`pull` = 3-way merge (bidirectional reconciliation)** with conflict
   detection — not a blind overwrite. Needs a common ancestor (base) =
   snapshot of the last sync.

## Model

- **Workspace**: `{ id, createdAt, createdBy, displayName?, labels? }`. Backed by
  a retained PVC `workspace-<id>` in the namespace. Lives until explicitly
  deleted (`remote workspace rm`).
- **Session ↔ Workspace binding**: `CreateSessionRequest.workspaceId?`. When set,
  the orchestrator mounts the workspace PVC at `/workspace` instead of creating a
  per-session PVC. Session lifecycle no longer owns the PVC.
- **Marker** `.remote/workspace.json`: `{ remote, workspaceId, base? }` where
  `base` is the sync-base reference (see merge). `.remote/` is git-ignorable but
  recommended to commit `workspace.json` (shareable mapping) — `base` state goes
  in a sibling git-ignored file.

## CLI surface (`remote workspace …`)

```
remote workspace link [--remote <url>] [--name <n>]   # create ws + write marker
remote workspace list                                  # list workspaces on remote
remote workspace status                                # show mapping for cwd
remote workspace push                                  # local -> remote (seed/update)
remote workspace pull                                  # remote -> local (3-way merge)
remote workspace rm [<id>]                             # delete ws + retained PVC
```

In a mapped dir, `remote codex|claude|agy` auto-binds to the marker's
`workspaceId` (logs `cwd -> ws-… (reusing workspace)`); `--no-workspace` opts out
to a throwaway PVC.

## Sync mechanism

- **Transport**: reuse the `--sync` tar.gz path. `push` uploads a
  `git ls-files`-based archive to the workspace PVC (via the control-plane
  staging endpoint, extracted by a short-lived populate step / session-agent).
- **Pull/merge (3-way)**: the CLI keeps a **base snapshot** (the tree as of the
  last successful push/pull) under `.remote/base/` (git-ignored, or a packed
  blob). On `pull`:
  1. fetch the remote tree (tar.gz) → `remote` side.
  2. 3-way compare `base` vs `local` vs `remote` per file:
     - changed only remote → take remote.
     - changed only local → keep local.
     - changed both, identical → fine.
     - changed both, differ → **conflict**: write both, emit conflict markers
       (git-style `<<<<<<<`), list them, exit non-zero until resolved.
  3. on success, update `base` to the merged tree.
  - Implementation: shell out to `git merge-file` per conflicting file (it does
    exactly the 3-way line merge), with `base/local/remote` temp copies. No full
    git repo required.

## Phase plan

### P1 — files (this epic's first slice)
- Protocol: `Workspace` schema + `workspaceId` on `CreateSessionRequest` +
  workspace CRUD request/response schemas.
- control-plane: `POST/GET/DELETE /workspaces`, `GET /workspaces/:id`; bind
  sessions to a workspace PVC; retained-PVC lifecycle.
- orchestrator: retained PVC `workspace-<id>`; session pod mounts it when bound;
  do not delete the PVC on session stop.
- remote-cli: `remote workspace link/list/status/push/pull/rm` + marker
  read/write + auto-bind in profile commands; 3-way merge for `pull`.
- Tests at each layer.

### P2 — session state (codex/claude/agy conversations)
- Bundle the CLI conversation dirs (`~/.codex/sessions`, `~/.claude/projects`,
  `~/.gemini/antigravity-cli/conversations`) into the workspace on stop; restore
  on start. Makes `--resume` portable local↔remote.

### P3 — web UI
- operator-ui: workspaces list, mapping view, push/pull triggers, conflict view.

## Soft-lock (decided 2026-05-25)

Bidirectional sync needs advisory coordination so concurrent editors don't
race into conflicts. Decision: **control-plane is the lock authority**, with an
**h2a presence projection** later (P2).

- control-plane: `POST /workspaces/:id/lock` (holder id + TTL/heartbeat),
  `DELETE /workspaces/:id/lock`, lock state in `GET /workspaces/:id`.
- **Soft**: `pull`/`push` acquire-or-warn. If held by someone else, print
  who/since-when and require `--force` to proceed. Auto-expires at TTL (a live
  bound session refreshes it).
- Authority lives in the control-plane because it's the only component both the
  local CLI and remote Pods can reach (h2a V1 transport is filesystem-only;
  cross-machine h2a = Scenario C, deferred).
- **P2**: project the lock as an h2a presence/contract in the workspace's
  `.h2a/` so the in-Pod `mcp-serve` sidecar and `h2a_discover_sessions` see it.

## Sequencing within P1 (lowest-risk first)
1. **P1a**: Workspace resource (protocol + control-plane + orchestrator retained
   PVC) + `remote workspace link/list/status/rm` + session auto-bind + `push`.
2. **P1b**: `pull` with 3-way merge (the hard part), base-snapshot tracking.

Each of P1a/P1b is its own commit + tests.
