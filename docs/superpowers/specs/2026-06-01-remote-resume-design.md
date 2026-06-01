# remote resume design

## Context

Local development sessions are currently resumed by `~/bin/resume-dev-sessions`, a shell script that scans Claude and Codex transcript stores, groups projects into GNOME Terminal windows, and opens many tabs. That script is useful evidence, but it must not remain the source of truth for the new flow.

The `remote` CLI already knows how to create workspaces, start remote sessions, attach to sessions, and migrate a project forward or back. The missing piece is a managed resume environment that can inventory both local and remote agent sessions, plan a terminal layout, and relaunch the right sessions with reliable tab names and status hints.

## Goals

- Add `remote resume` as the entrypoint for resuming development sessions, whether they are local or remote.
- Make layouts first-class `remote` environments, not external shell scripts.
- Support large layouts: up to 4 terminal windows and 40+ tabs.
- Support multiple sessions for the same project.
- Relaunch resumable sessions and report already-running local sessions without duplicating them.
- Give each tab a stable name that includes project, agent profile, locality, and activity state.
- Reuse the same inventory model later for interactive `remote migrate` with no arguments.
- Keep `~/bin/resume-dev-sessions` untouched for now, but do not call it from `remote`.

## Non-goals

- Do not inject commands into existing GNOME Terminal tabs.
- Do not use GNOME Terminal private D-Bus APIs.
- Do not delete or rewrite `~/bin/resume-dev-sessions` in this first implementation.
- Do not require Kubernetes or Scaleway access just to inspect local sessions.
- Do not solve full bidirectional migration policy in this feature; only expose the inventory and slot model that `remote migrate` can reuse later.

## CLI

`remote` gains an environment namespace:

```text
remote env init [env]
remote env list
remote env show <env>
remote env edit <env>
remote env validate <env>
```

`remote resume` consumes one of those environments:

```text
remote resume [env]
remote resume [env] --dry-run
remote resume [env] --status
remote resume [env] --dry-run --json
remote resume [env] --status --json
remote resume [env] --prefer local|remote|newest
remote resume [env] --project <project>
remote resume [env] --all
```

`remote resume run-tab` is an internal command used as the child command inside each terminal tab. It reads a generated launch map plus an explicit slot id, validates the expected cwd/title binding, sets the tab title, and starts the selected session command for that slot only.

The default environment is `dev`, so `remote resume` and `remote resume dev` are equivalent unless the user changes the default.

`--json` is report-only. It is valid only with `--dry-run` or `--status` and never launches terminals.

First-run behavior is explicit:

- `remote env init dev` materializes the built-in `dev` template into user config.
- `remote resume` auto-materializes `dev` on first use if it is missing.
- Missing non-default environments fail with guidance to run `remote env init <env>`.

## Environment Storage

Environment definitions are managed by `remote` under the user config directory:

```text
$XDG_CONFIG_HOME/sentropic/remote/environments/<env>.json
```

If `XDG_CONFIG_HOME` is unset, the fallback is:

```text
~/.config/sentropic/remote/environments/<env>.json
```

The repo owns the schema, validation, default generation, tests, and documentation. The user config owns the actual local layout.

`remote env edit dev` opens the managed file through `$EDITOR`. `remote env validate dev` reports schema and semantic errors without launching anything.

Environment names are restricted to `^[a-z0-9][a-z0-9._-]{0,63}$`. Names containing `/`, `..`, path separators, or absolute paths are rejected before any filesystem access. Resolved paths must remain under the managed environment directory.

## Environment Shape

The `dev` environment captures what the current shell script expressed procedurally:

```json
{
  "version": 1,
  "name": "dev",
  "terminal": {
    "app": "gnome-terminal",
    "maxWindows": 4,
    "maxTabsPerWindow": 12,
    "titleTemplate": "{project} [{profile} {place} {state}]"
  },
  "inventory": {
    "localLookbackHours": 48,
    "profiles": ["claude", "codex"],
    "remoteUrl": "default"
  },
  "layout": {
    "groups": [
      {
        "name": "sentropic",
        "projects": ["sentropic"],
        "slots": 12
      },
      {
        "name": "design + h2a",
        "projects": ["sent-tech-design-system", "a2a-cli", "remote", "poc-k8s"]
      }
    ],
    "sharedWindows": 2
  },
  "projects": {
    "sentropic": {
      "maxSessions": 12,
      "roots": ["/home/antoinefa/src/sentropic"]
    },
    "sent-tech-design-system": { "maxSessions": 4 },
    "a2a-cli": { "maxSessions": 4 },
    "radar-immobilier": {
      "maxSessions": 1,
      "roots": ["/home/antoinefa/src/radar-immobilier"]
    },
    "mcp-wave": {
      "maxSessions": 1,
      "roots": ["/home/antoinefa/src/mcp-wave"]
    }
  }
}
```

