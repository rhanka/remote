import { REMOTE_PROTOCOL_VERSION, REMOTE_SCHEMA_VERSION } from "./constants.js";
import type { RemoteEventEnvelope } from "./types.js";

const baseEvent = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  schemaVersion: REMOTE_SCHEMA_VERSION,
  sessionId: "session_001",
  occurredAt: "2026-05-11T12:00:00.000Z",
  correlationId: "corr_001",
  actor: {
    id: "control-plane",
    kind: "control-plane",
  },
} as const;

export const sessionDescriptorExample = {
  id: "session_001",
  profile: "codex",
  target: "k3s",
  workspacePath: "/workspace",
  createdAt: "2026-05-11T12:00:00.000Z",
  createdBy: {
    id: "user_001",
    kind: "user",
    displayName: "Antoine",
  },
  requiredCapabilities: ["read-secret", "browser-login"],
} as const;

export const sessionLifecycleChangedEventExample = {
  ...baseEvent,
  eventId: "event_001",
  sequence: 1,
  type: "session.lifecycle.changed",
  payload: {
    previousState: "provisioning",
    nextState: "ready",
  },
} satisfies RemoteEventEnvelope;

export const approvalRequestedEventExample = {
  ...baseEvent,
  eventId: "event_002",
  sequence: 2,
  type: "approval.requested",
  payload: {
    approvalRequestId: "approval_001",
    sessionId: "session_001",
    capability: "publish-npm",
    risk: "high",
    reason: "Publish package after tests pass",
    requestedBy: {
      id: "agent_001",
      kind: "session-agent",
    },
    requestedAt: "2026-05-11T12:00:00.000Z",
    expiresAt: "2026-05-11T12:05:00.000Z",
    subject: "npm publish",
    proposedAction: "npm publish --access public",
    context: { packageName: "@remote-controle/protocol" },
  },
} satisfies RemoteEventEnvelope;

export const terminalOutputEventExample = {
  ...baseEvent,
  eventId: "event_003",
  sequence: 3,
  type: "terminal.output",
  payload: {
    terminalId: "term_001",
    stream: "stdout",
    data: "$ npm test\n",
    encoding: "utf8",
  },
} satisfies RemoteEventEnvelope;

export const browserTwoFactorRequestedEventExample = {
  ...baseEvent,
  eventId: "event_004",
  sequence: 4,
  type: "browser.2fa.requested",
  payload: {
    pageId: "page_001",
    url: "https://github.com/login",
    challengeId: "challenge_001",
    method: "totp",
    requestedAt: "2026-05-11T12:00:00.000Z",
    expiresAt: "2026-05-11T12:02:00.000Z",
  },
} satisfies RemoteEventEnvelope;

export const uatRouteCreatedEventExample = {
  ...baseEvent,
  eventId: "event_005",
  sequence: 5,
  type: "uat.route.created",
  payload: {
    routeId: "uat_001",
    url: "https://uat.example.invalid/session_001",
    port: 5173,
    expiresAt: "2026-05-11T13:00:00.000Z",
    exposurePolicy: "operator-only",
  },
} satisfies RemoteEventEnvelope;
