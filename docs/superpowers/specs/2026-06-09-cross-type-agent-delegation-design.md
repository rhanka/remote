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

### 5. Feedback loop — decision request (h2a) — **EXPERIMENTAL (YAGNI)**
> **Status: EXPERIMENTAL.** Only `job.done` (via the claude SessionEnd hook +
> the `jobs` reconcile loop) works WITHOUT the delegated agent's cooperation. The
> `decision.requested` / `decision.reply` round-trip depends on the agent
> CHOOSING to poll its h2a inbox (MCP `h2a_inbox`) and act on a reply — we build
> and transport the channel but cannot force the agent to use it. The CLI treats
> a `decision.reply` as **ADVISORY**: it is surfaced/proposed, never used to gate
> a privileged action. The code stays in place; the feature is not load-bearing.

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

### Decisive corrections (opus review + user corrections 2026-06-09)
- **F1 — RESOLVED by running agents INTERACTIVE in tmux, not headless (user's
  call).** The default is a **live claude/codex/agy session in tmux** primed with
  the task, with the **h2a MCP server in a side window** (the existing
  `remote run --h2a` pattern). Because the agent is interactive and holds the
  h2a MCP tool, the **parent/master feedback loop IS realistic**: the agent can
  read its h2a inbox (MCP `h2a_inbox`) and respond to a `decision.reply` — opus's
  "headless can't poll/block" objection only applied to headless. So the
  feedback loop stays **core (default)**. **Headless** (`claude -p`/`codex exec`,
  fire-and-report, run-once-exit) becomes an **`--headless` OPTION** for pure
  batch jobs.
- **F2 — the queue needs a live driver (stands).** A one-shot CLI can't start
  queued jobs when a slot frees; a daemon violates the repo's no-service
  philosophy. → **conductor = a foreground tmux watch loop**
  (`remote jobs conduct --watch`), same pattern as `h2a bridge --watch` /
  `watchRefreshLoop`: each pass reconciles jobs vs cluster, consumes finished
  jobs, starts `pending` jobs under the cap.
- **F3 — CORRECTED: the "1 volume attach per node" constraint was WRONG.** Per
  the official scaleway-filestorage-csi docs, a **RWX volume can be mounted
  read-write by MANY nodes**. The real (observed) limit was on the number of
  **DISTINCT** File Storage volumes per node (the old 1-PVC-per-workspace model).
  Our model is **ONE shared RWX volume, subPath per workspace/job** → mounted RW
  across all nodes, **no concurrency/packing limit**. → **default-16 concurrency
  applies LOCAL *and* REMOTE** (remote jobs are isolated by distinct subPaths on
  the one shared RWX volume), as originally asked. (Earlier sessions
  hallucinated the per-node attach cap; corrected in `project-remote-rwx-shared`.)

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

### Revised phasing (interactive-tmux default, per user)
- **P1 (do first): LOCAL interactive delegation on the extended registry.**
  `remote delegate <type> "<task>" [--cwd|worktree] [--name] [--headless]` →
  a **live tmux agent** (claude/codex/agy) primed with `<task>` (task as a single
  argv, never shell-concat), in its own **git worktree** (local file-tree
  isolation; the single-writer guard only protects the `.jsonl`), with the
  **`--h2a` side-window** so the parent/master dialogue works. Register as a job
  by **extending `RegistryEntry` (role:"job")**: `jobState`, `parent?`, `task`.
  `remote jobs ls/status/attach/logs`. `--headless` = run-once-exit wrapper
  (stdout→`output.log`, `result.json`, end session) for batch. `--name`/jobId via
  `assertSafeName`.
- **P2 — REMOTE delegation** via `createRemoteSession({startupArgs})` (safe argv
  channel) on the shared RWX volume (subPath per job — **concurrent**, no CSI
  limit) + cluster reconciliation (`listRemoteSessions` → dead pod ⇒ failed,
  since registry `kind:remote` isLive is always-true).
