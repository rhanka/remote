import type { FromSchema } from "json-schema-to-ts";
import type {
  approvalDecisionRequestSchema,
  approvalDecisionResponseSchema,
  approvalRequestSchema,
} from "./schemas/approvals.js";
import type { actorSchema } from "./schemas/common.js";
import type { remoteErrorSchema } from "./schemas/errors.js";
import type {
  secretGrantResponseSchema,
  secretRequestSchema,
} from "./schemas/secrets.js";
import type {
  createSessionRequestSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
  sendInstructionRequestSchema,
  sendInstructionResponseSchema,
  sessionDescriptorSchema,
  stopSessionRequestSchema,
  stopSessionResponseSchema,
} from "./schemas/session.js";

export type Actor = FromSchema<typeof actorSchema>;
export type SessionDescriptor = FromSchema<typeof sessionDescriptorSchema>;
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
