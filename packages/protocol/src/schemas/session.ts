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
    workspacePath: {
      type: "string",
      minLength: 1,
      pattern: "^/",
      description:
        "Absolute path where the workspace is mounted inside the session Pod. Defaults to /workspace, but a migrated session sets it to the user's real local project path (e.g. /home/user/src/proj) for path parity, so the resumed conversation's absolute paths resolve.",
    },
    home: {
      type: "string",
      minLength: 1,
      pattern: "^/",
      description:
        "Absolute HOME to reproduce inside the Pod (e.g. /home/user) for environment parity with the user's local machine. Defaults to /root when absent.",
    },
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
    workspacePath: {
      type: "string",
      minLength: 1,
      pattern: "^/",
      description:
        "Absolute path to mount the workspace at inside the Pod (path parity with the caller's local project path). Defaults to /workspace when absent.",
    },
    home: {
      type: "string",
      minLength: 1,
      pattern: "^/",
      description:
        "Absolute HOME to reproduce inside the Pod (environment parity). Defaults to /root when absent.",
    },
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
    agentImage: {
      type: "string",
      minLength: 1,
      description:
        "Override the session-agent container image for this session. Useful when the task requires tools not present in the default session-agent image (e.g. GDAL, custom pipelines). Must be a fully-qualified image reference (registry/repo/name:tag). Falls back to SESSION_AGENT_IMAGE when absent.",
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

/**
 * Session announce payload — sent by the session-agent to the control-plane
 * on every (re)connect so the control-plane can repopulate its in-memory store
 * after a restart.
 *
 * Secret-free by design: no credentials, tokens, or auth material are ever
 * included. Only public descriptor fields sourced from the agent's environment
 * variables (SESSION_ID, SESSION_PROFILE, SESSION_TARGET, WORKSPACE_PATH,
 * SESSION_WORKSPACE_ID, HOME, SESSION_STARTUP_ARGS, SESSION_DISPLAY_NAME,
 * SESSION_LABELS, SESSION_RESOURCE_LIMITS) and the detected cliSessionId.
 *
 * Descriptor `metadata` is deliberately NOT announced: its only Pod-visible
 * subset is `metadata.startup.args`, already carried as `startupArgs` (the
 * control-plane maps it back to `metadata.startup.args`). The rest is
 * arbitrary caller payload the Pod never receives.
 */
export const sessionAnnounceSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/session-announce.schema.json`,
  title: "SessionAnnounce",
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "profile"],
  properties: {
    sessionId: { type: "string", minLength: 1 },
    profile: embeddedCliProfileSchema,
    target: embeddedSessionTargetSchema,
    workspacePath: { type: "string", minLength: 1 },
    workspaceId: { type: "string", minLength: 1 },
    cliSessionId: {
      type: "string",
      minLength: 1,
      description:
        "The wrapped CLI's own conversation/session id, if already detected at announce time.",
    },
    home: {
      type: "string",
      minLength: 1,
      pattern: "^/",
      description:
        "Absolute HOME inside the Pod (environment parity), sourced from the agent's HOME env var. Carried so a control-plane restarted from scratch rebuilds a descriptor whose refreshed Pod keeps the same HOME instead of falling back to /root.",
    },
    startupArgs: {
      type: "array",
      // No minLength on items: an empty-string arg (e.g. an empty -c payload)
      // is legal for the wrapped CLI and must not invalidate the whole
      // announce (which would leave the session unestablished after a
      // control-plane restart).
      items: { type: "string" },
      description:
        'Extra CLI args the Pod was started with (e.g. ["--resume", "<convId>"]), sourced from SESSION_STARTUP_ARGS. Carried so a post-restart refresh re-applies them and the resumed conversation is not lost.',
    },
    displayName: {
      type: "string",
      minLength: 1,
      description:
        "Human-readable session name, sourced from SESSION_DISPLAY_NAME. Carried so a control-plane restarted from scratch keeps the name in `remote ls`.",
    },
    labels: {
      ...labelsSchema,
      description:
        "User labels from the descriptor, sourced from SESSION_LABELS (JSON object of strings). Carried for post-restart store repopulation parity.",
    },
    resourceLimits: {
      ...embeddedResourceLimitsSchema,
      description:
        "Custom Pod resource limits, sourced from SESSION_RESOURCE_LIMITS (JSON {cpu?, memory?}). Carried so a post-restart `remote refresh` regenerates the Pod with the SAME limits instead of the defaults.",
    },
  },
} as const;
