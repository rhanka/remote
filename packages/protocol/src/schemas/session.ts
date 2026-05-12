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

const { $id: _actorSchemaId, ...embeddedActorSchema } = actorSchema;

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
    createdBy: embeddedActorSchema,
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

const { $id: _sessionDescriptorSchemaId, ...embeddedSessionDescriptorSchema } =
  sessionDescriptorSchema;

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
    session: embeddedSessionDescriptorSchema,
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
      items: embeddedSessionDescriptorSchema,
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
    session: embeddedSessionDescriptorSchema,
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
