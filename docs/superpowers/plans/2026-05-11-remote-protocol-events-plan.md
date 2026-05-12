# Remote Protocol Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Sentropic Remote Plan 1 protocol package with JSON Schema/OpenAPI-first contracts, TypeScript types, examples, and validation tests.

**Architecture:** `packages/protocol` becomes the stable contract package. JSON Schemas are the source of truth; TypeScript types are derived or aligned from those schemas; consumers validate with Ajv/Fastify-compatible JSON Schema. Drizzle, Kubernetes orchestration, and storage adapters stay outside this package.

**Tech Stack:** TypeScript 6, pnpm 11, Vitest, tsup, JSON Schema 2020-12/OpenAPI 3.1, `json-schema-to-ts`, Ajv.

---

## Context

Spec: `docs/superpowers/specs/2026-05-11-remote-protocol-events-design.md`

Current package state:

- `packages/protocol/src/index.ts` exposes only version/profile/capability constants and a tiny `SessionDescriptor`.
- `apps/control-plane/src/index.ts` imports `REMOTE_CONTROLE_PROTOCOL_VERSION`.
- `apps/operator-ui/src/routes/+page.svelte` imports `CLI_PROFILES`.
- Temporary package name remains `@remote-controle/protocol` until a dedicated package rename plan changes it to `@sentropic/remote-protocol`.

Implementation decisions:

- Use `json-schema-to-ts` in `packages/protocol` dependencies because exported type aliases may reference `FromSchema` in generated declarations.
- Use `ajv` as a `packages/protocol` dev dependency for tests only.
- Keep a compatibility export named `REMOTE_CONTROLE_PROTOCOL_VERSION` during this plan so the scaffold stays compiling.
- Use schema IDs under `https://schemas.sentropic.dev/remote/0.1/`.
- Use OpenAPI `3.1.0` components, but do not implement control-plane route generation in this plan.

## File Map

- Modify `packages/protocol/package.json`: add `json-schema-to-ts` dependency and `ajv` dev dependency.
- Modify `packages/protocol/src/index.ts`: re-export the new package surface and compatibility constants.
- Create `packages/protocol/src/constants.ts`: protocol version, schema version, known enum arrays.
- Create `packages/protocol/src/schemas/common.ts`: common JSON Schema fragments and shared schemas.
- Create `packages/protocol/src/schemas/session.ts`: session and REST request/response schemas.
- Create `packages/protocol/src/schemas/approvals.ts`: approval and capability schemas.
- Create `packages/protocol/src/schemas/secrets.ts`: secret request/grant schemas.
- Create `packages/protocol/src/schemas/errors.ts`: public error schema.
- Create `packages/protocol/src/schemas/terminal.ts`: terminal stream/control schemas.
- Create `packages/protocol/src/schemas/browser.ts`: browser, 2FA, and UAT schemas.
- Create `packages/protocol/src/schemas/events.ts`: remote event envelope and event payload schemas.
- Create `packages/protocol/src/schemas/index.ts`: schema barrel export.
- Create `packages/protocol/src/types.ts`: exported TypeScript aliases derived from schemas.
- Create `packages/protocol/src/examples.ts`: valid example payloads used by tests and docs.
- Create `packages/protocol/src/openapi.ts`: `remoteOpenApiComponents`.
- Replace `packages/protocol/src/index.test.ts`: high-level export/compat tests.
- Create `packages/protocol/src/schemas/schema-validation.test.ts`: Ajv positive/negative schema tests.
- Create `packages/protocol/src/openapi.test.ts`: OpenAPI component coverage tests.

## Task 1: Dependencies And Constants

**Files:**

- Modify: `packages/protocol/package.json`
- Create: `packages/protocol/src/constants.ts`
- Modify: `packages/protocol/src/index.ts`
- Replace: `packages/protocol/src/index.test.ts`

- [ ] **Step 1: Add protocol dependencies**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol add json-schema-to-ts
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol add -D ajv
```

Expected:

```text
dependencies:
+ json-schema-to-ts
devDependencies:
+ ajv
```

- [ ] **Step 2: Write failing constants/export tests**

Replace `packages/protocol/src/index.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  ACTOR_KINDS,
  CAPABILITIES,
  CLI_PROFILES,
  EVENT_TYPES,
  REMOTE_CONTROLE_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEMA_BASE_URL,
  REMOTE_SCHEMA_VERSION,
  SESSION_LIFECYCLE_STATES,
  SESSION_TARGETS,
} from "./index.js";

