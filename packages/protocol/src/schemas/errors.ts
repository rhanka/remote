import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import { metadataSchema } from "./common.js";

export const remoteErrorCodeSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/remote-error-code.schema.json`,
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

const { $id: _remoteErrorCodeSchemaId, ...embeddedRemoteErrorCodeSchema } =
  remoteErrorCodeSchema;

export const remoteErrorSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/remote-error.schema.json`,
  title: "RemoteError",
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "retryable"],
  properties: {
    code: embeddedRemoteErrorCodeSchema,
    message: { type: "string", minLength: 1 },
    retryable: { type: "boolean" },
    correlationId: { type: "string", minLength: 1 },
    details: metadataSchema,
  },
} as const;
