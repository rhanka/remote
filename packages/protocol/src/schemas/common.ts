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

export type StripSchemaIds<T> = T extends readonly unknown[]
  ? { readonly [Index in keyof T]: StripSchemaIds<T[Index]> }
  : T extends object
    ? {
        readonly [Key in keyof T as Key extends "$id"
          ? never
          : Key]: StripSchemaIds<T[Key]>;
      }
    : T;

export const stripSchemaIds = <T>(schema: T): StripSchemaIds<T> => {
  if (Array.isArray(schema)) {
    return schema.map((item) => stripSchemaIds(item)) as StripSchemaIds<T>;
  }

  if (schema !== null && typeof schema === "object") {
    const stripped: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(schema)) {
      if (key === "$id") {
        continue;
      }

      stripped[key] = stripSchemaIds(value);
    }

    return stripped as StripSchemaIds<T>;
  }

  return schema as StripSchemaIds<T>;
};

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
  $id: `${REMOTE_SCHEMA_BASE_URL}/resource-limits.schema.json`,
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
  $id: `${REMOTE_SCHEMA_BASE_URL}/cli-profile.schema.json`,
  title: "CliProfile",
  type: "string",
  enum: CLI_PROFILES,
} as const;

export const capabilitySchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/capability.schema.json`,
  title: "Capability",
  type: "string",
  enum: CAPABILITIES,
} as const;

export const sessionTargetSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/session-target.schema.json`,
  title: "SessionTarget",
  type: "string",
  enum: SESSION_TARGETS,
} as const;

export const sessionLifecycleStateSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/session-lifecycle-state.schema.json`,
  title: "SessionLifecycleState",
  type: "string",
  enum: SESSION_LIFECYCLE_STATES,
} as const;
