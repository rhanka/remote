# remote-controle MVP design

Date: 2026-05-09

## Context

`remote-controle` is a Kubernetes-native platform for controlling CLI-driven work sessions from another CLI or from an operator frontend. The MVP must be usable end-to-end before it is valuable: it must cover code work, ops CLI work, and delegated browser/UAT work in the same scenario.

The initial brief is preserved verbatim in `docs/brief-as-is.md`, with later additions in `docs/brief-additions/2026-05-09-mvp-v2-os.md`.

## Goals

- Provide a TypeScript control plane that creates and supervises isolated interactive sessions on Kubernetes.
- Run each session in Kubernetes resources from day one. There is no local runtime fallback for product validation.
- Support k3s first for realistic local cluster development, then Scaleway Kapsule in the PoC space, then GKE.
- Let a master session or operator frontend create sessions, send instructions, stream terminal output, monitor progress, handle approvals, and observe browser/UAT actions.
- Persist session workspaces and conversation/event history.
- Structure the repository as a monorepo whose core packages can later be published as libraries under the validated `@sentropic/remote-*` package family once npm scope access is confirmed.

## Non-goals

- No CRD/operator implementation in the MVP. The backend directly creates Kubernetes resources, with APIs shaped so a future operator can replace the implementation.
- No hostile multi-tenant security claim in the MVP. The target is serious PoC isolation, explicit approvals, and clear auditability.
- No local Docker/process runtime for product validation. k3s is acceptable because it is Kubernetes.
- No V2 TypeScript micro-OS implementation in the MVP. The MVP reserves interfaces and includes a research plan.

## Architecture

The MVP uses a TypeScript backend as a Kubernetes-native control plane. It uses the Kubernetes API to create resources for each session:

- `Namespace` or strict session labels in a shared namespace.
- `PVC` for a persistent workspace mounted at `/workspace`.
- Runtime `Pod` for the selected CLI profile.
- Browser `Pod` or sidecar for Playwright headed browser control.
- `Service` and controlled route/ingress resources for terminal, browser, and UAT access.
- `Secret` and `ConfigMap` for short-lived session configuration and injected credentials.

The backend does not execute user commands itself. It orchestrates resources, relays terminal/browser streams, stores event history, and enforces capability policies.

Deployment targets are ordered:

1. k3s for development and first integration.
2. Scaleway Kapsule in the PoC space as the first low-cost cloud target.
3. GKE as the second cloud provider.

## Session Runtime

Each session includes:

- A persistent workspace PVC mounted at `/workspace`.
- A controlled Debian/Ubuntu-based runtime image.
- A lightweight `session-agent` that exposes terminal, health, event, and file/session metadata endpoints.
- A CLI profile defining image, commands, environment, required secrets, CPU/RAM limits, and escalation policy.
- A terminal transport from xterm.js to backend WebSocket to `session-agent` PTY.
- A Playwright headed browser runtime for delegated browser actions.
- An UAT proxy that exposes workspace application ports through controlled, expiring routes.

Initial CLI profiles include:

- `shell`
- `codex`
- `opencode`
- `claude-code`
- `gemini-cli`

The first demo path is one session that can clone or receive a repo, run a coding CLI, install dependencies, test/build, expose the app through UAT, open a delegated browser, request approval or 2FA, and persist the event/conversation history.

## Approvals, Secrets, And 2FA

Validated decisions:

- Long-lived secrets live outside the session runtime. The MVP uses provider-specific sources where available, then injects temporary Kubernetes secrets per session. Kubernetes Secrets may be used as the session delivery mechanism, not the primary long-term vault.
- Sessions request secrets explicitly during execution. Secrets are short-lived and scoped to the session/capability.
- Policies are capability-based, not command-parser-based. Example capabilities: `read-secret`, `push-git`, `publish-npm`, `create-cloud-resource`, `install-system-package`, `browser-login`, `browser-sensitive-action`.
- 2FA is handled by user entry in the frontend and/or temporary user takeover of the browser. Agents do not receive durable 2FA secrets.
- Audit is an append-only structured event log: request, context, decision, expiration, session, user, and originating command/action.

No long-lived secret is stored in conversation history. Logs may reference secret handles, not secret values.

## Frontend Operator

The frontend uses Svelte 5.

Validated decisions:

- Multi-session navigation uses desktop tabs and mobile swipe, with one environment per tab/view.
- Terminal uses xterm.js plus a side panel for events, approvals, status, and 2FA prompts.
- Browser/UAT panes are integrated with the operator UI. WebRTC is preferred where low latency matters for headed browser interaction; WebSocket/noVNC-style transport may still be used for simpler observation paths if acceptable.
- Voice uses `voxtral-js` for live transcription into the CLI/instruction input. It is not an autonomous always-on voice agent in the MVP, but it should feel close to continuous dictation with explicit send/confirm behavior where needed.
- Master control includes instruction input, configurable drumbeat, session status, and approval handling. A full multi-agent planner is deferred.

