import type { FromSchema } from "json-schema-to-ts";
import type {
  EVENT_TYPES,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEMA_VERSION,
} from "./constants.js";
import type {
  approvalDecisionRequestSchema,
  approvalDecisionResponseSchema,
  approvalRequestSchema,
} from "./schemas/approvals.js";
import type {
  browserNavigatedSchema,
  browserSensitiveActionRequestSchema,
  browserStartedSchema,
  browserTwoFactorRequestSchema,
  browserUserTakeoverChangedSchema,
  browserUserTakeoverRequestSchema,
  uatRouteCreatedSchema,
  uatRouteExpiredSchema,
} from "./schemas/browser.js";
import type { actorSchema } from "./schemas/common.js";
import type { remoteErrorSchema } from "./schemas/errors.js";
import type {
  auditRecordedPayloadSchema,
  secretRevokedPayloadSchema,
  sessionHealthReportedPayloadSchema,
  sessionInstructionCompletedPayloadSchema,
  sessionInstructionReceivedPayloadSchema,
  sessionLifecycleChangedPayloadSchema,
} from "./schemas/events.js";
import type {
  secretGrantResponseSchema,
  secretRequestSchema,
} from "./schemas/secrets.js";
import type {
  createSessionRequestSchema,
  createSessionResponseSchema,
  refreshSessionCredentialsRequestSchema,
  refreshSessionCredentialsResponseSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
  sessionCredentialsSchema,
  sendInstructionRequestSchema,
  sendInstructionResponseSchema,
  sessionDescriptorSchema,
  stopSessionRequestSchema,
  stopSessionResponseSchema,
} from "./schemas/session.js";
import type {
  workspaceDescriptorSchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  listWorkspacesResponseSchema,
  getWorkspaceResponseSchema,
  deleteWorkspaceResponseSchema,
} from "./schemas/workspace.js";
import type {
  terminalExitedSchema,
  terminalInputSchema,
  terminalOpenedSchema,
  terminalOutputSchema,
  terminalResizeSchema,
} from "./schemas/terminal.js";
import type { h2aBridgeProfileSchema } from "./schemas/h2a-bridge.js";

export type Actor = FromSchema<typeof actorSchema>;
export type H2AHostBridgeProfile = FromSchema<typeof h2aBridgeProfileSchema>;
export type WorkspaceDescriptor = FromSchema<typeof workspaceDescriptorSchema>;
export type CreateWorkspaceRequest = FromSchema<
  typeof createWorkspaceRequestSchema
>;
export type CreateWorkspaceResponse = FromSchema<
  typeof createWorkspaceResponseSchema
>;
export type ListWorkspacesResponse = FromSchema<
  typeof listWorkspacesResponseSchema
>;
export type GetWorkspaceResponse = FromSchema<
  typeof getWorkspaceResponseSchema
>;
export type DeleteWorkspaceResponse = FromSchema<
  typeof deleteWorkspaceResponseSchema
>;
export type SessionDescriptor = FromSchema<typeof sessionDescriptorSchema>;
export type SessionCredentials = FromSchema<typeof sessionCredentialsSchema>;
export type RefreshSessionCredentialsRequest = FromSchema<
  typeof refreshSessionCredentialsRequestSchema
>;
export type RefreshSessionCredentialsResponse = FromSchema<
  typeof refreshSessionCredentialsResponseSchema
>;
export type CreateSessionRequest = FromSchema<
  typeof createSessionRequestSchema
>;
export type CreateSessionResponse = FromSchema<
  typeof createSessionResponseSchema
>;
export type ListSessionsResponse = FromSchema<
  typeof listSessionsResponseSchema
>;
export type GetSessionResponse = FromSchema<typeof getSessionResponseSchema>;
export type StopSessionRequest = FromSchema<typeof stopSessionRequestSchema>;
export type StopSessionResponse = FromSchema<typeof stopSessionResponseSchema>;
export type SendInstructionRequest = FromSchema<
  typeof sendInstructionRequestSchema
>;
export type SendInstructionResponse = FromSchema<
  typeof sendInstructionResponseSchema
>;
export type ApprovalRequest = FromSchema<typeof approvalRequestSchema>;
export type ApprovalDecisionRequest = FromSchema<
  typeof approvalDecisionRequestSchema
>;
export type ApprovalDecisionResponse = FromSchema<
  typeof approvalDecisionResponseSchema
>;
export type SecretRequest = FromSchema<typeof secretRequestSchema>;
export type SecretGrantResponse = FromSchema<typeof secretGrantResponseSchema>;
export type RemoteError = FromSchema<typeof remoteErrorSchema>;
export type TerminalOpened = FromSchema<typeof terminalOpenedSchema>;
export type TerminalInput = FromSchema<typeof terminalInputSchema>;
export type TerminalOutput = FromSchema<typeof terminalOutputSchema>;
export type TerminalResize = FromSchema<typeof terminalResizeSchema>;
export type TerminalExited = FromSchema<typeof terminalExitedSchema>;
export type BrowserStarted = FromSchema<typeof browserStartedSchema>;
export type BrowserNavigated = FromSchema<typeof browserNavigatedSchema>;
export type BrowserTwoFactorRequest = FromSchema<
  typeof browserTwoFactorRequestSchema
>;
export type BrowserUserTakeoverRequest = FromSchema<
  typeof browserUserTakeoverRequestSchema
>;
export type BrowserUserTakeoverChanged = FromSchema<
  typeof browserUserTakeoverChangedSchema
>;
export type BrowserSensitiveActionRequest = FromSchema<
  typeof browserSensitiveActionRequestSchema
>;
export type UatRouteCreated = FromSchema<typeof uatRouteCreatedSchema>;
export type UatRouteExpired = FromSchema<typeof uatRouteExpiredSchema>;
export type SessionLifecycleChangedPayload = FromSchema<
  typeof sessionLifecycleChangedPayloadSchema
>;
export type SessionHealthReportedPayload = FromSchema<
  typeof sessionHealthReportedPayloadSchema
>;
export type SessionInstructionReceivedPayload = FromSchema<
  typeof sessionInstructionReceivedPayloadSchema
>;
export type SessionInstructionCompletedPayload = FromSchema<
  typeof sessionInstructionCompletedPayloadSchema
>;
export type SecretRevokedPayload = FromSchema<
  typeof secretRevokedPayloadSchema
>;
export type AuditRecordedPayload = FromSchema<
  typeof auditRecordedPayloadSchema
>;
export type RemoteEventEnvelope = {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  schemaVersion: typeof REMOTE_SCHEMA_VERSION;
  eventId: string;
  sessionId: string;
  sequence: number;
  type: (typeof EVENT_TYPES)[number];
  occurredAt: string;
  correlationId: string;
  actor: Actor;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};
