# Sentropic Remote protocol and events design

Date: 2026-05-11

## Context

Plan 0 created a minimal scaffold for Sentropic Remote. The current `protocol`
package only exposes a protocol version, CLI profile names, capability names,
and a small `SessionDescriptor`.

Plan 1 defines the contract layer that every later package depends on:
control-plane API, session-agent, k8s orchestrator, operator UI, browser bridge,
terminal transport, approval flow, secret broker, audit log, and future SDKs.

The project direction is OpenAPI/JSON Schema first. The neighboring Entropiq
application uses OpenAPI for API documentation and Zod/Drizzle inside the app,
but Sentropic Remote should make JSON Schema the canonical protocol source for
network and event contracts.

## Goals

- Make `packages/protocol` the canonical home for all public Sentropic Remote
  protocol contracts.
- Define JSON Schemas for REST payloads, streamed events, approvals, secrets,
  terminal events, browser events, lifecycle states, and errors.
- Derive or align TypeScript types from those schemas so package consumers do
  not hand-roll equivalent shapes.
- Prepare OpenAPI 3.1 components from the same schemas.
- Keep runtime validation compatible with Fastify/Ajv and JSON Schema 2020-12.
- Preserve package boundaries: no Drizzle, no Kubernetes client, and no app
  storage logic in `protocol`.

## Non-goals

- No database schema or migrations in Plan 1. Drizzle starts when persistent
  storage is implemented.
- No k8s object creation in Plan 1. The orchestrator consumes these contracts
  later.
- No UI implementation beyond ensuring the events are usable by the operator UI.
- No CRD/operator contracts beyond keeping names and lifecycle states reusable
  by a future operator.
- No Zod-first design. Zod may be used in app-specific code later, but it is not
  the source of truth for protocol contracts.

## Decision

Use JSON Schema/OpenAPI-first contracts.

`packages/protocol` exports:

- `REMOTE_PROTOCOL_VERSION`, starting at `0.1.0`.
- JSON Schema constants grouped by domain.
- TypeScript types aligned with the schemas.
- Example payloads for key contracts.
- Optional helper lists such as known CLI profiles, lifecycle states, event
  type names, and capability names.
- An OpenAPI component map that the control-plane can reuse when generating its
  API document.

Runtime validation is performed by consumers through Ajv-compatible validators.
Fastify can register the schemas directly for REST routes. Session-agent,
browser-bridge, and terminal-transport can validate stream payloads with the
same schemas.

## Package surface

Recommended export layout:

```text
packages/protocol/src/index.ts
packages/protocol/src/constants.ts
packages/protocol/src/schemas/index.ts
packages/protocol/src/schemas/session.ts
packages/protocol/src/schemas/events.ts
packages/protocol/src/schemas/approvals.ts
packages/protocol/src/schemas/secrets.ts
packages/protocol/src/schemas/terminal.ts
packages/protocol/src/schemas/browser.ts
packages/protocol/src/schemas/errors.ts
packages/protocol/src/openapi.ts
packages/protocol/src/types.ts
packages/protocol/src/examples.ts
```

The package should avoid a large single file. Domain files should export both
schema constants and related type aliases/interfaces.

## Schema conventions

Use OpenAPI 3.1 compatible JSON Schema.

Schema identifiers:

```text
https://schemas.sentropic.dev/remote/0.1/session-descriptor.schema.json
https://schemas.sentropic.dev/remote/0.1/session-event.schema.json
```

Field conventions:

- IDs are opaque strings. Consumers must not parse IDs for behavior.
- Timestamps are ISO 8601 strings with `format: date-time`.
- Envelopes include `protocolVersion` and `schemaVersion`.
- Payload unions use a discriminator field named `type`.
- Events include `eventId`, `sessionId`, `sequence`, `occurredAt`, and
  `correlationId`.
- Sensitive values are never present in protocol payloads. Use handles,
  references, labels, or redacted previews.
- `metadata` is allowed as `object` with additional properties where extension
  points are intentional.

Recommended schema version fields:

```text
protocolVersion: "0.1.0"
schemaVersion: "remote.protocol.v1"
```

`protocolVersion` is the npm package contract version. `schemaVersion` is the
wire-contract family identifier and remains stable across additive package
patches.

## Core models

### SessionDescriptor

