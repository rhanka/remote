import {
  createWorkspaceRequestSchema,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResponse,
  type DeleteWorkspaceResponse,
  type GetWorkspaceResponse,
  type ListWorkspacesResponse,
  type WorkspaceDescriptor,
} from "@sentropic/remote-protocol";
import type { SessionProvisioner } from "@sentropic/remote-k8s-orchestrator";
import type { Ajv } from "ajv";
import { Hono } from "hono";

import {
  type ValidationVars,
  validateJsonBody,
  validatedBody,
} from "../validation.js";

let counter = 0;
function workspaceId(): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `ws-${rand}${counter.toString(36)}`;
}

export type WorkspacesRouterDeps = {
  readonly ajv: Ajv;
  readonly provisioner: SessionProvisioner;
  readonly store?: Map<string, WorkspaceDescriptor>;
};

export function createWorkspacesRouter(
  deps: WorkspacesRouterDeps,
): Hono<{ Variables: ValidationVars }> {
  const ajv = deps.ajv;
  const provisioner = deps.provisioner;
  const store = deps.store ?? new Map<string, WorkspaceDescriptor>();
  const router = new Hono<{ Variables: ValidationVars }>();

  const notFound = (c: {
    json: (body: unknown, status: number) => Response;
  }) =>
    c.json(
      {
        code: "workspace.not_found",
        message: "Workspace not found",
        retryable: false,
      },
      404,
    );

  router.post(
    "/",
    validateJsonBody(ajv, createWorkspaceRequestSchema),
    async (c) => {
      const req = validatedBody<CreateWorkspaceRequest>(c);
      const descriptor: WorkspaceDescriptor = {
        id: workspaceId(),
        createdAt: new Date().toISOString(),
        createdBy: {
          id: "control-plane",
          kind: "control-plane",
          displayName: "Control Plane",
        },
      };
      if (req.displayName !== undefined)
        descriptor.displayName = req.displayName;
      if (req.labels !== undefined) descriptor.labels = req.labels;

      await provisioner.provisionWorkspace?.(descriptor.id);
      store.set(descriptor.id, descriptor);
      const response: CreateWorkspaceResponse = { workspace: descriptor };
      return c.json(response, 201);
    },
  );

  router.get("/", (c) => {
    const response: ListWorkspacesResponse = {
      workspaces: [...store.values()],
    };
    return c.json(response);
  });

  router.get("/:id", (c) => {
    const workspace = store.get(c.req.param("id"));
    if (!workspace) return notFound(c);
    const response: GetWorkspaceResponse = { workspace };
    return c.json(response);
  });

  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return notFound(c);
    store.delete(id);
    await provisioner.destroyWorkspace?.(id);
    const response: DeleteWorkspaceResponse = {
      workspaceId: id,
      accepted: true,
    };
    return c.json(response);
  });

  return router;
}
