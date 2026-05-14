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

export const riskSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/approval-risk.schema.json`,
  title: "ApprovalRisk",
  type: "string",
  enum: ["low", "medium", "high", "critical"],
} as const;

export const approvalDecisionSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/approval-decision.schema.json`,
  title: "ApprovalDecision",
  type: "string",
  enum: ["approved", "denied", "expired", "cancelled"],
} as const;

const embeddedRiskSchema = stripSchemaIds(riskSchema);
const embeddedApprovalDecisionSchema = stripSchemaIds(approvalDecisionSchema);

export const approvalRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/approval-request.schema.json`,
  title: "ApprovalRequest",
  type: "object",
  additionalProperties: false,
  required: [
    "approvalRequestId",
    "sessionId",
    "capability",
    "risk",
    "reason",
    "requestedBy",
    "requestedAt",
    "expiresAt",
    "subject",
    "proposedAction",
    "context",
  ],
  properties: {
    approvalRequestId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    capability: embeddedCapabilitySchema,
    risk: embeddedRiskSchema,
    reason: { type: "string", minLength: 1 },
    requestedBy: embeddedActorSchema,
    requestedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    subject: { type: "string", minLength: 1 },
    proposedAction: { type: "string", minLength: 1 },
    context: metadataSchema,
  },
} as const;

export const approvalDecisionRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/approval-decision-request.schema.json`,
  title: "ApprovalDecisionRequest",
  type: "object",
  additionalProperties: false,
  required: ["approvalRequestId", "decision"],
  properties: {
    approvalRequestId: { type: "string", minLength: 1 },
    decision: embeddedApprovalDecisionSchema,
    comment: { type: "string" },
    grant: metadataSchema,
  },
} as const;

export const approvalDecisionResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/approval-decision-response.schema.json`,
  title: "ApprovalDecisionResponse",
  type: "object",
  additionalProperties: false,
  required: ["approvalRequestId", "decision", "decidedAt"],
  properties: {
    approvalRequestId: { type: "string", minLength: 1 },
    decision: embeddedApprovalDecisionSchema,
    decidedAt: isoDateTimeSchema,
    comment: { type: "string" },
    grant: metadataSchema,
  },
} as const;