Represents the desired session shape before orchestration.

Required fields:

- `id`: opaque session id.
- `profile`: CLI profile id.
- `target`: deployment target.
- `workspacePath`: fixed `/workspace` for MVP sessions.
- `createdAt`: timestamp.
- `createdBy`: actor descriptor.

Optional fields:

- `displayName`
- `labels`
- `resourceLimits`
- `requiredCapabilities`
- `browser`
- `uat`
- `metadata`

### CliProfile

Initial known profiles:

```text
shell
codex
opencode
claude-code
gemini-cli
```

Profiles are modeled as strings with known constants. The schema should accept
the known values in Plan 1. Extension profiles can be added through a future
profile registry rather than arbitrary strings in public APIs.

### SessionTarget

Initial targets:

```text
k3s
scaleway-kapsule
gke
```

The target is an orchestration target, not a runtime mode. There is still no
local process runtime for product validation.

### SessionLifecycleState

Initial lifecycle states:

```text
requested
provisioning
starting
ready
running
waiting-approval
waiting-2fa
degraded
stopping
stopped
failed
expired
```

State transitions are owned by the control-plane. Session-agent reports signals
and health; it does not unilaterally define lifecycle state.

### Actor

Represents the source of an action or event.

Initial actor kinds:

```text
user
master-agent
session-agent
control-plane
browser-bridge
terminal-transport
system
```

Actors include `id`, `kind`, optional `displayName`, and optional `metadata`.

## REST/API contracts

Plan 1 defines schemas but does not implement endpoints.

Initial request/response contracts:

- `CreateSessionRequest`
- `CreateSessionResponse`
- `ListSessionsResponse`
- `GetSessionResponse`
- `StopSessionRequest`
- `StopSessionResponse`
- `SendInstructionRequest`
- `SendInstructionResponse`
- `ApprovalDecisionRequest`
- `ApprovalDecisionResponse`
- `SecretGrantResponse`
- `RemoteError`

The control-plane OpenAPI document should import these schemas into
`components.schemas`. Route-specific request and response bodies should reference
components rather than inline schemas.

## Event contracts

Events are append-only and replayable.

All events use this envelope:

```text
RemoteEventEnvelope
  protocolVersion
  schemaVersion
  eventId
  sessionId
  sequence
  type
  occurredAt
  correlationId
  actor
  payload
  metadata?
```

Initial event families:

- `session.lifecycle.changed`
- `session.health.reported`
- `session.instruction.received`
- `session.instruction.completed`
- `approval.requested`
- `approval.decided`
- `secret.requested`
- `secret.granted`
- `secret.revoked`
- `terminal.opened`
- `terminal.input`
- `terminal.output`
- `terminal.resized`
- `terminal.exited`
- `browser.started`
- `browser.navigated`
- `browser.user-takeover.requested`
- `browser.user-takeover.changed`
- `browser.2fa.requested`
- `browser.sensitive-action.requested`
- `uat.route.created`
- `uat.route.expired`
- `audit.recorded`

Transport is not encoded into the event shape. SSE, WebSocket, persisted event
logs, and test fixtures can all use the same event schema.

## Approvals and capabilities

Capabilities remain explicit and policy-based. They are not inferred by parsing
shell commands.

Initial capability names:

```text
read-secret
push-git
publish-npm
create-cloud-resource
install-system-package
browser-login
browser-sensitive-action
network-egress
uat-expose
workspace-export
```

`ApprovalRequest` includes:

- `approvalRequestId`
- `sessionId`
- `capability`
- `risk`: `low`, `medium`, `high`, or `critical`
- `reason`
- `requestedBy`
- `requestedAt`
- `expiresAt`
- `subject`
- `proposedAction`
- `context`

`ApprovalDecision` includes:

- `approvalRequestId`
- `decision`: `approved`, `denied`, `expired`, or `cancelled`
- `decidedBy`
- `decidedAt`
- optional `comment`
- optional `grant`

Approvals should be serializable as API payloads and audit events.

## Secrets

Secret payloads never include secret values.

`SecretRequest` includes:

- `secretRequestId`
- `sessionId`
- `secretRef`
- `capability`
- `purpose`
- `requestedBy`
- `requestedAt`
- `expiresAt`
- `delivery`
- `context`

Delivery modes:

