import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import { isoDateTimeSchema, metadataSchema } from "./common.js";

export const browserTransportSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/browser-transport.schema.json`,
  title: "BrowserTransport",
  type: "string",
  enum: ["webrtc", "websocket", "novnc", "playwright-control"],
} as const;

export const browserTwoFactorMethodSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/browser-two-factor-method.schema.json`,
  title: "BrowserTwoFactorMethod",
  type: "string",
  enum: ["totp", "sms", "email", "webauthn", "unknown"],
} as const;

export const browserUserTakeoverStateSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/browser-user-takeover-state.schema.json`,
  title: "BrowserUserTakeoverState",
  type: "string",
  enum: ["requested", "active", "released", "expired"],
} as const;

export const uatExposurePolicySchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/uat-exposure-policy.schema.json`,
  title: "UatExposurePolicy",
  type: "string",
  enum: ["operator-only", "session-private", "public-expiring"],
} as const;

const { $id: _browserTransportSchemaId, ...embeddedBrowserTransportSchema } =
  browserTransportSchema;
const {
  $id: _browserTwoFactorMethodSchemaId,
  ...embeddedBrowserTwoFactorMethodSchema
} = browserTwoFactorMethodSchema;
const {
  $id: _browserUserTakeoverStateSchemaId,
  ...embeddedBrowserUserTakeoverStateSchema
} = browserUserTakeoverStateSchema;
const { $id: _uatExposurePolicySchemaId, ...embeddedUatExposurePolicySchema } =
  uatExposurePolicySchema;

export const browserStartedSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/browser-started.schema.json`,
  title: "BrowserStarted",
  type: "object",
  additionalProperties: false,
  required: ["browserId", "transport"],
  properties: {
    browserId: { type: "string", minLength: 1 },
    transport: embeddedBrowserTransportSchema,
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
    method: embeddedBrowserTwoFactorMethodSchema,
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
    state: embeddedBrowserUserTakeoverStateSchema,
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
    exposurePolicy: embeddedUatExposurePolicySchema,
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