describe("protocol constants", () => {
  it("declares the protocol version and compatibility version", () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe("0.1.0");
    expect(REMOTE_CONTROLE_PROTOCOL_VERSION).toBe(REMOTE_PROTOCOL_VERSION);
    expect(REMOTE_SCHEMA_VERSION).toBe("remote.protocol.v1");
    expect(REMOTE_SCHEMA_BASE_URL).toBe(
      "https://schemas.sentropic.dev/remote/0.1",
    );
  });

  it("declares the MVP CLI profiles", () => {
    expect(CLI_PROFILES).toEqual([
      "shell",
      "codex",
      "opencode",
      "claude-code",
      "gemini-cli",
    ]);
  });

  it("declares target, lifecycle, actor, capability, and event names", () => {
    expect(SESSION_TARGETS).toEqual(["k3s", "scaleway-kapsule", "gke"]);
    expect(SESSION_LIFECYCLE_STATES).toContain("waiting-approval");
    expect(ACTOR_KINDS).toContain("session-agent");
    expect(CAPABILITIES).toContain("network-egress");
    expect(EVENT_TYPES).toContain("browser.2fa.requested");
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test -- src/index.test.ts
```

Expected: FAIL with missing exports such as `REMOTE_PROTOCOL_VERSION` or `EVENT_TYPES`.

- [ ] **Step 4: Create constants implementation**

Create `packages/protocol/src/constants.ts`:

```ts
export const REMOTE_PROTOCOL_VERSION = "0.1.0";
export const REMOTE_CONTROLE_PROTOCOL_VERSION = REMOTE_PROTOCOL_VERSION;
export const REMOTE_SCHEMA_VERSION = "remote.protocol.v1";
export const REMOTE_SCHEMA_BASE_URL =
  "https://schemas.sentropic.dev/remote/0.1";

export const CLI_PROFILES = [
  "shell",
  "codex",
  "opencode",
  "claude-code",
  "gemini-cli",
] as const;

export const SESSION_TARGETS = ["k3s", "scaleway-kapsule", "gke"] as const;

export const SESSION_LIFECYCLE_STATES = [
  "requested",
  "provisioning",
  "starting",
  "ready",
  "running",
  "waiting-approval",
  "waiting-2fa",
  "degraded",
  "stopping",
  "stopped",
  "failed",
  "expired",
] as const;

export const ACTOR_KINDS = [
  "user",
  "master-agent",
  "session-agent",
  "control-plane",
  "browser-bridge",
  "terminal-transport",
  "system",
] as const;

export const CAPABILITIES = [
  "read-secret",
  "push-git",
  "publish-npm",
  "create-cloud-resource",
  "install-system-package",
  "browser-login",
  "browser-sensitive-action",
  "network-egress",
  "uat-expose",
  "workspace-export",
] as const;

export const EVENT_TYPES = [
  "session.lifecycle.changed",
  "session.health.reported",
  "session.instruction.received",
  "session.instruction.completed",
  "approval.requested",
  "approval.decided",
  "secret.requested",
  "secret.granted",
  "secret.revoked",
  "terminal.opened",
  "terminal.input",
  "terminal.output",
  "terminal.resized",
  "terminal.exited",
  "browser.started",
  "browser.navigated",
  "browser.user-takeover.requested",
  "browser.user-takeover.changed",
  "browser.2fa.requested",
  "browser.sensitive-action.requested",
  "uat.route.created",
  "uat.route.expired",
  "audit.recorded",
] as const;
```

- [ ] **Step 5: Export constants and type aliases**

Replace `packages/protocol/src/index.ts` with:

```ts
export {
  ACTOR_KINDS,
  CAPABILITIES,
  CLI_PROFILES,
  EVENT_TYPES,
  REMOTE_CONTROLE_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEMA_BASE_URL,
  REMOTE_SCHEMA_VERSION,
  SESSION_LIFECYCLE_STATES,
  SESSION_TARGETS,
} from "./constants.js";

export type ActorKind = (typeof import("./constants.js").ACTOR_KINDS)[number];
export type Capability = (typeof import("./constants.js").CAPABILITIES)[number];
export type CliProfile = (typeof import("./constants.js").CLI_PROFILES)[number];
export type EventType = (typeof import("./constants.js").EVENT_TYPES)[number];
export type SessionLifecycleState =
  (typeof import("./constants.js").SESSION_LIFECYCLE_STATES)[number];
export type SessionTarget =
  (typeof import("./constants.js").SESSION_TARGETS)[number];

export interface SessionDescriptor {
  readonly id: string;
  readonly profile: CliProfile;
  readonly target: SessionTarget;
  readonly workspacePath: "/workspace";
}
```

- [ ] **Step 6: Run constants tests**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test -- src/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit constants**

Run:

```bash
git -C /tmp/remote-controle-plan0 add packages/protocol/package.json pnpm-lock.yaml packages/protocol/src/constants.ts packages/protocol/src/index.ts packages/protocol/src/index.test.ts
git -C /tmp/remote-controle-plan0 commit -m "feat(protocol): add protocol constants"
```

## Task 2: Common And Session Schemas

**Files:**

- Create: `packages/protocol/src/schemas/common.ts`
- Create: `packages/protocol/src/schemas/session.ts`
- Create: `packages/protocol/src/schemas/index.ts`
- Create: `packages/protocol/src/types.ts`
- Create: `packages/protocol/src/schemas/schema-validation.test.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Write failing schema validation tests for session contracts**

Create `packages/protocol/src/schemas/schema-validation.test.ts`:

```ts
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  actorSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  sessionDescriptorSchema,
} from "./index.js";

const ajv = new Ajv({ allErrors: true, strict: false });

describe("session JSON Schemas", () => {
  it("validates a session descriptor", () => {
    const validate = ajv.compile(sessionDescriptorSchema);
    const valid = validate({
      id: "session_001",
      profile: "codex",
      target: "k3s",
      workspacePath: "/workspace",
      createdAt: "2026-05-11T12:00:00.000Z",
      createdBy: {
        id: "user_001",
        kind: "user",
        displayName: "Antoine",
      },
      requiredCapabilities: ["read-secret", "browser-login"],
      resourceLimits: {
        cpu: "1000m",
        memory: "2Gi",
      },
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a session descriptor with a non-MVP workspace path", () => {
    const validate = ajv.compile(sessionDescriptorSchema);
    const valid = validate({
      id: "session_001",
      profile: "codex",
      target: "k3s",
      workspacePath: "/tmp/workspace",
      createdAt: "2026-05-11T12:00:00.000Z",
      createdBy: { id: "user_001", kind: "user" },
    });

    expect(valid).toBe(false);
    expect(validate.errors?.[0]?.instancePath).toBe("/workspacePath");
  });

  it("validates create session request and response payloads", () => {
    expect(ajv.compile(actorSchema)({ id: "user_001", kind: "user" })).toBe(
      true,
    );
    expect(
      ajv.compile(createSessionRequestSchema)({
        profile: "shell",
        target: "k3s",
        displayName: "Shell smoke",
        requiredCapabilities: ["network-egress"],
      }),
    ).toBe(true);
    expect(
      ajv.compile(createSessionResponseSchema)({
        session: {
          id: "session_001",
          profile: "shell",
          target: "k3s",
          workspacePath: "/workspace",
          createdAt: "2026-05-11T12:00:00.000Z",
          createdBy: { id: "user_001", kind: "user" },
        },
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run schema tests to confirm they fail**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test -- src/schemas/schema-validation.test.ts
```

Expected: FAIL because `./index.js` under `src/schemas` does not exist.

- [ ] **Step 3: Create common schemas**

Create `packages/protocol/src/schemas/common.ts`:

```ts
import {
  ACTOR_KINDS,
  CAPABILITIES,
  CLI_PROFILES,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEMA_BASE_URL,
  REMOTE_SCHEMA_VERSION,
  SESSION_LIFECYCLE_STATES,
  SESSION_TARGETS,
} from "../constants.js";

export const isoDateTimeSchema = {
  type: "string",
  format: "date-time",
} as const;

export const metadataSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const labelsSchema = {
  type: "object",
  additionalProperties: { type: "string" },
} as const;

export const actorSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/actor.schema.json`,
  title: "Actor",
  type: "object",
  additionalProperties: false,
  required: ["id", "kind"],
  properties: {
    id: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ACTOR_KINDS },
    displayName: { type: "string", minLength: 1 },
    metadata: metadataSchema,
  },
} as const;

export const resourceLimitsSchema = {
  title: "ResourceLimits",
  type: "object",
  additionalProperties: false,
  properties: {
    cpu: { type: "string", minLength: 1 },
    memory: { type: "string", minLength: 1 },
  },
} as const;

export const protocolEnvelopeProperties = {
  protocolVersion: { type: "string", const: REMOTE_PROTOCOL_VERSION },
  schemaVersion: { type: "string", const: REMOTE_SCHEMA_VERSION },
} as const;

export const cliProfileSchema = {
  title: "CliProfile",
  type: "string",
  enum: CLI_PROFILES,
} as const;

export const capabilitySchema = {
  title: "Capability",
  type: "string",
  enum: CAPABILITIES,
} as const;

export const sessionTargetSchema = {
  title: "SessionTarget",
  type: "string",
  enum: SESSION_TARGETS,
} as const;

export const sessionLifecycleStateSchema = {
  title: "SessionLifecycleState",
  type: "string",
  enum: SESSION_LIFECYCLE_STATES,
} as const;
```

- [ ] **Step 4: Create session schemas**

Create `packages/protocol/src/schemas/session.ts`:

```ts
import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import {
  actorSchema,
  capabilitySchema,
  cliProfileSchema,
  isoDateTimeSchema,
  labelsSchema,
  metadataSchema,
  resourceLimitsSchema,
  sessionTargetSchema,
} from "./common.js";

export const sessionDescriptorSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/session-descriptor.schema.json`,
  title: "SessionDescriptor",
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "profile",
    "target",
    "workspacePath",
    "createdAt",
    "createdBy",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    profile: cliProfileSchema,
    target: sessionTargetSchema,
    workspacePath: { type: "string", const: "/workspace" },
    createdAt: isoDateTimeSchema,
    createdBy: actorSchema,
    displayName: { type: "string", minLength: 1 },
    labels: labelsSchema,
    resourceLimits: resourceLimitsSchema,
    requiredCapabilities: {
      type: "array",
      items: capabilitySchema,
      uniqueItems: true,
    },
    browser: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        headed: { type: "boolean" },
      },
    },
    uat: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        defaultPort: { type: "integer", minimum: 1, maximum: 65535 },
      },
    },
    metadata: metadataSchema,
  },
} as const;

export const createSessionRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/create-session-request.schema.json`,
  title: "CreateSessionRequest",
  type: "object",
  additionalProperties: false,
  required: ["profile", "target"],
  properties: {
    profile: cliProfileSchema,
    target: sessionTargetSchema,
    displayName: { type: "string", minLength: 1 },
    labels: labelsSchema,
    resourceLimits: resourceLimitsSchema,
    requiredCapabilities: {
      type: "array",
      items: capabilitySchema,
      uniqueItems: true,
    },
    metadata: metadataSchema,
  },
} as const;