- **P3 — callback + feedback** over h2a: `job.done` on the claude Stop/SessionEnd
  hook; `decision.requested`/`decision.reply` round-trip via the h2a MCP
  side-window + `h2a bridge`.
- **P4 — conductor** `jobs conduct --watch` (foreground tmux) + concurrency cap
  (**16, local AND remote**) + queue + `--max-depth` (1–3) + track mirroring
  (job graph = backlog).

---

## Remediation — a2a-cli adversarial review (2026-06-09, post-P1–P4)

A second adversarial review (a2a-cli) found real correctness/concurrency/trust
bugs in the shipped P1–P4. Fixed here, by priority:

- **H1 (P0, correctness) — interactive jobs never completed.** The claude
  SessionEnd hook resolved the job by `session_id` (claude's conversation uuid),
  but a job is enrolled under its SLUG → no match → the job stayed `running`
  forever. Fix: `startJob` stamps `REMOTE_JOB_ID=<jobId>` into the local-tmux
  session env; SessionStart links the conversation uuid onto the job (`convId`);
  SessionEnd resolves via `REMOTE_JOB_ID` → `convId` → id (back-compat) and
  advances the job by its slug. The hook still ALWAYS exits 0.
- **H2 (P0) — `result.json` read at the wrong cwd.** Written under
  `job.originCwd` but read via `process.cwd()`, so a conductor in another cwd
  always missed it and forced `failed` on a clean exit. Fix: read with
  `job.originCwd ?? process.cwd()` at all 4 sites (reconcile local + remote, `jobs
  status`, `jobs logs`); `originCwd` is persisted on every job enroll.
- **S2/S3 (P1, concurrency) — registry races.** `registry.json` is
  read-modify-written by concurrent `delegate`/conductor/hook processes →
  last-writer-wins lost enrolls; and the cap check (`hasFreeSlot`) was separate
  from the enroll → overshoot. Fix: a **local file lock** (`withRegistryLock`,
  exclusive lockfile with stale-takeover) wraps every mutation
  (enroll/advanceJob/markEnded/touchEntry/prune), and **`tryClaimSlot`** does the
  cap-check + enroll-as-running ATOMICALLY under that lock. The registry is
  **LOCAL ONLY** (the CLI writes it; pods have no access), so a local lock is
  sufficient — there is no cross-host writer to coordinate.
- **S1 (P2, trust) — unauthenticated envelopes on the multi-tenant RWX inbox.**
  Any pod could forge a `job.done`/`decision.*` for a neighbour's job. Fix: at
  consumption, **reject** an envelope whose `actor.instance` ≠ the job's known
  instance (`jobInstance` for job.done/decision.requested; the recorded parent for
  decision.reply); `decision.reply` is **advisory** only. LIMIT: integrity by
  convention, not signatures — a pod that knows the victim's jobId can still
  compute a matching instance. Real trust needs signed envelopes (tracked
  separately).
- **M2 (P3, convergence) — sweep.** A `running` job that is NOT live, has NO
  `result.json`, and is older than a generous configurable max age
  (`REMOTE_JOB_MAX_AGE_HOURS`, default 24h) is swept → `failed` so it stops
  holding a slot (covers a control-plane-unreachable remote job / optimistic
  no-pid local liveness). Bounds awaiting-decision too (it's persisted `running`).
- **M3 (P3) — no-conductor advisory.** `jobs ls` warns `N pending, no active
  conductor` (detected via `pgrep` for `jobs conduct`); it does NOT self-heal.
- **`--max-depth` remote clamp.** There is **no env channel** carrying the depth
  budget into a Pod (`createRemoteSession` passes only `startupArgs`), so a remote
  job cannot enforce a budget. Until that channel exists, a `--remote` job's
  recorded budget is **clamped to ≤ 1** (a job-in-a-Pod does not re-delegate).
  Local jobs keep the full 1–3 range via `REMOTE_DELEGATE_DEPTH`.
- `--remote` concurrency safety now relies on the S2/S3 lock fix above.
