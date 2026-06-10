# Cross-type async agent delegation — design (2026-06-09)

**Status**: design, pending double-review (codex 5.5-high + claude opus 4.8-max) and user approval. No implementation until approved.

## Goal
Let `remote` **delegate an agent of any type (claude / codex / agy)** to run a
task **in a tmux session, local OR remote (SCW pod)**, **asynchronously**, with:
- **supervision** (live state of every delegated job),
- an **end-of-job callback** to the parent,
- a **parent/master feedback loop via h2a** when the agent needs a decision,
- concurrency **not capped at 4** — potentially very large, **default 16
  concurrent** (local or remote), user-tunable,
- a **conductor** model where **track is the system of record** for the job graph.

Inspired by **Hermes Agent** (NousResearch, MIT): explicit `orchestrator` role
spawning workers, `max_spawn_depth` (1–3), `max_concurrent_children`, a
file-coordination layer so concurrent siblings don't clobber, lifecycle hooks,
and callback via session-completion semantics.

## Building blocks already in `remote` (reuse, don't reinvent)
- **Local spawn**: `remote run <profile>` (detached tmux, drop-to-shell wrapper, `--count` fan-out).
- **Remote spawn**: `migrate forward` / `createRemoteSession` (creates a pod session on the shared RWX volume, subPath per workspace).
- **Supervision**: `registry.json` + `listLive` + `remote ls`/`status` (tmux has-session / pid+cmdline / pod liveness — incl. the post-crash boot/PID guards).
- **Parent/child comms + callback**: the h2a file bus + `remote h2a bridge` (pod↔local envelope transport).
- **Concurrency seed**: `remote run --count N` (fan-out) — needs a cap + queue.
- **Single-writer guard** (`conv-guard`): each delegated job is a FRESH conversation (no `-r`), so no collision.

## Approaches considered
**A — thin wrapper over `run`/`migrate` + a jobs registry + h2a callbacks (RECOMMENDED).**
Add `remote delegate`, a `jobs.json` job model, a conductor that enforces the
cap and mirrors jobs into track. Reuses every existing primitive; smallest new
surface; matches the shared-RWX + h2a architecture. 

**B — a long-running conductor daemon** that owns a scheduler/queue and a control
socket. More powerful (live rebalancing) but a new daemon to supervise, more
moving parts, conflicts with "don't run system services". Defer.

**C — adopt Hermes Agent directly** as the orchestrator. Wrong fit: Hermes
orchestrates ITS OWN python/tool subagents, not external claude/codex/agy CLIs
in tmux/pods; we'd fight its sandbox model. Borrow its concepts, not its runtime.

→ **A**, phased.

## Architecture (Approach A)

### 1. The delegation primitive — `remote delegate`
```
remote delegate <type> "<task>" [--remote] [--cwd <path>] [--name <label>]
                                [--parent <jobId>] [--on-done <h2a-instance>]
```
- `<type>` ∈ {claude, codex, agy}. Spawns the agent **non-interactively** in a
  detached tmux session (local) or pod (remote), running `<task>`, and returns a
  **job id**. Non-interactive invocation per type:
  - claude: `claude -p "<task>"` (print/headless) — or interactive + initial prompt.
  - codex: `codex exec "<task>"`.
  - agy: headless run (`agy --task`/equivalent — to confirm in impl).
- The session runs under a **delegation wrapper** (extends the drop-to-shell
  wrappers) that: writes job state transitions to a **job-state file**
  (`<workspace>/.remote/jobs/<jobId>.json`: running→done|failed + exit code +
  artifacts dir), and on exit **emits an h2a callback envelope** to the parent.

### 2. Job model + registry
A job = `{ id, type, task, target: "local"|"remote", tmuxSession?|sessionId?, cwd, state, parent?, convId?, createdAt, endedAt?, exitCode?, callbackTo? }`.
Stored in `jobs.json` (sibling of `registry.json`, same atomic-write + injectable
path pattern). `listJobs()` reconciles persisted state with live state (tmux
has-session / pod liveness) — exactly like the session registry.

### 3. Supervision — `remote jobs`
- `remote jobs ls` — table: id, type, target, state (running / awaiting-decision
  / done / failed), age, parent.
- `remote jobs status <id>` — detail + last callback/decision envelope.
- `remote jobs attach <id>` — attach into the job's tmux (local) or pod (`--exec`).
- `remote jobs logs <id>` — tail the job-state/output.

