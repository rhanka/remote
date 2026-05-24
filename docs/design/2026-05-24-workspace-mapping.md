# Design note — workspace mapping (cwd ↔ remote workspace)

Date: 2026-05-24
Status: draft for review (Q/R)
Feedback origin: `docs/uat/2026-05-24-feedback-track2.md` §3

## Problem

Today `remote codex --remote` always **creates a fresh session** with an empty
`/workspace` PVC. The local directory the user is standing in is ignored. The
user wants:

1. If the **cwd is already mapped** to a remote workspace → auto-attach to it.
2. If **not mapped** → propose creating a mapping, with options to **sync files**
   up and/or **import an existing session**.
3. `--resume` (shipped) reattaches the *CLI conversation*; this is about the
   *workspace/session continuity* — a different axis.

## Current model

- A "session" = one Pod + one PVC (`/workspace`) + one Secret, ephemeral, dies on
  CLI exit (cleanup cascade now in place).
- There is **no persistence** of "which local dir corresponds to which remote
  workspace". `remote config` only stores the default remote URL.
- No file sync mechanism exists (PVC starts empty; no rsync/scp path).

## What other tools do

| Tool | Mapping unit | How it's remembered | Sync |
| --- | --- | --- | --- |
| `git` | repo ↔ remote | `.git/config` (per-dir) | push/pull |
| `fly` | app ↔ dir | `fly.toml` in the dir | `fly deploy` ships the build context |
| `docker compose` | project ↔ dir | dir name / `-p` | bind mounts or build context |
| `gh` | repo ↔ dir | git remote | — |
| `devcontainer` / Codespaces | workspace ↔ repo | `.devcontainer/` + cloud state | clone in-cloud |
| `mutagen` / `docker dev` | dir ↔ remote volume | session file | continuous file sync |

Two recurring patterns:
- **Marker file in the dir** (`fly.toml`, `.git/config`) = the mapping lives with
  the project, survives clones, is greppable.
- **Central state file** (`~/.config/<tool>/…`) = the tool remembers across dirs,
  but breaks if the dir moves.

## Options

### Option A — Marker file `.remote/workspace.json` in the cwd — **recommended**

```
.remote/workspace.json   { "remote": "...", "workspaceId": "ws-xxxx", "lastSession": "sess-yyyy" }
```

- `remote codex --remote` reads cwd → if marker present, reuse that workspace
  (re-provision a session bound to the persisted workspace, or attach if live).
- If absent: prompt → `No remote workspace mapped for <cwd>. Create one? [y/N]`
  then offer `--sync` (upload cwd) and/or `--import <sid>` (seed from an existing
  session's PVC).
- ➕ Mapping travels with the project, greppable, matches `git`/`fly` intuition.
- ➕ Survives across machines if committed (or `.gitignore`d if private).
- ➖ Requires a **workspace** concept in the control-plane that outlives a session
  (PVC retained + addressable by `workspaceId`). That's a protocol + orchestrator
  change (today PVC dies with the session).

### Option B — Central registry `~/.config/sentropic/remote-cli/workspaces.json`

Map `cwd → {remote, workspaceId}` in the CLI config dir.

- ➕ No file in the user's project; CLI-only change.
- ➖ Breaks when the dir is renamed/moved; not visible to teammates; "magic".

### Option C — Defer mapping, ship **file sync** only

`remote codex --remote --sync` tars the cwd (respecting `.gitignore`) into the
new session's PVC at create time. No persistent workspace; each run is fresh but
seeded.

- ➕ Smallest; delivers the most-requested half (get my files in the Pod) without
  a workspace lifecycle.
- ➖ No "auto-attach to my workspace"; re-uploads every run; no session import.

## Dependency ladder (what each option forces)

1. **C (sync only)** → needs an upload path (CLI tars cwd → control-plane →
   PVC populate via init step). No protocol model change. ~1 focused PR.
2. **A (marker + persistent workspace)** → needs a first-class **Workspace**
   resource (create/list/retain PVC/destroy) in protocol + orchestrator +
   control-plane, plus the marker file and the sync from C. Several PRs.
3. **Session import** (seed a new workspace from an old session's PVC) → needs
   PVC snapshot/clone (CSI `VolumeSnapshot`) — heaviest, can come last.

## Recommendation

Ship in order **C → A → import**:

- **Now:** Option C (`--sync` to seed the PVC from cwd). High value, no model
  change, unblocks "my code is in the Pod".
- **Next:** Option A's marker file + a persistent `Workspace` resource so cwd
  auto-maps and survives across sessions.
- **Later:** session/workspace import via volume snapshot.

This keeps each step shippable and testable, and matches the `fly.toml`/`git`
mental model the user already has, without committing to the heavy
VolumeSnapshot machinery up front.
