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
import type { SessionDescriptor } from "@sentropic/remote-protocol";
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
  /** Session registry (structural slice of SessionStore): the GC keep-list is
   * derived from EVERY session it knows — live or not — plus every registered
   * workspace. Without it, GC keep falls back to registered workspaces only. */
  readonly sessionStore?: {
    list(userId?: string): ReadonlyArray<SessionDescriptor>;
  };
};

export function createWorkspacesRouter(
  deps: WorkspacesRouterDeps,
): Hono<{ Variables: ValidationVars }> {
  const ajv = deps.ajv;
  const provisioner = deps.provisioner;
  const store = deps.store ?? new Map<string, WorkspaceDescriptor>();
  const tenantProvisioner = deps.tenantProvisioner ?? new StubTenantProvisioner();
  const sessionStore = deps.sessionStore;
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

  // EXPLICIT GC of stale subdirectories on the shared workspaces volume.
  // Registered BEFORE the `/:id` routes so the static path wins unambiguously.
  //
  // Safety semantics (the volume holds claude .jsonl conversations):
  // - keep = workspaceIds of EVERY session known to the session store (live or
  //   not, any owner — a superset is always safer) UNION every workspace
  //   currently registered here. The keep-list is re-checked inside the
  //   janitor pod itself, so it holds even against a stale dry-run.
  // - dry-run by default: apply must be EXPLICITLY true.
  // - apply archives each candidate to on-volume .trash/ BEFORE deleting.
  router.post("/gc", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      olderThanDays?: unknown;
      apply?: unknown;
    };
    // Strict validation, no silent coercion: a malformed retention window must
    // never widen the GC scope by accident.
    let olderThanDays = 30;
    if (body.olderThanDays !== undefined) {
      if (
        typeof body.olderThanDays !== "number" ||
        !Number.isInteger(body.olderThanDays) ||
        body.olderThanDays < 1
      ) {
        return c.json(
          {
            code: "workspace.gc_invalid_request",
            message: "olderThanDays must be an integer >= 1",
            retryable: false,
          },
          400,
        );
      }
      olderThanDays = body.olderThanDays;
    }
    if (body.apply !== undefined && typeof body.apply !== "boolean") {
      return c.json(
        {
          code: "workspace.gc_invalid_request",
          message: "apply must be a boolean",
          retryable: false,
        },
        400,
      );
    }
    const apply = body.apply === true;

    if (typeof provisioner.gcWorkspaces !== "function") {
      return c.json(
        {
          code: "workspace.gc_unsupported",
          message:
            "This control-plane's provisioner does not support shared-volume workspace GC",
          retryable: false,
        },
        501,
      );
    }

    const { userId } = c.var.auth!;
    const { namespace } = await tenantProvisioner.ensureTenant(userId);

    const keep = new Set<string>(store.keys());
    for (const session of sessionStore?.list() ?? []) {
      if (session.workspaceId) keep.add(session.workspaceId);
    }
    // The janitor must co-locate with THIS tenant's session pods when any are
    // running (their node is the only one guaranteed to mount this volume) —
    // other tenants' pods live in other namespaces with other volumes.
    const hasLiveSessions = (sessionStore?.list(userId) ?? []).length > 0;

    try {
      const report = await provisioner.gcWorkspaces({
        olderThanDays,
        apply,
        keep: [...keep],
        namespace,
        hasLiveSessions,
      });
      return c.json({
        candidates: report.candidates,
        applied: report.applied,
        ...(report.failed.length > 0 ? { failed: report.failed } : {}),
      });
    } catch (error) {
      return c.json(
        {
          code: "workspace.gc_failed",
          message: String((error as Error).message ?? error),
          retryable: true,
        },
        502,
      );
    }
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