## Master And Slave Plugins

The master plugin controls sessions from a CLI session. It can:

- Create new session environments from profiles.
- Send instructions to slave sessions.
- Configure drumbeat/progress checks.
- Track status and event history.
- Receive and answer approval/escalation prompts.
- Record work plans and progress through git commits where relevant.

The slave plugin or `session-agent` runs inside the session runtime. It can:

- Expose PTY and process lifecycle.
- Request capabilities, secrets, 2FA, or escalation.
- Publish structured progress/events.
- Report tool availability and session health.
- Avoid direct access to long-lived secrets.

## Packaging

The repository should be a monorepo with publishable packages from the start, but packages may remain private initially.

Validated decisions:

- Use monorepo structure rather than a single app or many separate repos.
- Use `@sentropic/remote-*` as the final npm package family; keep temporary scaffold package names until npm scope access is confirmed.
- Create core packages for `protocol`, `k8s-orchestrator`, `session-agent`, `approval-core`, `secret-broker`, `terminal-transport`, `browser-bridge`, and the Svelte frontend app.
- Reserve runtime interfaces for V2: `CommandRuntime`, `VirtualFS`, `Process`, `Capability`, and `ArtifactStore`.

## V2 Research: TypeScript Micro-OS

V2 explores a TypeScript micro-OS that can run many low-cost agents in one JavaScript process by paravirtualizing shell commands and selected development tools over V8 isolation.

The V2 work starts as research and feasibility validation, not MVP implementation.

Research topics:

- WebContainers as the main existing reference for Node.js applications and OS commands running inside a browser tab.
- SES/Endo compartments for capability-oriented JavaScript confinement.
- WASI/Wasmtime for portable sandboxed commands and OS-like APIs.
- `memfs`, `unionfs`, and similar libraries for virtual filesystem ideas.
- `isomorphic-git` and related libraries for git operations over virtual filesystems.
- Node `vm` only as a low-level execution context reference, not as a security boundary. Node documents that `node:vm` is not a security mechanism.

Feasibility gates:

- Gate A: Kubernetes image launches Codex CLI, verifies version, runs a minimal non-interactive task, and receives auth through an approved capability path.
- Gate B: Kubernetes image launches Claude Code, verifies installation/doctor/version behavior, and handles auth persistence or injection through an approved capability path.
- Gate C: TypeScript micro-OS prototype runs `sh`, pipes, redirects, a subset of `grep`, `sed`, `awk`, and a constrained `node` command over a virtual filesystem.
- Gate D: Decide which commands run in-process and which remain pod-backed. Unmodified Codex and Claude Code are expected to require a real OS/container runtime initially.

Initial command menu for V2:

- Shell/process: `sh`, subset `bash`, environment variables, pipes, redirects, exit codes, simple jobs, signals.
- Coreutils: `cat`, `ls`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `pwd`, virtual `chmod`, `wc`, `head`, `tail`, `sort`, `uniq`, `cut`, `tr`, `tee`.
- Text/code: `grep`, `sed`, `awk`, `find`, `xargs`, subset `jq`, `diff`, `patch`.
- Dev wrappers/adapters: constrained `node`, partial `npm`/`pnpm`, git via library/wrapper, `tsc`, lint, test adapters.
- OS/network: capability-gated `curl`/`wget`, `tar`, `gzip`. SSH is not in the first V2 prototype.

## Testing Strategy

MVP validation requires an end-to-end k8s scenario:

1. Create a session from the master CLI or frontend.
2. Provision Kubernetes resources and workspace PVC.
3. Open terminal stream and run a coding CLI profile.
4. Perform code/test/build steps in the workspace.
5. Trigger an ops capability such as `gh` or cloud-provider access.
6. Expose a UAT route and open browser observation/control.
7. Trigger a 2FA or approval request and resolve it from the operator UI.
8. Persist session history, events, and workspace artifacts.
9. Restart or reconnect and verify persisted state.

Provider test order:

1. k3s smoke and E2E.
2. Scaleway Kapsule PoC E2E.
3. GKE provider compatibility.

## Open Questions

- Confirm npm publishing access for the `@sentropic` scope from this repository.
- Decide whether sessions use one namespace per session or a shared namespace with strict labels for the first implementation.
- Choose the first external secret source for k3s and Scaleway PoC.
- Confirm whether the first cloud browser transport is WebRTC-first or starts with noVNC-style fallback plus WebRTC spike.
