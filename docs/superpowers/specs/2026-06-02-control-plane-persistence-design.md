# Design — Control-plane durability via agent re-announce

Date: 2026-06-02
Status: accepted (brainstorm + adversarial Opus peer review → reconsidered to the simpler alternative)
Ships in: release v0.4.2 (alongside the already-merged anti-crash fix `42179f0`)

## Problem

The control-plane (Hono, single replica on Scaleway Kapsule) keeps ALL session
state in memory: `SessionStore` (`sessions`+`owners` Maps), `sessionTenant`
(`id → {userId, namespace}`), the `workspaces` map + locks, and the
`AgentRegistry` (sessionId → live WS connection). On any control-plane
restart/crash, this is lost — but the session **Pods keep running** (k8s). The
session-agents' WS connections drop and (today) the agents **exit**, so the
sessions become **orphaned**: the control-plane no longer lists/attaches/stops
them. This happened in production (a provision rejection crashed the process;
that crash is separately fixed in `42179f0`).

## Chosen approach — "the agent is the durable record" (peer-review alternative)

Instead of making k8s the source of truth (annotate pods + list-and-reconstruct
at boot — rejected: needs a cross-namespace LIST the control-plane SA cannot do,
new `list` plumbing, annotation/secret concerns), make the **session-agent**
re-announce itself:

1. The agent's WS transport **self-heals** (reconnect with jittered backoff) and
   the agent **process lifetime is decoupled from the socket** — a transient WS
   drop (control-plane restart) no longer ends the agent; only the wrapped PTY
   exiting does.
2. On every **(re)connect** to `/sessions/:id/agent`, the agent sends a first
   **`session.announce`** frame carrying its descriptor fields.
3. The control-plane, on receiving an announce for a session it does not know
   (e.g. after a restart), **repopulates** `SessionStore` + `sessionTenant` from
   the announce + the WS auth context. The session is then listable, attachable,
   and stoppable again.

This needs **no annotations, no k8s list, no new RBAC** — and it reuses the
agent-reconnect work that was mandatory either way. It is **self-correcting**: an
agent whose Pod terminated never reconnects, so it is never re-registered (no
zombies). A future sentropic-provided DB slots in behind the same `SessionStore`
seam, unchanged.

## Scope

In scope (ships v0.4.2):
- Self-healing agent WS transport (reconnect + backoff) and process-exit decoupled
  from socket close (gated on PTY exit).
- `session.announce` protocol frame (agent → control-plane) on (re)connect.
- Control-plane: accept an announce for an unknown session and repopulate the
  store (`SessionStore`, `sessionTenant`); derive `userId` from the WS auth
  context (off-mode → `default`), `namespace` via `tenantNamespace(userId)`.
- The agent-ws route no longer rejects an unknown session with `1008` when an
  announce frame establishes it.
- Workspace link reconstructed from a session's announce (`workspaceId`).

Out of scope (documented, deferred):
- **The 201-before-pod-durable window** (BLOCKER #4): `provision` is
  fire-and-forget; a crash in the few ms between the `201` and the Pod actually
  being created in etcd leaves a session the client was told exists but that has
  no Pod and no agent to re-announce it. Narrow window; the common crash class is
  already closed by `42179f0`. The durable fix (sync create-before-201, or the
  sentropic DB) is deferred.
- Standalone workspaces with no active session: their record is lost on restart
  (the retained PVC persists; the next `workspace` use re-creates the record).
  `displayName`/user `labels` on workspaces are not durable. Accepted for now.
- Locks (advisory TTL) and in-flight workspace archives: not persisted (ephemeral).
- Multi-replica/HA of the control-plane (single replica stays).

## Components

### 1. `session-agent` self-healing transport
- `packages/session-agent/src/websocket-transport.ts`: add an internal
  reconnect loop with **full-jitter exponential backoff** (e.g. 1s→30s cap). The
  returned `closed` promise resolves ONLY on a deliberate `close()` call, never
  on a transient socket drop. On reconnect, re-run the announce handshake and
  re-attach message handlers.
- `packages/session-agent/src/index.ts`: `main()` must gate process exit on the
  **PTY `exited`** signal (the wrapped CLI ending), NOT on `transport.closed`.
  Today `await transport.closed` ends `main()` — change to await the agent's
  lifecycle (PTY exit) so a control-plane restart never tears the agent down.
- `packages/session-agent/src/agent.ts`: the deliberate-exit path
  (`terminal.exited` → close) stays, but it signals lifecycle end, not "socket
  dropped". Distinguish the two.

### 2. `session.announce` frame (protocol)
A new agent→control-plane envelope sent first on every (re)connect:
```
{ type: "session.announce", body: {
    sessionId, profile, target, workspacePath,
    workspaceId?, cliSessionId? } }
```
All fields come from the agent's env (`SESSION_ID`, `SESSION_PROFILE`,
`SESSION_TARGET`, `WORKSPACE_PATH`, `SESSION_WORKSPACE_ID`) + detected
`cliSessionId`. **No secrets** (no credentials/token) — those never transit the
announce. Add the type to `@sentropic/remote-protocol` constants + schema.

