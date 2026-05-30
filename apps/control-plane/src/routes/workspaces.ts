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
  StubTenantProvisioner,
  type TenantProvisioner,
} from "../tenancy/tenant-provisioner.js";
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
  readonly tenantProvisioner?: TenantProvisioner;
};

export function createWorkspacesRouter(
  deps: WorkspacesRouterDeps,
): Hono<{ Variables: ValidationVars }> {
  const ajv = deps.ajv;
  const provisioner = deps.provisioner;
  const store = deps.store ?? new Map<string, WorkspaceDescriptor>();
  const tenantProvisioner = deps.tenantProvisioner ?? new StubTenantProvisioner();
  const router = new Hono<{ Variables: ValidationVars }>();

  // Workspace ownership: the authenticated user who created it. A workspace
  // owned by another user is invisible (404) to everyone else.
  const owners = new Map<string, string>();
  const ownsWorkspace = (id: string, userId: string): boolean =>
    store.has(id) && owners.get(id) === userId;

  // Tenant namespace captured at create time so destroyWorkspace targets the
  // right per-tenant namespace (not the control-plane default namespace).
  const workspaceNamespace = new Map<string, string>();

  // Advisory soft-lock per workspace. Authority lives here (reachable by the
  // local CLI and remote Pods); auto-expires at TTL.
  type Lock = { holder: string; acquiredAt: string; expiresAt: number };
  const locks = new Map<string, Lock>();
  const activeLock = (id: string): Lock | undefined => {
    const lock = locks.get(id);
    if (!lock) return undefined;
    if (lock.expiresAt <= Date.now()) {
      locks.delete(id);
      return undefined;
    }
    return lock;
  };

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

      const { userId } = c.var.auth!;
      const { namespace } = await tenantProvisioner.ensureTenant(userId);
      await provisioner.provisionWorkspace?.(descriptor.id, namespace);
      store.set(descriptor.id, descriptor);
      owners.set(descriptor.id, userId);
      workspaceNamespace.set(descriptor.id, namespace);
      const response: CreateWorkspaceResponse = { workspace: descriptor };
      return c.json(response, 201);
    },
  );

  router.get("/", (c) => {
    // Augment each workspace with its live lock (informational; the strict
    // ListWorkspacesResponse type carries only the descriptors). Only the
    // authenticated user's workspaces are listed.
    const userId = c.var.auth!.userId;
    const workspaces = [...store.values()]
      .filter((w) => owners.get(w.id) === userId)
      .map((w) => {
        const lock = activeLock(w.id);
        return lock
          ? { ...w, lock: { holder: lock.holder, acquiredAt: lock.acquiredAt } }
          : w;
      });
    return c.json({ workspaces } as unknown as ListWorkspacesResponse);
  });

  router.get("/:id", (c) => {
    const id = c.req.param("id");
    if (!ownsWorkspace(id, c.var.auth!.userId)) return notFound(c);
    const workspace = store.get(id);
    if (!workspace) return notFound(c);
    const lock = activeLock(workspace.id);
    const response: GetWorkspaceResponse = { workspace };
    return c.json(
      lock
        ? { ...response, lock: { holder: lock.holder, acquiredAt: lock.acquiredAt } }
        : response,
    );
  });

  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!ownsWorkspace(id, c.var.auth!.userId)) return notFound(c);
    const ns = workspaceNamespace.get(id);
    store.delete(id);
    owners.delete(id);
    locks.delete(id);
    workspaceNamespace.delete(id);
    await provisioner.destroyWorkspace?.(id, ns);
    const response: DeleteWorkspaceResponse = {
      workspaceId: id,
      accepted: true,
    };
    return c.json(response);
  });

  router.post("/:id/lock", async (c) => {
    const id = c.req.param("id");
    if (!ownsWorkspace(id, c.var.auth!.userId)) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      holder?: string;
      ttlSeconds?: number;
    };
    const holder = body.holder ?? "unknown";
    const ttl = Math.min(Math.max(body.ttlSeconds ?? 300, 1), 3600);
    const current = activeLock(id);
    if (current && current.holder !== holder) {
      return c.json(
        {
          code: "workspace.locked",
          message: `Workspace held by ${current.holder} since ${current.acquiredAt}`,
          retryable: true,
          holder: current.holder,
          acquiredAt: current.acquiredAt,
        },
        409,
      );
    }
    const lock: Lock = {
      holder,
      acquiredAt: current?.acquiredAt ?? new Date().toISOString(),
      expiresAt: Date.now() + ttl * 1000,
    };
    locks.set(id, lock);
    return c.json({
      workspaceId: id,
      holder: lock.holder,
      acquiredAt: lock.acquiredAt,
      accepted: true,
    });
  });

  router.delete("/:id/lock", (c) => {
    const id = c.req.param("id");
    if (!ownsWorkspace(id, c.var.auth!.userId)) return notFound(c);
    locks.delete(id);
    return c.json({ workspaceId: id, released: true });
  });

  return router;
}
