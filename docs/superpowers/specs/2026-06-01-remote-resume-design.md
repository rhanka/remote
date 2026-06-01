# remote resume design

## Context

Local development sessions are currently resumed by `~/bin/resume-dev-sessions`, a shell script that scans Claude and Codex transcript stores, groups projects into GNOME Terminal windows, and opens many tabs. That script is useful evidence, but it must not remain the source of truth for the new flow.

The `remote` CLI already knows how to create workspaces, start remote sessions, attach to sessions, and migrate a project forward or back. The missing piece is a managed resume environment that can inventory both local and remote agent sessions, plan a terminal layout, and relaunch the right sessions with reliable tab names and status hints.

## Goals

- Add `remote resume` as the entrypoint for resuming development sessions, whether they are local or remote.
- Make layouts first-class `remote` environments, not external shell scripts.
- Support large layouts: up to 4 terminal windows and 40+ tabs.
- Support multiple sessions for the same project.
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
remote resume [env] --json
remote resume [env] --prefer local|remote|newest
remote resume [env] --project <project>
remote resume [env] --all
```

`remote resume run-tab` is an internal command used as the child command inside each terminal tab. It reads a generated launch map, claims one slot safely, sets the tab title, and starts the selected session command.

The default environment is `dev`, so `remote resume` and `remote resume dev` are equivalent unless the user changes the default.

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
    "sentropic": { "maxSessions": 12 },
    "sent-tech-design-system": { "maxSessions": 4 },
    "a2a-cli": { "maxSessions": 4 },
    "radar-immobilier": { "maxSessions": 1 },
    "mcp-wave": { "maxSessions": 1 }
  }
}
```

The exact default can be generated from the known current behavior, but it lives as data after creation. The shell script is not consulted.

## Inventory Model

`remote resume` builds one normalized inventory from:

- Local Claude transcripts under `~/.claude/projects/.../*.jsonl`.
- Local Codex transcripts under `~/.codex/sessions/rollout-*.jsonl`.
- Local running processes and their controlling terminals when discoverable.
- Remote sessions from the control plane.
- Remote workspaces and markers already linked to local projects.

Each discovered session becomes a candidate:

```text
project
cwd
profile              claude | codex | other later
conversationId       local provider id when available
workspaceId          remote workspace id when available
remoteSessionId      remote session id when available
place                local | remote | both
state                run | wait | recent | stale | done | err
mtime
source
```

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

## Layout Planning

The planner converts inventory candidates into launch slots:

1. Apply environment filters and project limits.
2. Allocate explicit group windows first.
3. Distribute remaining projects into shared windows.
4. Respect `maxWindows` and `maxTabsPerWindow`.
5. Preserve deterministic ordering by group, project priority, state, and recency.
6. Report overflow in `--dry-run` and `--status` instead of silently dropping sessions.

For the `dev` environment, this reproduces the current “4 terminal / 40+ tab” use case without depending on the old bash script.

## Terminal Launcher

The launcher uses only public terminal behavior:

- Generate a temporary launch map for the selected environment.
- Open GNOME Terminal windows and tabs with `--window`, `--tab`, `--working-directory`, and `--title`.
- Start `remote resume run-tab --map <file>` inside each tab.
- `run-tab` claims the correct slot under a lock, sets the title with OSC terminal escape sequences, and then starts the selected child command.

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

- `run`: process or remote session appears active
- `wait`: transcript heuristics suggest the agent is waiting for user input
- `recent`: recent transcript but no live process detected
- `stale`: outside the configured lookback or remote state is old
- `done`: child command exited cleanly
- `err`: launcher or child command failed

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

- Missing environment: explain how to create or edit it.
- Invalid environment: report schema path and reason.
- Remote unavailable: still show and launch local candidates; mark remote inventory unavailable.
- Terminal launch failure: print the generated plan and failed command.
- Overflow: report which sessions were not assigned to tabs.
- Ambiguous pairing: keep candidates separate and mark the ambiguity in `--status`.

## Testing

Unit tests:

- Parse Claude and Codex transcript fixtures into normalized candidates.
- Merge local and remote inventory without collapsing unrelated sessions for the same project.
- Preserve separate slots for multiple same-project sessions.
- Validate environment configs and reject invalid window/tab limits.
- Plan grouped and shared layouts deterministically.
- Format tab titles and state labels.

CLI tests:

- `remote env validate` with valid and invalid fixtures.
- `remote resume dev --dry-run --json` snapshot against fixture inventory.
- `remote resume dev --status` readable table output.

Integration boundaries:

- Do not require GNOME Terminal in CI.
- Test terminal launch planning by inspecting generated launch maps and command groups.
- Keep Kubernetes/control-plane calls behind mocked clients for resume tests.

## Rollout

1. Add environment schema, loading, validation, and `remote env` commands.
2. Add inventory collectors for local transcripts and remote sessions.
3. Add layout planner and dry-run/status output.
4. Add terminal launch map generation and `run-tab`.
5. Wire `remote resume`.
6. Add metadata improvements needed for reliable remote session pairing.
7. Leave `~/bin/resume-dev-sessions` in place but unused by `remote`.
