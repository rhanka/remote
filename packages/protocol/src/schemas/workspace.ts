import { REMOTE_SCHEMA_BASE_URL } from "../constants.js";
import {
  actorSchema,
  isoDateTimeSchema,
  labelsSchema,
  stripSchemaIds,
} from "./common.js";

const embeddedActorSchema = stripSchemaIds(actorSchema);

export const workspaceDescriptorSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/workspace-descriptor.schema.json`,
  title: "WorkspaceDescriptor",
  type: "object",
  additionalProperties: false,
  required: ["id", "createdAt", "createdBy"],
  properties: {
    id: { type: "string", minLength: 1 },
    createdAt: isoDateTimeSchema,
    createdBy: embeddedActorSchema,
    displayName: { type: "string", minLength: 1 },
    labels: labelsSchema,
  },
} as const;

const embeddedWorkspaceDescriptorSchema = stripSchemaIds(
  workspaceDescriptorSchema,
);

export const createWorkspaceRequestSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/create-workspace-request.schema.json`,
  title: "CreateWorkspaceRequest",
  type: "object",
  additionalProperties: false,
  properties: {
    displayName: { type: "string", minLength: 1 },
    labels: labelsSchema,
  },
} as const;

export const createWorkspaceResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/create-workspace-response.schema.json`,
  title: "CreateWorkspaceResponse",
  type: "object",
  additionalProperties: false,
  required: ["workspace"],
  properties: {
    workspace: embeddedWorkspaceDescriptorSchema,
  },
} as const;

export const listWorkspacesResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/list-workspaces-response.schema.json`,
  title: "ListWorkspacesResponse",
  type: "object",
  additionalProperties: false,
  required: ["workspaces"],
  properties: {
    workspaces: {
      type: "array",
      items: embeddedWorkspaceDescriptorSchema,
    },
  },
} as const;

export const getWorkspaceResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/get-workspace-response.schema.json`,
  title: "GetWorkspaceResponse",
  type: "object",
  additionalProperties: false,
  required: ["workspace"],
  properties: {
    workspace: embeddedWorkspaceDescriptorSchema,
  },
} as const;

export const deleteWorkspaceResponseSchema = {
  $id: `${REMOTE_SCHEMA_BASE_URL}/delete-workspace-response.schema.json`,
  title: "DeleteWorkspaceResponse",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "accepted"],
  properties: {
    workspaceId: { type: "string", minLength: 1 },
    accepted: { type: "boolean" },
  },
} as const;