export const createSessionResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/create-session-response.schema.json`,
  title: "CreateSessionResponse",
  type: "object",
  additionalProperties: false,
  required: ["session"],
  properties: {
    session: sessionDescriptorSchema,
  },
} as const;

export const listSessionsResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/list-sessions-response.schema.json`,
  title: "ListSessionsResponse",
  type: "object",
  additionalProperties: false,
  required: ["sessions"],
  properties: {
    sessions: {
      type: "array",
      items: sessionDescriptorSchema,
    },
  },
} as const;

export const getSessionResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/get-session-response.schema.json`,
  title: "GetSessionResponse",
  type: "object",
  additionalProperties: false,
  required: ["session"],
  properties: {
    session: sessionDescriptorSchema,
  },
} as const;

export const stopSessionRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/stop-session-request.schema.json`,
  title: "StopSessionRequest",
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 1 },
  },
} as const;

export const stopSessionResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/stop-session-response.schema.json`,
  title: "StopSessionResponse",
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "accepted"],
  properties: {
    sessionId: { type: "string", minLength: 1 },
    accepted: { type: "boolean" },
  },
} as const;

export const sendInstructionRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/send-instruction-request.schema.json`,
  title: "SendInstructionRequest",
  type: "object",
  additionalProperties: false,
  required: ["instruction"],
  properties: {
    instruction: { type: "string", minLength: 1 },
    correlationId: { type: "string", minLength: 1 },
    metadata: metadataSchema,
  },
} as const;

export const sendInstructionResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/send-instruction-response.schema.json`,
  title: "SendInstructionResponse",
  type: "object",
  additionalProperties: false,
  required: ["instructionId", "accepted"],
  properties: {
    instructionId: { type: "string", minLength: 1 },
    accepted: { type: "boolean" },
  },
} as const;
```

- [ ] **Step 5: Create schema barrel and type aliases**

Create `packages/protocol/src/schemas/index.ts`:

```ts
export * from "./common.js";
export * from "./session.js";
```

Create `packages/protocol/src/types.ts`:

```ts
import type { FromSchema } from "json-schema-to-ts";
import type { actorSchema } from "./schemas/common.js";
import type {
  createSessionRequestSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
  sendInstructionRequestSchema,
  sendInstructionResponseSchema,
  sessionDescriptorSchema,
  stopSessionRequestSchema,
  stopSessionResponseSchema,
} from "./schemas/session.js";

export type Actor = FromSchema<typeof actorSchema>;
export type SessionDescriptor = FromSchema<typeof sessionDescriptorSchema>;
export type CreateSessionRequest = FromSchema<
  typeof createSessionRequestSchema
>;
export type CreateSessionResponse = FromSchema<
  typeof createSessionResponseSchema
>;
export type ListSessionsResponse = FromSchema<
  typeof listSessionsResponseSchema
>;
export type GetSessionResponse = FromSchema<typeof getSessionResponseSchema>;
export type StopSessionRequest = FromSchema<typeof stopSessionRequestSchema>;
export type StopSessionResponse = FromSchema<typeof stopSessionResponseSchema>;
export type SendInstructionRequest = FromSchema<
  typeof sendInstructionRequestSchema
>;
export type SendInstructionResponse = FromSchema<
  typeof sendInstructionResponseSchema
>;
```

Modify `packages/protocol/src/index.ts` by appending:

```ts
export * from "./schemas/index.js";
export type * from "./types.js";
```

- [ ] **Step 6: Run session schema tests**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test -- src/schemas/schema-validation.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run protocol typecheck**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit session schemas**

Run:

```bash
git -C /tmp/remote-controle-plan0 add packages/protocol/src/index.ts packages/protocol/src/types.ts packages/protocol/src/schemas
git -C /tmp/remote-controle-plan0 commit -m "feat(protocol): add session schemas"
```

## Task 3: Approval, Secret, And Error Schemas

**Files:**

- Create: `packages/protocol/src/schemas/approvals.ts`
- Create: `packages/protocol/src/schemas/secrets.ts`
- Create: `packages/protocol/src/schemas/errors.ts`
- Modify: `packages/protocol/src/schemas/index.ts`
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/schemas/schema-validation.test.ts`

- [ ] **Step 1: Add failing tests for approvals, secrets, and errors**

Append to `packages/protocol/src/schemas/schema-validation.test.ts`:

```ts
import {
  approvalDecisionRequestSchema,
  approvalDecisionResponseSchema,
  approvalRequestSchema,
  remoteErrorSchema,
  secretGrantResponseSchema,
  secretRequestSchema,
} from "./index.js";

