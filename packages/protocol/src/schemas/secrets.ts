import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import {
  actorSchema,
  capabilitySchema,
  isoDateTimeSchema,
  metadataSchema,
  stripSchemaIds,
} from "./common.js";

const embeddedActorSchema = stripSchemaIds(actorSchema);
const embeddedCapabilitySchema = stripSchemaIds(capabilitySchema);

export const secretDeliverySchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/secret-delivery.schema.json`,
  title: "SecretDelivery",
  type: "string",
  enum: ["kubernetes-secret", "env", "file", "stdin", "browser-user-entry"],
} as const;

export const secretGrantStatusSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/secret-grant-status.schema.json`,
  title: "SecretGrantStatus",
  type: "string",
  enum: ["granted", "denied", "expired", "unavailable"],
} as const;

const embeddedSecretDeliverySchema = stripSchemaIds(secretDeliverySchema);
const embeddedSecretGrantStatusSchema = stripSchemaIds(secretGrantStatusSchema);

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
    capability: embeddedCapabilitySchema,
    purpose: { type: "string", minLength: 1 },
    requestedBy: embeddedActorSchema,
    requestedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    delivery: embeddedSecretDeliverySchema,
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
    status: embeddedSecretGrantStatusSchema,
    handle: { type: "string", minLength: 1 },
    expiresAt: isoDateTimeSchema,
    redactedPreview: { type: "string" },
    metadata: metadataSchema,
  },
} as const;
