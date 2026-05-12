import { EVENT_TYPES, REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import {
  actorSchema,
  isoDateTimeSchema,
  metadataSchema,
  protocolEnvelopeProperties,
} from "./common.js";

const { $id: _actorSchemaId, ...embeddedActorSchema } = actorSchema;

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
} as const;
