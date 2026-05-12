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