### 4. End-of-job callback (h2a)
On termination the wrapper drops an h2a envelope into the parent's inbox:
`type: "job.done"`, body `{ jobId, type, state, exitCode, artifactsRef, summary }`.
`remote h2a bridge` already transports pod↔local. The conductor consumes these to
advance the job graph and mark the track item done/failed.

### 5. Feedback loop — decision request (h2a)
When the delegated agent needs a decision it emits `type: "decision.requested"`
(body: question + options) to the parent and the job goes **awaiting-decision**.
The parent (conductor or a human via the conductor) replies with
`type: "decision.reply"`; the agent reads it (h2a inbox in its workspace) and
resumes. Reuses the h2a negotiation vocabulary already in the protocol.

### 6. Concurrency cap + queue (Hermes-inspired)
- `--max-concurrent <N>` (default **16**), per conductor, applied to BOTH local
  and remote. Excess delegations **queue** (pending state) and start as slots
  free (driven by `job.done` callbacks).
- `--max-depth <D>` (default **1**, clamp 1–3, à la Hermes `max_spawn_depth`): a
  delegated job may itself delegate only if depth allows — prevents runaway trees.
- **File-coordination**: remote jobs are isolated by **distinct workspace
  subPaths** on the shared RWX volume (no clobber). Local jobs default to the
  caller's cwd; `--cwd`/`--name` to separate. (Hermes' "siblings share one
  container → collisions" is avoided by per-job workspace by default for remote.)

### 7. Conductor around track
The **conductor** is the orchestrating session (a claude/this CLI) that:
delegates jobs, **mirrors each job as a track item** (child of a workpackage,
`--role` item) so the job graph IS the backlog, watches `remote jobs ls` +
the h2a inbox, answers decision requests, and marks track items done on
`job.done`. Track = system of record; no separate scheduler state.

## Data flow
conductor → `remote delegate` (spawn tmux/pod, write job-state, create track item)
→ agent runs the task → on need-decision: h2a `decision.requested` → conductor
replies `decision.reply` → agent resumes → on end: job-state done + h2a `job.done`
→ `h2a bridge` delivers → conductor marks track item done, starts next queued job.

## Error handling
- Agent non-zero exit → job `failed` + `job.done` callback (state failed) + track item stays open with the error.
- Pod/tmux died (crash) → `listJobs` liveness shows it dead; reconcile to `failed` (boot/PID guards already exist).
- Cap exceeded → `pending` (queued), not rejected.
- h2a undeliverable → job still terminates; callback retried by the bridge (idempotent by file name).
- Decision never answered → job stays `awaiting-decision` (visible in `jobs ls`); a `--decision-timeout` may later auto-fail.

## Testing
Pure, unit-testable: job state machine (pending→running→awaiting-decision→done|failed),
queue/cap logic, per-type non-interactive command builder, h2a envelope builders
(job.done / decision.requested/reply), `listJobs` reconciliation (mocked liveness).
Spawn + h2a transport mocked. No real cluster in tests.

## Phasing (each phase shippable, tracked under the WP)
1. **P1** — job model + `remote delegate <type>` LOCAL (detached tmux, non-interactive, job-state file) + `remote jobs ls/status`.
2. **P2** — REMOTE delegation (pods, per-job workspace) + `jobs attach --exec`.
3. **P3** — h2a callback (`job.done`) + decision feedback loop (`decision.requested`/`reply`), wired through `h2a bridge`.
4. **P4** — conductor + concurrency cap (16) + queue + depth clamp + track mirroring (job graph as backlog).

## Open design forks (for double-review + user)
1. **Non-interactive vs interactive+prompt** per type. → headless, see review.
2. **One workspace per remote job** vs shared. → differs local/remote, see review.
3. **Conductor = CLI process vs daemon.** → neither: foreground-tmux watch, see review.

---

## Review outcomes — opus 4.8 adversarial review (2026-06-09) — REVISED PLAN

The opus review found three blocking flaws in the first draft; they reshape the
plan. (Codex 5.5-high review routed via h2a — folded in when it lands.)