describe("approval, secret, and error JSON Schemas", () => {
  it("validates approval request and decision payloads", () => {
    expect(
      ajv.compile(approvalRequestSchema)({
        approvalRequestId: "approval_001",
        sessionId: "session_001",
        capability: "publish-npm",
        risk: "high",
        reason: "Publish package after tests pass",
        requestedBy: { id: "agent_001", kind: "session-agent" },
        requestedAt: "2026-05-11T12:00:00.000Z",
        expiresAt: "2026-05-11T12:05:00.000Z",
        subject: "npm publish",
        proposedAction: "npm publish --access public",
        context: { packageName: "@sentropic/remote-protocol" },
      }),
    ).toBe(true);

    expect(
      ajv.compile(approvalDecisionRequestSchema)({
        approvalRequestId: "approval_001",
        decision: "approved",
        comment: "Tests passed",
      }),
    ).toBe(true);

    expect(
      ajv.compile(approvalDecisionResponseSchema)({
        approvalRequestId: "approval_001",
        decision: "approved",
        decidedAt: "2026-05-11T12:01:00.000Z",
      }),
    ).toBe(true);
  });

  it("validates secret request and grant payloads without secret values", () => {
    const request = {
      secretRequestId: "secret_req_001",
      sessionId: "session_001",
      secretRef: "github-token",
      capability: "read-secret",
      purpose: "Authenticate gh for repository access",
      requestedBy: { id: "agent_001", kind: "session-agent" },
      requestedAt: "2026-05-11T12:00:00.000Z",
      expiresAt: "2026-05-11T12:10:00.000Z",
      delivery: "kubernetes-secret",
      context: { repository: "rhanka/remote-controle" },
    };

    const grant = {
      secretRequestId: "secret_req_001",
      status: "granted",
      handle: "secret_handle_001",
      expiresAt: "2026-05-11T12:10:00.000Z",
      redactedPreview: "ghp_...1234",
    };

    expect(ajv.compile(secretRequestSchema)(request)).toBe(true);
    expect(ajv.compile(secretGrantResponseSchema)(grant)).toBe(true);
    expect(JSON.stringify(grant)).not.toContain("ghp_secret_value");
  });

  it("validates remote errors", () => {
    expect(
      ajv.compile(remoteErrorSchema)({
        code: "capability.denied",
        message: "Capability denied by policy",
        retryable: false,
        correlationId: "corr_001",
        details: { capability: "publish-npm" },
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm missing exports**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test -- src/schemas/schema-validation.test.ts
```

Expected: FAIL with missing approval, secret, or error schema exports.

- [ ] **Step 3: Create approval schemas**

Create `packages/protocol/src/schemas/approvals.ts`:

```ts
import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import {
  actorSchema,
  capabilitySchema,
  isoDateTimeSchema,
  metadataSchema,
} from "./common.js";

export const riskSchema = {
  title: "ApprovalRisk",
  type: "string",
  enum: ["low", "medium", "high", "critical"],
} as const;

export const approvalDecisionSchema = {
  title: "ApprovalDecision",
  type: "string",
  enum: ["approved", "denied", "expired", "cancelled"],
} as const;

export const approvalRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/approval-request.schema.json`,
  title: "ApprovalRequest",
  type: "object",
  additionalProperties: false,
  required: [
    "approvalRequestId",
    "sessionId",
    "capability",
    "risk",
    "reason",
    "requestedBy",
    "requestedAt",
    "expiresAt",
    "subject",
    "proposedAction",
    "context",
  ],
  properties: {
    approvalRequestId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    capability: capabilitySchema,
    risk: riskSchema,
    reason: { type: "string", minLength: 1 },
    requestedBy: actorSchema,
    requestedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    subject: { type: "string", minLength: 1 },
    proposedAction: { type: "string", minLength: 1 },
    context: metadataSchema,
  },
} as const;

export const approvalDecisionRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/approval-decision-request.schema.json`,
  title: "ApprovalDecisionRequest",
  type: "object",
  additionalProperties: false,
  required: ["approvalRequestId", "decision"],
  properties: {
    approvalRequestId: { type: "string", minLength: 1 },
    decision: approvalDecisionSchema,
    comment: { type: "string" },
    grant: metadataSchema,
  },
} as const;

export const approvalDecisionResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/approval-decision-response.schema.json`,
  title: "ApprovalDecisionResponse",
  type: "object",
  additionalProperties: false,
  required: ["approvalRequestId", "decision", "decidedAt"],
  properties: {
    approvalRequestId: { type: "string", minLength: 1 },
    decision: approvalDecisionSchema,
    decidedAt: isoDateTimeSchema,
    comment: { type: "string" },
    grant: metadataSchema,
  },
} as const;
```

- [ ] **Step 4: Create secret schemas**

Create `packages/protocol/src/schemas/secrets.ts`:

```ts
import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import {
  actorSchema,
  capabilitySchema,
  isoDateTimeSchema,
  metadataSchema,
} from "./common.js";

export const secretDeliverySchema = {
  title: "SecretDelivery",
  type: "string",
  enum: ["kubernetes-secret", "env", "file", "stdin", "browser-user-entry"],
} as const;

export const secretGrantStatusSchema = {
  title: "SecretGrantStatus",
  type: "string",
  enum: ["granted", "denied", "expired", "unavailable"],
} as const;

export const secretRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/secret-request.schema.json`,
  title: "SecretRequest",
  type: "object",
  additionalProperties: false,
  required: [
    "secretRequestId",
    "sessionId",
    "secretRef",
    "capability",
    "purpose",
    "requestedBy",
    "requestedAt",
    "expiresAt",
    "delivery",
    "context",
  ],
  properties: {
    secretRequestId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    secretRef: { type: "string", minLength: 1 },
    capability: capabilitySchema,
    purpose: { type: "string", minLength: 1 },
    requestedBy: actorSchema,
    requestedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    delivery: secretDeliverySchema,
    context: metadataSchema,
  },
} as const;

export const secretGrantResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/secret-grant-response.schema.json`,
  title: "SecretGrantResponse",
  type: "object",
  additionalProperties: false,
  required: ["secretRequestId", "status"],
  properties: {
    secretRequestId: { type: "string", minLength: 1 },
    status: secretGrantStatusSchema,
    handle: { type: "string", minLength: 1 },
    expiresAt: isoDateTimeSchema,
    redactedPreview: { type: "string" },
    metadata: metadataSchema,
  },
} as const;
```

- [ ] **Step 5: Create error schema**

Create `packages/protocol/src/schemas/errors.ts`:

```ts
import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import { metadataSchema } from "./common.js";

export const remoteErrorCodeSchema = {
  title: "RemoteErrorCode",
  type: "string",
  enum: [
    "validation.failed",
    "session.not_found",
    "session.state_conflict",
    "approval.expired",
    "approval.denied",
    "secret.unavailable",
    "capability.denied",
    "k8s.provisioning_failed",
    "terminal.unavailable",
    "browser.unavailable",
    "internal.error",
  ],
} as const;

export const remoteErrorSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/remote-error.schema.json`,
  title: "RemoteError",
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "retryable"],
  properties: {
    code: remoteErrorCodeSchema,
    message: { type: "string", minLength: 1 },
    retryable: { type: "boolean" },
    correlationId: { type: "string", minLength: 1 },
    details: metadataSchema,
  },
} as const;
```

- [ ] **Step 6: Export schemas and types**

Append to `packages/protocol/src/schemas/index.ts`:

```ts
export * from "./approvals.js";
export * from "./secrets.js";
export * from "./errors.js";
```

Append to `packages/protocol/src/types.ts`:

```ts
import type {
  approvalDecisionRequestSchema,
  approvalDecisionResponseSchema,
  approvalRequestSchema,
} from "./schemas/approvals.js";
import type { remoteErrorSchema } from "./schemas/errors.js";
import type {
  secretGrantResponseSchema,
  secretRequestSchema,
} from "./schemas/secrets.js";

export type ApprovalRequest = FromSchema<typeof approvalRequestSchema>;
export type ApprovalDecisionRequest = FromSchema<
  typeof approvalDecisionRequestSchema
>;
export type ApprovalDecisionResponse = FromSchema<
  typeof approvalDecisionResponseSchema
>;
export type SecretRequest = FromSchema<typeof secretRequestSchema>;
export type SecretGrantResponse = FromSchema<typeof secretGrantResponseSchema>;
export type RemoteError = FromSchema<typeof remoteErrorSchema>;
```

- [ ] **Step 7: Run validation and typecheck**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test -- src/schemas/schema-validation.test.ts
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol typecheck
```

Expected: both PASS.

- [ ] **Step 8: Commit approval, secret, and error schemas**

Run:

```bash
git -C /tmp/remote-controle-plan0 add packages/protocol/src/schemas packages/protocol/src/types.ts
git -C /tmp/remote-controle-plan0 commit -m "feat(protocol): add approval and secret schemas"
```

## Task 4: Terminal, Browser, And UAT Schemas

**Files:**

- Create: `packages/protocol/src/schemas/terminal.ts`
- Create: `packages/protocol/src/schemas/browser.ts`
- Modify: `packages/protocol/src/schemas/index.ts`
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/schemas/schema-validation.test.ts`

- [ ] **Step 1: Add failing tests for terminal and browser payloads**

Append to `packages/protocol/src/schemas/schema-validation.test.ts`:

```ts
import {
  browserTwoFactorRequestSchema,
  browserUserTakeoverChangedSchema,
  terminalOutputSchema,
  terminalResizeSchema,
  uatRouteCreatedSchema,
} from "./index.js";

describe("terminal, browser, and UAT JSON Schemas", () => {
  it("validates terminal output and resize payloads", () => {
    expect(
      ajv.compile(terminalOutputSchema)({
        terminalId: "term_001",
        stream: "stdout",
        data: "$ npm test\n",
        encoding: "utf8",
      }),
    ).toBe(true);

    expect(
      ajv.compile(terminalResizeSchema)({
        terminalId: "term_001",
        columns: 120,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("validates browser 2FA, takeover, and UAT route payloads", () => {
    expect(
      ajv.compile(browserTwoFactorRequestSchema)({
        pageId: "page_001",
        url: "https://github.com/login",
        challengeId: "challenge_001",
        method: "totp",
        requestedAt: "2026-05-11T12:00:00.000Z",
        expiresAt: "2026-05-11T12:02:00.000Z",
      }),
    ).toBe(true);

    expect(
      ajv.compile(browserUserTakeoverChangedSchema)({
        pageId: "page_001",
        state: "active",
        changedAt: "2026-05-11T12:01:00.000Z",
      }),
    ).toBe(true);

    expect(
      ajv.compile(uatRouteCreatedSchema)({
        routeId: "uat_001",
        url: "https://uat.example.invalid/session_001",
        port: 5173,
        expiresAt: "2026-05-11T13:00:00.000Z",
        exposurePolicy: "operator-only",
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm missing exports**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test -- src/schemas/schema-validation.test.ts
```

Expected: FAIL with missing terminal/browser/UAT schema exports.

- [ ] **Step 3: Create terminal schemas**

Create `packages/protocol/src/schemas/terminal.ts`:

```ts
import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import { metadataSchema } from "./common.js";

export const terminalOpenedSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-opened.schema.json`,
  title: "TerminalOpened",
  type: "object",
  additionalProperties: false,
  required: ["terminalId", "shell"],
  properties: {
    terminalId: { type: "string", minLength: 1 },
    shell: { type: "string", minLength: 1 },
    metadata: metadataSchema,
  },
} as const;

export const terminalInputSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-input.schema.json`,
  title: "TerminalInput",
  type: "object",
  additionalProperties: false,
  required: ["terminalId", "data", "encoding"],
  properties: {
    terminalId: { type: "string", minLength: 1 },
    data: { type: "string" },
    encoding: { type: "string", const: "utf8" },
  },
} as const;

export const terminalOutputSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-output.schema.json`,
  title: "TerminalOutput",
  type: "object",
  additionalProperties: false,
  required: ["terminalId", "stream", "data", "encoding"],
  properties: {
    terminalId: { type: "string", minLength: 1 },
    stream: { type: "string", enum: ["stdout", "stderr", "system"] },
    data: { type: "string" },
    encoding: { type: "string", const: "utf8" },
    truncated: { type: "boolean" },
  },
} as const;

export const terminalResizeSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-resize.schema.json`,
  title: "TerminalResize",
  type: "object",
  additionalProperties: false,
  required: ["terminalId", "columns", "rows"],
  properties: {
    terminalId: { type: "string", minLength: 1 },
    columns: { type: "integer", minimum: 1 },
    rows: { type: "integer", minimum: 1 },
  },
} as const;

export const terminalExitedSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/terminal-exited.schema.json`,
  title: "TerminalExited",
  type: "object",
  additionalProperties: false,
  required: ["terminalId", "exitCode"],
  properties: {
    terminalId: { type: "string", minLength: 1 },
    exitCode: { type: "integer" },
    signal: { type: "string" },
  },
} as const;
```

- [ ] **Step 4: Create browser and UAT schemas**

Create `packages/protocol/src/schemas/browser.ts`:

```ts
import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import { isoDateTimeSchema, metadataSchema } from "./common.js";

export const browserTransportSchema = {
  title: "BrowserTransport",
  type: "string",
  enum: ["webrtc", "websocket", "novnc", "playwright-control"],
} as const;

export const browserStartedSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/browser-started.schema.json`,
  title: "BrowserStarted",
  type: "object",
  additionalProperties: false,
  required: ["browserId", "transport"],
  properties: {
    browserId: { type: "string", minLength: 1 },
    transport: browserTransportSchema,
    metadata: metadataSchema,
  },
} as const;

export const browserNavigatedSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/browser-navigated.schema.json`,
  title: "BrowserNavigated",
  type: "object",
  additionalProperties: false,
  required: ["pageId", "url"],
  properties: {
    pageId: { type: "string", minLength: 1 },
    url: { type: "string", minLength: 1 },
    title: { type: "string" },
  },
} as const;

export const browserTwoFactorRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/browser-2fa-request.schema.json`,
  title: "BrowserTwoFactorRequest",
  type: "object",
  additionalProperties: false,
  required: [
    "pageId",
    "url",
    "challengeId",
    "method",
    "requestedAt",
    "expiresAt",
  ],
  properties: {
    pageId: { type: "string", minLength: 1 },
    url: { type: "string", minLength: 1 },
    challengeId: { type: "string", minLength: 1 },
    method: {
      type: "string",
      enum: ["totp", "sms", "email", "webauthn", "unknown"],
    },
    requestedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    context: metadataSchema,
  },
} as const;

export const browserUserTakeoverRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/browser-user-takeover-request.schema.json`,
  title: "BrowserUserTakeoverRequest",
  type: "object",
  additionalProperties: false,
  required: ["pageId", "reason", "requestedAt"],
  properties: {
    pageId: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    requestedAt: isoDateTimeSchema,
  },
} as const;

export const browserUserTakeoverChangedSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/browser-user-takeover-changed.schema.json`,
  title: "BrowserUserTakeoverChanged",
  type: "object",
  additionalProperties: false,
  required: ["pageId", "state", "changedAt"],
  properties: {
    pageId: { type: "string", minLength: 1 },
    state: {
      type: "string",
      enum: ["requested", "active", "released", "expired"],
    },
    changedAt: isoDateTimeSchema,
  },
} as const;

export const browserSensitiveActionRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/browser-sensitive-action-request.schema.json`,
  title: "BrowserSensitiveActionRequest",
  type: "object",
  additionalProperties: false,
  required: ["pageId", "url", "action", "requestedAt"],
  properties: {
    pageId: { type: "string", minLength: 1 },
    url: { type: "string", minLength: 1 },
    action: { type: "string", minLength: 1 },
    requestedAt: isoDateTimeSchema,
    context: metadataSchema,
  },
} as const;

export const uatRouteCreatedSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/uat-route-created.schema.json`,
  title: "UatRouteCreated",
  type: "object",
  additionalProperties: false,
  required: ["routeId", "url", "port", "expiresAt", "exposurePolicy"],
  properties: {
    routeId: { type: "string", minLength: 1 },
    url: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    expiresAt: isoDateTimeSchema,
    exposurePolicy: {
      type: "string",
      enum: ["operator-only", "session-private", "public-expiring"],
    },
  },
} as const;

export const uatRouteExpiredSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/uat-route-expired.schema.json`,
  title: "UatRouteExpired",
  type: "object",
  additionalProperties: false,
  required: ["routeId", "expiredAt"],
  properties: {
    routeId: { type: "string", minLength: 1 },
    expiredAt: isoDateTimeSchema,
  },
} as const;
```

- [ ] **Step 5: Export schemas and types**

Append to `packages/protocol/src/schemas/index.ts`:

```ts
export * from "./terminal.js";
export * from "./browser.js";
```

Append to `packages/protocol/src/types.ts`:

```ts
import type {
  browserNavigatedSchema,
  browserSensitiveActionRequestSchema,
  browserStartedSchema,
  browserTwoFactorRequestSchema,
  browserUserTakeoverChangedSchema,
  browserUserTakeoverRequestSchema,
  uatRouteCreatedSchema,
  uatRouteExpiredSchema,
} from "./schemas/browser.js";
import type {
  terminalExitedSchema,
  terminalInputSchema,
  terminalOpenedSchema,
  terminalOutputSchema,
  terminalResizeSchema,
} from "./schemas/terminal.js";

export type TerminalOpened = FromSchema<typeof terminalOpenedSchema>;
export type TerminalInput = FromSchema<typeof terminalInputSchema>;
export type TerminalOutput = FromSchema<typeof terminalOutputSchema>;
export type TerminalResize = FromSchema<typeof terminalResizeSchema>;
export type TerminalExited = FromSchema<typeof terminalExitedSchema>;
export type BrowserStarted = FromSchema<typeof browserStartedSchema>;
export type BrowserNavigated = FromSchema<typeof browserNavigatedSchema>;
export type BrowserTwoFactorRequest = FromSchema<
  typeof browserTwoFactorRequestSchema
>;
export type BrowserUserTakeoverRequest = FromSchema<
  typeof browserUserTakeoverRequestSchema
>;
export type BrowserUserTakeoverChanged = FromSchema<
  typeof browserUserTakeoverChangedSchema
>;
export type BrowserSensitiveActionRequest = FromSchema<
  typeof browserSensitiveActionRequestSchema
>;
export type UatRouteCreated = FromSchema<typeof uatRouteCreatedSchema>;
export type UatRouteExpired = FromSchema<typeof uatRouteExpiredSchema>;
```

- [ ] **Step 6: Run validation and typecheck**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test -- src/schemas/schema-validation.test.ts
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol typecheck
```

Expected: both PASS.

- [ ] **Step 7: Commit terminal/browser/UAT schemas**

Run:

```bash
git -C /tmp/remote-controle-plan0 add packages/protocol/src/schemas packages/protocol/src/types.ts
git -C /tmp/remote-controle-plan0 commit -m "feat(protocol): add terminal and browser schemas"
```

## Task 5: Event Envelope, Examples, And OpenAPI Components

**Files:**

- Create: `packages/protocol/src/schemas/events.ts`
- Create: `packages/protocol/src/examples.ts`
- Create: `packages/protocol/src/openapi.ts`
- Create: `packages/protocol/src/openapi.test.ts`
- Modify: `packages/protocol/src/schemas/index.ts`
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/schemas/schema-validation.test.ts`

- [ ] **Step 1: Add failing tests for event examples**

Append to `packages/protocol/src/schemas/schema-validation.test.ts`:

```ts
import { remoteEventEnvelopeSchema } from "./index.js";
import {
  approvalRequestedEventExample,
  browserTwoFactorRequestedEventExample,
  sessionLifecycleChangedEventExample,
  terminalOutputEventExample,
} from "../examples.js";

describe("remote event envelope JSON Schema", () => {
  it("validates representative event examples", () => {
    const validate = ajv.compile(remoteEventEnvelopeSchema);

    expect(validate(sessionLifecycleChangedEventExample)).toBe(true);
    expect(validate(approvalRequestedEventExample)).toBe(true);
    expect(validate(terminalOutputEventExample)).toBe(true);
    expect(validate(browserTwoFactorRequestedEventExample)).toBe(true);
  });

  it("rejects an event without protocol version", () => {
    const validate = ajv.compile(remoteEventEnvelopeSchema);
    const { protocolVersion: _protocolVersion, ...invalid } =
      terminalOutputEventExample;

    expect(validate(invalid)).toBe(false);
  });
});
```

- [ ] **Step 2: Add failing OpenAPI coverage tests**

Create `packages/protocol/src/openapi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  remoteOpenApiComponents,
  sessionDescriptorSchema,
  remoteEventEnvelopeSchema,
  approvalRequestSchema,
  secretRequestSchema,
  remoteErrorSchema,
} from "./index.js";

describe("remoteOpenApiComponents", () => {
  it("contains the public schemas needed by the control-plane", () => {
    expect(remoteOpenApiComponents.schemas.SessionDescriptor).toBe(
      sessionDescriptorSchema,
    );
    expect(remoteOpenApiComponents.schemas.RemoteEventEnvelope).toBe(
      remoteEventEnvelopeSchema,
    );
    expect(remoteOpenApiComponents.schemas.ApprovalRequest).toBe(
      approvalRequestSchema,
    );
    expect(remoteOpenApiComponents.schemas.SecretRequest).toBe(
      secretRequestSchema,
    );
    expect(remoteOpenApiComponents.schemas.RemoteError).toBe(remoteErrorSchema);
  });

  it("exports schemas with ids and titles", () => {
    for (const [name, schema] of Object.entries(
      remoteOpenApiComponents.schemas,
    )) {
      expect(name).toMatch(/^[A-Z]/);
      expect(schema).toHaveProperty("$id");
      expect(schema).toHaveProperty("title");
    }
  });
});
```

- [ ] **Step 3: Run tests to confirm missing exports**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test -- src/schemas/schema-validation.test.ts src/openapi.test.ts
```

Expected: FAIL with missing `remoteEventEnvelopeSchema`, examples, or `remoteOpenApiComponents`.

- [ ] **Step 4: Create event schema**

Create `packages/protocol/src/schemas/events.ts`:

```ts
import { EVENT_TYPES, REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import {
  actorSchema,
  isoDateTimeSchema,
  metadataSchema,
  protocolEnvelopeProperties,
} from "./common.js";

export const remoteEventEnvelopeSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/remote-event-envelope.schema.json`,
  title: "RemoteEventEnvelope",
  type: "object",
  additionalProperties: false,
  required: [
    "protocolVersion",
    "schemaVersion",
    "eventId",
    "sessionId",
    "sequence",
    "type",
    "occurredAt",
    "correlationId",
    "actor",
    "payload",
  ],
  properties: {
    ...protocolEnvelopeProperties,
    eventId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    sequence: { type: "integer", minimum: 0 },
    type: { type: "string", enum: EVENT_TYPES },
    occurredAt: isoDateTimeSchema,
    correlationId: { type: "string", minLength: 1 },
    actor: actorSchema,
    payload: metadataSchema,
    metadata: metadataSchema,
  },
} as const;
```

- [ ] **Step 5: Export event schema and type**

Append to `packages/protocol/src/schemas/index.ts`:

```ts
export * from "./events.js";
```

Append to `packages/protocol/src/types.ts`:

```ts
import type { remoteEventEnvelopeSchema } from "./schemas/events.js";

export type RemoteEventEnvelope = FromSchema<typeof remoteEventEnvelopeSchema>;
```

- [ ] **Step 6: Create examples**

Create `packages/protocol/src/examples.ts`:

```ts
import { REMOTE_PROTOCOL_VERSION, REMOTE_SCHEMA_VERSION } from "./constants.js";
import type { RemoteEventEnvelope } from "./types.js";

const baseEvent = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  schemaVersion: REMOTE_SCHEMA_VERSION,
  sessionId: "session_001",
  occurredAt: "2026-05-11T12:00:00.000Z",
  correlationId: "corr_001",
  actor: {
    id: "control-plane",
    kind: "control-plane",
  },
} as const;

export const sessionDescriptorExample = {
  id: "session_001",
  profile: "codex",
  target: "k3s",
  workspacePath: "/workspace",
  createdAt: "2026-05-11T12:00:00.000Z",
  createdBy: {
    id: "user_001",
    kind: "user",
    displayName: "Antoine",
  },
  requiredCapabilities: ["read-secret", "browser-login"],
} as const;

export const sessionLifecycleChangedEventExample = {
  ...baseEvent,
  eventId: "event_001",
  sequence: 1,
  type: "session.lifecycle.changed",
  payload: {
    previousState: "provisioning",
    nextState: "ready",
  },
} satisfies RemoteEventEnvelope;

export const approvalRequestedEventExample = {
  ...baseEvent,
  eventId: "event_002",
  sequence: 2,
  type: "approval.requested",
  payload: {
    approvalRequestId: "approval_001",
    capability: "publish-npm",
    risk: "high",
    subject: "npm publish",
  },
} satisfies RemoteEventEnvelope;

export const terminalOutputEventExample = {
  ...baseEvent,
  eventId: "event_003",
  sequence: 3,
  type: "terminal.output",
  payload: {
    terminalId: "term_001",
    stream: "stdout",
    data: "$ npm test\n",
    encoding: "utf8",
  },
} satisfies RemoteEventEnvelope;

export const browserTwoFactorRequestedEventExample = {
  ...baseEvent,
  eventId: "event_004",
  sequence: 4,
  type: "browser.2fa.requested",
  payload: {
    pageId: "page_001",
    url: "https://github.com/login",
    challengeId: "challenge_001",
    method: "totp",
    requestedAt: "2026-05-11T12:00:00.000Z",
    expiresAt: "2026-05-11T12:02:00.000Z",
  },
} satisfies RemoteEventEnvelope;
```

- [ ] **Step 7: Create OpenAPI components**

Create `packages/protocol/src/openapi.ts`:

```ts
import {
  approvalDecisionRequestSchema,
  approvalDecisionResponseSchema,
  approvalRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
  remoteErrorSchema,
  remoteEventEnvelopeSchema,
  secretGrantResponseSchema,
  secretRequestSchema,
  sendInstructionRequestSchema,
  sendInstructionResponseSchema,
  sessionDescriptorSchema,
  stopSessionRequestSchema,
  stopSessionResponseSchema,
} from "./schemas/index.js";

export const remoteOpenApiComponents = {
  schemas: {
    ApprovalDecisionRequest: approvalDecisionRequestSchema,
    ApprovalDecisionResponse: approvalDecisionResponseSchema,
    ApprovalRequest: approvalRequestSchema,
    CreateSessionRequest: createSessionRequestSchema,
    CreateSessionResponse: createSessionResponseSchema,
    GetSessionResponse: getSessionResponseSchema,
    ListSessionsResponse: listSessionsResponseSchema,
    RemoteError: remoteErrorSchema,
    RemoteEventEnvelope: remoteEventEnvelopeSchema,
    SecretGrantResponse: secretGrantResponseSchema,
    SecretRequest: secretRequestSchema,
    SendInstructionRequest: sendInstructionRequestSchema,
    SendInstructionResponse: sendInstructionResponseSchema,
    SessionDescriptor: sessionDescriptorSchema,
    StopSessionRequest: stopSessionRequestSchema,
    StopSessionResponse: stopSessionResponseSchema,
  },
} as const;
```

Modify `packages/protocol/src/index.ts` by appending:

```ts
export * from "./examples.js";
export * from "./openapi.js";
```

- [ ] **Step 8: Run event/OpenAPI tests and typecheck**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test -- src/schemas/schema-validation.test.ts src/openapi.test.ts
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol typecheck
```

Expected: both PASS.

- [ ] **Step 9: Commit events, examples, and OpenAPI components**

Run:

```bash
git -C /tmp/remote-controle-plan0 add packages/protocol/src
git -C /tmp/remote-controle-plan0 commit -m "feat(protocol): add event and openapi contracts"
```

## Task 6: Scaffold Integration And Full Verification

**Files:**

- Modify: `apps/control-plane/src/index.ts`
- Modify: `apps/control-plane/src/index.test.ts`
- Modify: `apps/operator-ui/src/routes/+page.svelte` only if imports fail after protocol exports.
- Modify: `packages/protocol/src/index.test.ts`
- Modify: `README.md` only if protocol command docs need an update.

- [ ] **Step 1: Run full repo verification to find integration breakage**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 verify
```

Expected before fixes: either PASS or FAIL only on imports still using `REMOTE_CONTROLE_PROTOCOL_VERSION`. If it passes, still perform Step 2 to migrate the control-plane to the new constant.

- [ ] **Step 2: Update control-plane to the new version constant**

Modify `apps/control-plane/src/index.ts` import:

```ts
import { REMOTE_PROTOCOL_VERSION } from "@remote-controle/protocol";
```

Modify the health response:

```ts
protocolVersion: REMOTE_PROTOCOL_VERSION,
```

- [ ] **Step 3: Update control-plane test expectation if needed**

If `apps/control-plane/src/index.test.ts` asserts `"0.0.0"`, change the expected protocol version to `"0.1.0"`.

The expected assertion should be:

```ts
expect(payload).toMatchObject({
  ok: true,
  service: "remote-controle-control-plane",
  protocolVersion: "0.1.0",
});
```

- [ ] **Step 4: Keep compatibility covered in protocol tests**

Ensure `packages/protocol/src/index.test.ts` still contains:

```ts
expect(REMOTE_CONTROLE_PROTOCOL_VERSION).toBe(REMOTE_PROTOCOL_VERSION);
```

This allows older scaffold code to compile while new code migrates to `REMOTE_PROTOCOL_VERSION`.

- [ ] **Step 5: Run focused app and protocol tests**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/protocol test
corepack pnpm --dir /tmp/remote-controle-plan0 --filter @remote-controle/control-plane test
```

Expected: both PASS.

- [ ] **Step 6: Run full verification**

Run:

```bash
corepack pnpm --dir /tmp/remote-controle-plan0 verify
```

Expected: PASS for format, lint, typecheck, test, and build.

- [ ] **Step 7: Scan for old naming and leaked work markers**

Run:

```bash
rg -n "@entro[p]iq|@entro[p]ic|Entro[p]iq Remote|Entro[p]ic Remote" /tmp/remote-controle-plan0/README.md /tmp/remote-controle-plan0/docs /tmp/remote-controle-plan0/packages/protocol /tmp/remote-controle-plan0/apps/control-plane
rg -n "[T]BD|[T]ODO|[F]IXME" /tmp/remote-controle-plan0/packages/protocol /tmp/remote-controle-plan0/apps/control-plane
git -C /tmp/remote-controle-plan0 diff --check
```

Expected:

```text
rg exits 1 with no matches
git diff --check exits 0
```

- [ ] **Step 8: Commit integration**

Run:

```bash
git -C /tmp/remote-controle-plan0 add apps/control-plane/src packages/protocol/src README.md
git -C /tmp/remote-controle-plan0 commit -m "chore(protocol): wire protocol version"
```

- [ ] **Step 9: Push branch**

Run:

```bash
git -C /tmp/remote-controle-plan0 status --short --branch
git -C /tmp/remote-controle-plan0 push origin feat-plan-0-scaffold
```

Expected status before push:

```text
## feat-plan-0-scaffold...origin/feat-plan-0-scaffold [ahead N]
```

Expected push result: branch updates on `origin/feat-plan-0-scaffold`.

## Self-Review Checklist

- Spec coverage:
  - JSON Schema source of truth: Tasks 2-5.
  - OpenAPI components: Task 5.
  - TypeScript types: Tasks 2-5 through `json-schema-to-ts`.
  - Runtime validation: Ajv tests in Tasks 2-5.
  - No Drizzle/k8s/storage in protocol: no task adds those dependencies.
  - Compatibility with current scaffold: Task 6.
- Placeholder scan:
  - The future execution scan avoids matching this planning document while still
    checking implementation files for leaked work markers.
  - Every code step includes concrete file paths and code blocks.
- Type consistency:
  - `REMOTE_PROTOCOL_VERSION` is the new constant.
  - `REMOTE_CONTROLE_PROTOCOL_VERSION` remains a compatibility alias.
  - Event envelope uses `protocolVersion`, `schemaVersion`, `eventId`,
    `sessionId`, `sequence`, `type`, `occurredAt`, `correlationId`, `actor`,
    and `payload`.
  - `workspacePath` remains fixed to `/workspace`.