### 3. Control-plane: announce-driven repopulation
- `apps/control-plane/src/routes/agent-ws.ts`: on the first `session.announce`,
  if `store.get(sessionId)` misses, synthesize a `SessionDescriptor`
  (`createdBy = control-plane`, `createdAt = now`, fields from the announce) and
  `store.put(descriptor, userId)` + `sessionTenant.set(id, {userId, namespace})`.
  `userId` is taken from the WS connection's auth context (bearer `sub`, or
  `default` in off-mode); `namespace = tenantNamespace(userId)`. If the session
  IS known, the announce is a no-op (idempotent re-register).
- The current `1008 session.not_found` rejection (`agent-ws.ts:49`) is replaced:
  an announce frame is the authoritative establish; reject only if the announce
  is malformed or the WS auth is invalid.
- `AgentRegistry.register(sessionId, connection)` continues to wire the terminal;
  the reconstructed descriptor makes attach/list/stop work immediately.

### 4. `SessionStore` seam (future DB)
Keep `SessionStore` as the in-memory working set behind its existing interface;
the announce path is just another writer. A future `SessionStore` backed by the
sentropic DB swaps in without touching routes. (No new code now beyond keeping
the interface clean.)

## Data flow

- **Steady state**: agent connects → announces → CP knows the session (from the
  original create, so announce is idempotent) → registry wired → attachable.
- **Control-plane restart**: store is empty. Each session-agent's transport
  reconnects (backoff) → re-announces → CP repopulates the session + registers
  the terminal → `GET /sessions` and `remote attach` work again. The wrapped PTY
  kept running in the agent throughout, so no shell/conversation is lost (only
  terminal output produced during the brief downtime is dropped).
- **Session ended during downtime**: the wrapped process exits → the agent exits
  (PTY-gated) → its Pod terminates → it never reconnects → never re-registered.
  No zombie.

## Error handling / robustness
- Agent reconnect: bounded full-jitter backoff; never crash on connect failure.
- Malformed announce: CP closes that WS with a clear code; does not crash.
- Invalid/absent WS auth under bearer: reject the announce (no anonymous
  establish). Off-mode: `default` user.
- Every CP-side announce handler path is individually guarded (one bad announce
  can never crash the process — same discipline as the anti-crash fix).
- Thundering herd on mass reconnect: full-jitter backoff spreads reconnects.

## Testing
- **Unit (session-agent)**: transport reconnects after a simulated drop
  (mock ws close → next connect succeeds → re-announce sent, handlers re-attached);
  `closed` does NOT resolve on a transient drop; process-exit triggers on PTY
  exit, not socket close.
- **Unit (protocol)**: `session.announce` schema validates; secret-free.
- **Unit (control-plane)**: an announce for an unknown session populates the
  store (GET /sessions then shows it; ownership/namespace correct for a bearer
  `sub` and for off-mode `default`); announce for a known session is idempotent;
  malformed/unauth announce rejected, no crash.
- **Integration**: simulate a "restart" — create a session, clear the store,
  feed an announce on a fresh agent WS, assert the session is re-listed +
  attachable.
- **Live (manual)**: `kubectl delete pod control-plane-…`; after the new pod is
  ready, confirm the running session-agents reconnect, `GET /sessions`
  repopulates, and `remote attach <id>` works — the wrapped CLI is intact.

## Migration / compatibility
- `REMOTE_AUTH=off` stays green (announce → `default` user, unchanged behavior).
- Single replica unchanged. No new infra, no RBAC change, no new datastore.
- Ships in v0.4.2 with the anti-crash fix; image bump + redeploy on SCW.
