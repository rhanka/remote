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
  stripSchemaIds,
} from "./common.js";

const embeddedActorSchema = stripSchemaIds(actorSchema);
const embeddedCapabilitySchema = stripSchemaIds(capabilitySchema);
const embeddedCliProfileSchema = stripSchemaIds(cliProfileSchema);
const embeddedResourceLimitsSchema = stripSchemaIds(resourceLimitsSchema);
const embeddedSessionTargetSchema = stripSchemaIds(sessionTargetSchema);

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
    profile: embeddedCliProfileSchema,
    target: embeddedSessionTargetSchema,
    workspacePath: { type: "string", const: "/workspace" },
    workspaceId: { type: "string", minLength: 1 },
    cliSessionId: {
      type: "string",
      minLength: 1,
      description:
        "The wrapped CLI's own conversation/session id (codex/claude/agy), reported by the session-agent once detected. Informational, shown in `remote ls`.",
    },
    createdAt: isoDateTimeSchema,
    createdBy: embeddedActorSchema,
    displayName: { type: "string", minLength: 1 },
    labels: labelsSchema,
    resourceLimits: embeddedResourceLimitsSchema,
    requiredCapabilities: {
      type: "array",
      items: embeddedCapabilitySchema,
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

const embeddedSessionDescriptorSchema = stripSchemaIds(sessionDescriptorSchema);

export const sessionCredentialsSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/session-credentials.schema.json`,
  title: "SessionCredentials",
  description:
    "Map of HOME-relative file paths to base64-encoded payloads. The session-agent Pod mounts these as a Kubernetes Secret under the container HOME so a CLI's auth.json / .credentials.json / oauth_creds.json files are pre-populated.",
  type: "object",
  additionalProperties: {
    type: "string",
    contentEncoding: "base64",
    minLength: 1,
  },
} as const;

const embeddedSessionCredentialsSchema = stripSchemaIds(sessionCredentialsSchema);

export const refreshSessionCredentialsRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/refresh-session-credentials-request.schema.json`,
  title: "RefreshSessionCredentialsRequest",
  description:
    "Map of HOME-relative file paths to base64-encoded payloads to update for an active session.",
  type: "object",
  additionalProperties: {
    type: "string",
    contentEncoding: "base64",
    minLength: 1,
  },
  minProperties: 1,
} as const;

export const refreshSessionCredentialsResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/refresh-session-credentials-response.schema.json`,
  title: "RefreshSessionCredentialsResponse",
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "accepted"],
  properties: {
    sessionId: { type: "string", minLength: 1 },
    accepted: { type: "boolean" },
  },
} as const;

export const createSessionRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/create-session-request.schema.json`,
  title: "CreateSessionRequest",
  type: "object",
  additionalProperties: false,
  required: ["profile", "target"],
  properties: {
    profile: embeddedCliProfileSchema,
    target: embeddedSessionTargetSchema,
    displayName: { type: "string", minLength: 1 },
    labels: labelsSchema,
    resourceLimits: embeddedResourceLimitsSchema,
    requiredCapabilities: {
      type: "array",
      items: embeddedCapabilitySchema,
      uniqueItems: true,
    },
    metadata: metadataSchema,
    credentials: embeddedSessionCredentialsSchema,
    workspaceSync: {
      type: "boolean",
      description:
        "When true, the session-agent fetches a workspace archive (uploaded via POST /sessions/:id/workspace) and extracts it into /workspace before starting the CLI.",
    },
    workspaceExport: {
      type: "boolean",
      description:
        "When true, the session-agent tars /workspace and POSTs it to /sessions/:id/workspace/export on startup so the CLI can pull it (used by `remote workspace pull`).",
    },
    workspaceId: {
      type: "string",
      minLength: 1,
      description:
        "Bind the session to a persistent Workspace; its retained PVC is mounted at /workspace instead of a per-session volume.",
    },
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