### Decisive corrections
- **F1 — kill the interactive h2a decision-loop from the core.** A headless
  `claude -p` / `codex exec` does NOT poll a file inbox nor block awaiting a
  reply; `awaiting-decision` has no realistic producer. → **fire-and-report**:
  a job that needs a decision **exits with `state:needs-decision` + the question
  in its result**; the conductor **starts a NEW job** with the answer injected
  into the task. No blocking, no inbox-read, no resume. The interactive feedback
  loop (§5) is **demoted to P5 (exploratory)**.
- **F2 — the queue needs a live driver.** A one-shot CLI can't start queued jobs
  when a slot frees. A daemon violates the repo's no-service philosophy. →
  **conductor = a foreground tmux watch loop** (`remote jobs conduct --watch`),
  the SAME pattern as `h2a bridge --watch` / `watchRefreshLoop`: each pass
  reconciles jobs vs cluster, consumes finished jobs, starts `pending` jobs under
  the cap.
- **F3 — "subPath = free isolation" is false.** Scaleway File Storage CSI =
  **one volume attach per node** (`spec.ts:108`); N per-job workspaces = N
  subdirs with quota/scheduling cost + collision with `workspace gc`. →
  **default-16 concurrency is LOCAL-only**; **remote starts sequential (cap
  1–2)** on a shared workspace until the File Storage quota/attach math is done.

### Other required changes
- **Extend `RegistryEntry` (role:"job"), do NOT add a second `jobs.json`.** A job
  is almost a RegistryEntry already (id/tool/kind/cwd/convId/tmuxSession/pid/
  endedAt); add `jobState`, `parent?`, `task`, `callbackTo?`. Reuses `listLive`,
  the atomic-write, and the liveness guards — and means the **remote cluster
  reconciliation** (kind:remote `isLive` is always true, `registry.ts:280`) is
  written ONCE for both sessions and jobs (fixes F4).
- **Run-once-exit wrapper, NOT drop-to-shell.** A job must redirect stdout/stderr
  to `<dir>/output.log`, write `<dir>/result.json {state,exitCode}`, then **end
  the session** — the opposite of the existing drop-to-shell wrapper.
- **Security**: the `<task>` payload goes as a **single argv** (local, like
  `startupArgs` today) or via the **`SESSION_STARTUP_ARGS` env channel** (remote,
  the already-safe path used by `migrate`/`createRemoteSession`) — **never**
  concatenated into a `bash -lc` string. `jobId`/`--name` pass `assertSafeName`
  before becoming a filename / tmux slug / h2a dir.
- **Local file-tree isolation**: 16 local jobs in the caller's cwd would clobber
  the working tree (the single-writer guard only protects the `.jsonl`). →
  default each local job to its **own git worktree** (repo skill
  `using-git-worktrees`) or an explicit `--cwd`; never the shared caller cwd.
- **Callback via claude lifecycle hook.** The repo already has claude
  Stop/SessionEnd hooks (`enroll.ts`); branch the `job.done` signal on the hook
  rather than parsing a tmux exit code — more reliable, and reduces the
  lost-callback race (F5).
- **agy headless unconfirmed** (R3): cross-type may ship as claude+codex headless
  + agy interactive-only until an agy headless mode is verified.

### Revised phasing
- **P1 (do first — zero risky parts): LOCAL fire-and-report on the extended
  registry.** `remote delegate <type> "<task>" [--cwd|worktree] [--name]` →
  git-worktree isolation + `claude -p` / `codex exec` in a detached tmux
  **run-once-exit** wrapper (stdout→`output.log`, write `result.json`, end
  session); extend `RegistryEntry` (role:"job"); `remote jobs ls/status/logs/
  attach`; task as argv, name via `assertSafeName`. **No h2a, no reactive cap.**
  Delivers the real value: supervised, isolated, result-recoverable local
  fan-out of N headless agents.
- **P2 — REMOTE delegation** via `createRemoteSession({startupArgs})` (safe
  channel) + cluster reconciliation (`listRemoteSessions` → dead pod = failed);
  shared workspace, **sequential** (cap 1–2) until CSI quota is assessed.
- **P3 — callback** (`job.done`) via claude Stop/SessionEnd hook + h2a transport,
  only after choosing a reliable-delivery mechanism.
- **P4 — conductor** `jobs conduct --watch` (foreground tmux) + concurrency cap
  (16 local) + queue + optional track mirroring.
- **P5 (exploratory) — interactive decision feedback loop** (the original §5),
  only if a realistic headless-agent inbox-read/resume mechanism is found.