```text
kubernetes-secret
env
file
stdin
browser-user-entry
```

The response contains only grant status, secret handles, expiration, and
redacted metadata. The secret-broker is responsible for actual delivery.

## Terminal

Terminal contracts are split between control events and byte/text data.

Initial terminal payloads:

- `TerminalOpened`
- `TerminalInput`
- `TerminalOutput`
- `TerminalResize`
- `TerminalExited`

`TerminalOutput` supports:

- `stream`: `stdout`, `stderr`, or `system`
- `data`: UTF-8 text for MVP
- `encoding`: fixed `utf8` in Plan 1
- optional `truncated`

Binary terminal transport is out of scope for Plan 1.

## Browser and UAT

Browser contracts cover delegated browsing without committing to one transport.

Initial browser transport names:

```text
webrtc
websocket
novnc
playwright-control
```

Browser events include URL, title, page id, challenge context, takeover state,
and redacted sensitive action summaries.

2FA is modeled as an approval-like challenge:

- agents receive challenge metadata;
- users provide codes or takeover actions through the operator UI;
- protocol payloads do not store durable 2FA secrets.

UAT route events include route id, URL, port, expiration, and exposure policy.

## Errors

All public errors use `RemoteError`:

- `code`
- `message`
- `retryable`
- `correlationId`
- `details`

Initial error code families:

```text
validation.failed
session.not_found
session.state_conflict
approval.expired
approval.denied
secret.unavailable
capability.denied
k8s.provisioning_failed
terminal.unavailable
browser.unavailable
internal.error
```

## OpenAPI integration

`packages/protocol` should export:

```text
remoteOpenApiComponents
```

This object contains `components.schemas` only. The control-plane remains
responsible for route paths, auth requirements, tags, examples, and server URLs.

The generated OpenAPI document in Plan 2 should be OpenAPI 3.1 so it can
reference JSON Schema 2020-12-compatible definitions without lossy conversion.

## TypeScript strategy

Preferred implementation:

- define JSON Schemas as `as const`;
- derive TypeScript types from schemas with a schema-to-type utility;
- export both schemas and types from `@sentropic/remote-protocol` once package
  names are finalized.

If the type derivation library creates consumer friction, Plan 1 may generate
plain `.ts` type files from schemas during build instead. The source of truth
must remain JSON Schema.

## Testing strategy

Plan 1 implementation should include:

- schema validation tests for valid examples;
- negative validation tests for missing required fields and invalid enum values;
- tests that all exported schemas have `$id`, `title`, and `type` or
  composition keywords;
- tests that OpenAPI components include every public schema;
- type-level usage tests where practical through TypeScript compilation.

The full repo verification remains:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 verify
```

## Migration from Plan 0 scaffold

Plan 1 should replace the current minimal protocol exports with schema-backed
exports while keeping existing consumers compiling:

- Keep CLI profile constants.
- Keep capability constants, extended with the approved Plan 1 names.
- Replace `REMOTE_CONTROLE_PROTOCOL_VERSION` with `REMOTE_PROTOCOL_VERSION`.
- Add a temporary compatibility export if needed to avoid breaking the scaffold
  in the same commit.
- Update control-plane health response to use the new version constant when the
  implementation plan reaches app wiring.

## Questions batched for review

Recommended defaults if there is no objection:

- **Schema IDs:** use `https://schemas.sentropic.dev/remote/0.1/...`.
- **Protocol version:** start Plan 1 at `0.1.0`.
- **OpenAPI version:** use OpenAPI `3.1.0`.
- **Validation library:** use Ajv/Fastify-compatible JSON Schema validation, not
  Zod-first validation.
- **Type derivation:** try schema-to-TypeScript derivation first; fall back to
  generated plain types if publication ergonomics are poor.
- **Terminal data:** UTF-8 text only in Plan 1, binary deferred.
- **Event transport:** schemas are transport-neutral; SSE/WebSocket choices are
  made in Plan 2 and later.

## Acceptance criteria

- A developer can read the protocol package and know the exact JSON shapes used
  by the control-plane, UI, session-agent, and stream transports.
- API and event payloads share one contract source.
- Future OpenAPI generation can use the protocol schemas without rewriting them.
- No secret values appear in any protocol payload.
- Later implementation plans can be split by package without redefining shared
  payloads.