The exact default can be generated from the known current behavior, but it lives as data after creation. The shell script is not consulted.

Each `projects.<name>` entry may declare optional `roots[]` values. Those roots are the primary project-canonicalization input for local cwd matching and layout grouping.

## Inventory Model

`remote resume` builds one normalized inventory from:

- Local Claude transcripts under `~/.claude/projects/.../*.jsonl`.
- Local Codex transcripts under `~/.codex/sessions/rollout-*.jsonl`.
- Local running processes and their controlling terminals when discoverable.
- Remote sessions from the control plane.
- Remote workspaces and markers already linked to local projects.

Each discovered session becomes a candidate:

```text
project              canonical environment project key
cwd
profile              claude | codex | other later
conversationId       local provider id when available
workspaceId          remote workspace id when available
remoteSessionId      remote session id when available
place                local | remote | both
launchMode           local-resume | remote-attach | status-only
state                run | wait | recent | stale | done | err
activityAt           normalized UTC timestamp used by `--prefer newest`
mtime
source
```

Project canonicalization follows this order:

1. Match normalized local cwd against configured `projects.<name>.roots[]`.
2. Use explicit project metadata stored on remote workspaces or sessions.
3. Fall back to the normalized basename of cwd.

Candidates that cannot be matched to a configured project keep the fallback key and are only eligible for shared-window placement.

Remote session listing must include `workspaceId`; current CLI helpers omit it even though the protocol has it. This is a required supporting fix for reliable pairing and migration-back targeting.

## Multi-session Semantics

A project can produce several slots. A slot is not just a project name; it is a project/profile/conversation/workspace tuple.

Examples:

```text
sentropic#01 claude local  conversation A
sentropic#02 claude remote workspace ws-...
sentropic#03 codex  local  conversation B
```

Deduplication only happens when there is strong evidence that local and remote refer to the same conversation, such as an explicit migration marker or matching provider conversation id stored in remote session metadata. Otherwise, sessions remain separate so real concurrent work is not hidden.

## Launch Policy

Inventory and launch are intentionally different:

- A live local CLI process is inventoryable but not relaunchable. It becomes `launchMode=status-only`, appears in `--status` / `--json`, and does not consume a launch tab.
- `place=both` means local and remote evidence has been paired into one candidate. It does not mean both sides are launched.
- Only `local-resume` and `remote-attach` are launchable.

Paired launch selection is explicit:

- `--prefer remote`: use `remote-attach` when a remote session is running; otherwise fall back to `local-resume` if the local conversation is resumable and not already running.
- `--prefer local`: use `local-resume` when the local conversation is resumable and not already running; otherwise fall back to `remote-attach` if the remote session is running.
- `--prefer newest`: compare `activityAt` across paired local and remote evidence. Local uses transcript mtime. Remote uses control-plane `updatedAt`, falling back to `startedAt`. If timestamps are within 120 seconds, prefer a running remote session over a stopped local transcript. If the local side is already running, keep `status-only`.

Legacy remote sessions created before pairing metadata rollout are inventoryable but are not auto-paired from timestamps alone. They may pair only when there is exact workspace-marker or configured-root evidence plus profile agreement; otherwise they remain separate remote-only candidates. `remote migrate back` for those sessions must require explicit workspace or session selection.

## Layout Planning

The planner converts inventory candidates into launch slots:

1. Apply environment filters, project canonicalization, and project limits.
2. Split candidates into launchable and `status-only`. `status-only` candidates are reported but never consume launch tabs.
3. Allocate explicit group windows first.
4. Distribute remaining launchable candidates into shared windows.
5. Respect `maxWindows` and `maxTabsPerWindow`.
6. Preserve deterministic ordering by launch mode, state priority, recency, project, and slot label.
7. Report overflow in `--dry-run` and `--status` instead of silently dropping sessions.

Layout capacity is explicit:

- Each `layout.groups[]` entry reserves one dedicated window.
- If a group omits `slots`, its capacity defaults to `terminal.maxTabsPerWindow`.
- `sharedWindows` reserves additional windows after dedicated groups.
- Validation requires `groups.length + sharedWindows <= terminal.maxWindows`.

Overflow trimming uses this stable ordering:

1. `remote-attach`
2. `local-resume`
3. state priority `wait`, `run`, `recent`, `stale`, `done`, `err`
4. `activityAt` descending
5. `project` then slot label ascending

For the `dev` environment, this reproduces the current “4 terminal / 40+ tab” use case without depending on the old bash script.

## Terminal Launcher

The launcher uses only public terminal behavior:

