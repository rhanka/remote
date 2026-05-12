import type { FromSchema } from "json-schema-to-ts";
import type { actorSchema } from "./schemas/common.js";
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
