import { EVENT_TYPES, REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import {
  approvalDecisionResponseSchema,
  approvalRequestSchema,
} from "./approvals.js";
import {
  browserNavigatedSchema,
  browserSensitiveActionRequestSchema,
  browserStartedSchema,
  browserTwoFactorRequestSchema,
  browserUserTakeoverChangedSchema,
  browserUserTakeoverRequestSchema,
  uatRouteCreatedSchema,
  uatRouteExpiredSchema,
} from "./browser.js";
import {
  actorSchema,
  isoDateTimeSchema,
  metadataSchema,
  protocolEnvelopeProperties,
  sessionLifecycleStateSchema,
} from "./common.js";
import { secretGrantResponseSchema, secretRequestSchema } from "./secrets.js";
import {
  terminalExitedSchema,
  terminalInputSchema,
  terminalOpenedSchema,
  terminalOutputSchema,
  terminalResizeSchema,
} from "./terminal.js";

type EventType = (typeof EVENT_TYPES)[number];
type JsonSchemaObject = { readonly [key: string]: unknown };

const stripSchemaIds = <T>(schema: T): T => {
  if (Array.isArray(schema)) {
    return schema.map((item) => stripSchemaIds(item)) as T;
  }

  if (schema !== null && typeof schema === "object") {
    const stripped: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema)) {
      if (key === "$id") {
        continue;
      }

      stripped[key] = stripSchemaIds(value);
    }

    return stripped as T;
  }

  return schema;
};

const embeddedActorSchema = stripSchemaIds(actorSchema);
const embeddedSessionLifecycleStateSchema = stripSchemaIds(
  sessionLifecycleStateSchema,
);

export const sessionLifecycleChangedPayloadSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/session-lifecycle-changed-payload.schema.json`,
  title: "SessionLifecycleChangedPayload",
  type: "object",
  additionalProperties: false,
  required: ["nextState"],
  properties: {
    previousState: embeddedSessionLifecycleStateSchema,
    nextState: embeddedSessionLifecycleStateSchema,
  },
} as const;

export const sessionHealthReportedPayloadSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/session-health-reported-payload.schema.json`,
  title: "SessionHealthReportedPayload",
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
    message: { type: "string", minLength: 1 },
    checks: metadataSchema,
  },
} as const;

export const sessionInstructionReceivedPayloadSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/session-instruction-received-payload.schema.json`,
  title: "SessionInstructionReceivedPayload",
  type: "object",
  additionalProperties: false,
  required: ["instructionId", "instruction"],
  properties: {
    instructionId: { type: "string", minLength: 1 },
    instruction: { type: "string", minLength: 1 },
    correlationId: { type: "string", minLength: 1 },
    metadata: metadataSchema,
  },
} as const;

export const sessionInstructionCompletedPayloadSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/session-instruction-completed-payload.schema.json`,
  title: "SessionInstructionCompletedPayload",
  type: "object",
  additionalProperties: false,
  required: ["instructionId", "status"],
  properties: {
    instructionId: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["completed", "failed", "cancelled"] },
    exitCode: { type: "integer" },
    message: { type: "string", minLength: 1 },
    metadata: metadataSchema,
  },
} as const;

export const secretRevokedPayloadSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/secret-revoked-payload.schema.json`,
  title: "SecretRevokedPayload",
  type: "object",
  additionalProperties: false,
  required: ["secretRequestId", "revokedAt"],
  properties: {
    secretRequestId: { type: "string", minLength: 1 },
    revokedAt: isoDateTimeSchema,
    reason: { type: "string", minLength: 1 },
    metadata: metadataSchema,
  },
} as const;

export const auditRecordedPayloadSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/audit-recorded-payload.schema.json`,
  title: "AuditRecordedPayload",
  type: "object",
  additionalProperties: false,
  required: ["action", "result"],
  properties: {
    action: { type: "string", minLength: 1 },
    result: { type: "string", enum: ["allowed", "denied", "failed"] },
    details: metadataSchema,
    metadata: metadataSchema,
  },
} as const;

const eventPayloadSchemasByType = {
  "session.lifecycle.changed": sessionLifecycleChangedPayloadSchema,
  "session.health.reported": sessionHealthReportedPayloadSchema,
  "session.instruction.received": sessionInstructionReceivedPayloadSchema,
  "session.instruction.completed": sessionInstructionCompletedPayloadSchema,
  "approval.requested": approvalRequestSchema,
  "approval.decided": approvalDecisionResponseSchema,
  "secret.requested": secretRequestSchema,
  "secret.granted": secretGrantResponseSchema,
  "secret.revoked": secretRevokedPayloadSchema,
  "terminal.opened": terminalOpenedSchema,
  "terminal.input": terminalInputSchema,
  "terminal.output": terminalOutputSchema,
  "terminal.resized": terminalResizeSchema,
  "terminal.exited": terminalExitedSchema,
  "browser.started": browserStartedSchema,
  "browser.navigated": browserNavigatedSchema,
  "browser.user-takeover.requested": browserUserTakeoverRequestSchema,
  "browser.user-takeover.changed": browserUserTakeoverChangedSchema,
  "browser.2fa.requested": browserTwoFactorRequestSchema,
  "browser.sensitive-action.requested": browserSensitiveActionRequestSchema,
  "uat.route.created": uatRouteCreatedSchema,
  "uat.route.expired": uatRouteExpiredSchema,
  "audit.recorded": auditRecordedPayloadSchema,
} satisfies Record<EventType, JsonSchemaObject>;

const eventPayloadCase = (type: EventType, payloadSchema: JsonSchemaObject) =>
  ({
    type: "object",
    required: ["type", "payload"],
    properties: {
      type: { const: type },
      payload: stripSchemaIds(payloadSchema),
    },
  }) as const;

const eventPayloadCases = EVENT_TYPES.map((type) =>
  eventPayloadCase(type, eventPayloadSchemasByType[type]),
);

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
    actor: embeddedActorSchema,
    payload: metadataSchema,
    metadata: metadataSchema,
  },
  oneOf: eventPayloadCases,
} as const;