- Generate a temporary launch map keyed by stable slot ids for the selected environment.
- Open GNOME Terminal windows and tabs with `--window`, `--tab`, `--working-directory`, and `--title`.
- Start `remote resume run-tab --map <file> --slot <slot-id>` inside each tab.
- `run-tab` loads only the addressed slot, verifies the bound cwd/title metadata, sets the title with OSC terminal escape sequences, and then starts the selected child command.

If GNOME Terminal cannot express distinct per-tab child commands directly, the launcher must generate distinct per-slot wrapper commands so every tab still receives its own slot id. Arbitrary first-come slot claiming is not allowed.

Child commands are ordinary commands:

```text
claude --resume <conversationId>
codex resume <conversationId>
remote attach <remoteSessionId>
```

No D-Bus, ptrace, TIOCSTI, or existing-tab injection is used.

## Tab Titles and Activity Witness

The default title format is:

```text
{project} [{profile} {place} {state}]
```

Examples:

```text
radar-immobilier [claude R run]
mcp-wave [claude R wait]
sentropic#03 [codex L recent]
```

`place` values:

- `L`: local session
- `R`: remote session
- `L/R`: paired local and remote state exists

`state` values:

- `run`: local PID matched to the exact conversation/profile/cwd, or remote control-plane session state is Running
- `wait`: local transcript has parseable turn ordering showing assistant output newer than user input, and no live local process is attached. Remote sessions do not emit `wait` in v1 without explicit metadata
- `recent`: transcript is within lookback and is neither `run` nor `wait`
- `stale`: transcript or remote session is outside lookback and is not currently running
- `done`: child command launched by the current `run-tab` exited cleanly
- `err`: launcher or child command launched by the current `run-tab` failed

The first implementation may use conservative heuristics. It must prefer an honest `recent` over a false `run` or `wait`.

## Migration Relationship

`remote resume` does not automatically migrate sessions. It exposes enough structured state for a later `remote migrate` no-argument flow:

```text
remote migrate
```

That future command can show local and remote candidates from the same inventory, ask which slots to move, and migrate local to remote or remote back to local.

The immediate implementation should make sure migrated remote sessions carry metadata that helps future pairing:

```text
project
local cwd
profile
local conversation id when known
resume environment
resume slot label when launched from an environment
```

## Error Handling

- Missing default `dev` environment: materialize the built-in template, then validate it.
- Missing non-default environment: fail with guidance to run `remote env init <env>`.
- Invalid environment name: reject before filesystem access and show the accepted grammar.
- Invalid environment: report schema path and reason.
- Remote unavailable: still show and launch local candidates; mark remote inventory unavailable.
- Already-running local session: report it as `status-only`; do not duplicate it.
- Terminal launch failure: print the generated plan and failed command.
- `--json` without `--dry-run` or `--status`: fail fast with usage guidance.
- Overflow: report which sessions were not assigned to tabs.
- Legacy remote session without pairing metadata: keep it unpaired and require explicit selection for migration back.
- Ambiguous pairing: keep candidates separate and mark the ambiguity in `--status`.

## Testing

Unit tests:

- Parse Claude and Codex transcript fixtures into normalized candidates.
- Merge local and remote inventory without collapsing unrelated sessions for the same project.
- Preserve separate slots for multiple same-project sessions.
- Resolve canonical project keys from `roots[]`, metadata, and cwd fallback.
- Validate environment configs and reject invalid window/tab limits.
- Reject invalid environment names and path traversal attempts.
- Resolve `launchMode` for local-only, remote-only, paired, and already-running local sessions.
- Plan grouped and shared layouts deterministically.
- Format tab titles and state labels.
- Infer `run`, `wait`, `recent`, and `stale` conservatively from fixtures.

CLI tests:

- `remote env init dev` bootstraps a valid default environment.
- `remote env validate` with valid and invalid fixtures.
- `remote resume dev --dry-run --json` snapshot against fixture inventory.
- `remote resume dev --status --json` report snapshot.
- `remote resume dev --status` readable table output.
- `remote resume dev --json` fails with usage guidance.

Integration boundaries:

- Do not require GNOME Terminal in CI.
- Test terminal launch planning by inspecting generated launch maps, slot ids, and command groups.
- Keep Kubernetes/control-plane calls behind mocked clients for resume tests.

## Rollout

1. Add environment schema, loading, validation, and `remote env` commands.
2. Add inventory collectors for local transcripts and remote sessions.
3. Add layout planner and dry-run/status output.
4. Add terminal launch map generation and `run-tab`.
5. Wire `remote resume`.
6. Add metadata improvements needed for reliable remote session pairing.
7. Leave `~/bin/resume-dev-sessions` in place but unused by `remote`.
