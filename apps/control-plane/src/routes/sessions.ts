import {
  InMemoryProvisioner,
  type ProvisionerEmit,
  type SessionProvisioner,
} from "@sentropic/remote-k8s-orchestrator";
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SCHEMA_VERSION,
  createSessionRequestSchema,
  refreshSessionCredentialsRequestSchema,
  sendInstructionRequestSchema,
  stopSessionRequestSchema,
  terminalInputSchema,
  terminalResizeSchema,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type RefreshSessionCredentialsRequest,
  type RefreshSessionCredentialsResponse,
  type GetSessionResponse,
  type ListSessionsResponse,
  type RemoteEventEnvelope,
  type SendInstructionRequest,
  type SendInstructionResponse,
  type SessionAnnounce,
  type SessionDescriptor,
  type StopSessionRequest,
  type StopSessionResponse,
} from "@sentropic/remote-protocol";
import type { Ajv } from "ajv";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { AgentRegistry } from "../agents/registry.js";
import { SessionEventBus } from "../sessions/events.js";
import { descriptorWithFreshResume } from "../sessions/resume-args.js";
import { SessionStore } from "../sessions/store.js";
import {
  authEnabled,
  mintSessionToken,
  sessionTokenSecret,
} from "../auth/session-token.js";
import { tenantNamespace } from "../tenancy/namespace.js";
import {
  StubTenantProvisioner,
  type TenantProvisioner,
} from "../tenancy/tenant-provisioner.js";
import { ArchiveStaging } from "../archive-staging.js";
import { requireLeaseToken } from "../middleware/require-lease-token.js";
import {
  type ValidationVars,
  validateJsonBody,
  validatedBody,
} from "../validation.js";

function randomId(prefix: string): string {
  const random = Math.floor(Math.random() * 1e12)
    .toString(36)
    .padStart(8, "0");
  return `${prefix}-${random}`;
}

function buildDescriptor(
  req: CreateSessionRequest & { workspaceId?: string },
): SessionDescriptor {
  const now = new Date().toISOString();
  const descriptor: SessionDescriptor = {
    id: randomId("sess"),
    profile: req.profile,
    target: req.target,
    workspacePath: req.workspacePath ?? "/workspace",
    createdAt: now,
    createdBy: {
      id: "control-plane",
      kind: "control-plane",
      displayName: "Control Plane",
    },
  };

  if (req.home !== undefined) descriptor.home = req.home;
  if (req.workspaceId !== undefined) descriptor.workspaceId = req.workspaceId;
  if (req.displayName !== undefined) descriptor.displayName = req.displayName;
  if (req.labels !== undefined) descriptor.labels = req.labels;
  if (req.resourceLimits !== undefined)
    descriptor.resourceLimits = req.resourceLimits;
  if (req.requiredCapabilities !== undefined)
    descriptor.requiredCapabilities = req.requiredCapabilities;
  if (req.metadata !== undefined) descriptor.metadata = req.metadata;

  return descriptor;
}

/**
 * Synthesize a SessionDescriptor from an agent's `session.announce` body.
 * Used after a control-plane restart: the agent is the durable record, so the
 * descriptor is reconstructed (createdBy = control-plane, createdAt = now) from
 * the announce's public fields. `target`/`workspacePath` are required on the
 * descriptor but optional on the announce — fall back to safe defaults.
 *
 * `home`, `startupArgs`, `displayName`, `labels` and `resourceLimits` map back
 * to the EXACT descriptor locations that `buildSessionPodSpec` reads
 * (descriptor.home → HOME env; descriptor.metadata.startup.args →
 * SESSION_STARTUP_ARGS env; descriptor.resourceLimits → container
 * resources/limits; descriptor.displayName/labels → SESSION_DISPLAY_NAME /
 * SESSION_LABELS env), so a post-restart `remote refresh` regenerates a Pod
 * with the same HOME parity, the same --resume args AND the same custom
 * limits instead of a fresh /root session on default resources.
 */
function descriptorFromAnnounce(announce: SessionAnnounce): SessionDescriptor {
  const now = new Date().toISOString();
  const descriptor: SessionDescriptor = {
    id: announce.sessionId,
    profile: announce.profile,
    target: announce.target ?? "k3s",
    workspacePath: announce.workspacePath ?? "/workspace",
    createdAt: now,
    createdBy: {
      id: "control-plane",
      kind: "control-plane",
      displayName: "Control Plane",
    },
  };
  if (announce.workspaceId !== undefined)
    descriptor.workspaceId = announce.workspaceId;
  if (announce.cliSessionId !== undefined)
    descriptor.cliSessionId = announce.cliSessionId;
  if (announce.home !== undefined) descriptor.home = announce.home;
  if (announce.startupArgs !== undefined && announce.startupArgs.length > 0)
    descriptor.metadata = { startup: { args: announce.startupArgs } };
  if (announce.displayName !== undefined)
    descriptor.displayName = announce.displayName;
  if (announce.labels !== undefined) descriptor.labels = announce.labels;
  if (announce.resourceLimits !== undefined)
    descriptor.resourceLimits = announce.resourceLimits;
  return descriptor;
}

/**
 * Repopulate the in-memory session record from an agent re-announce. Idempotent:
 * if the session is already known it is left untouched. Bound over the sessions
 * router's own `store` + `sessionTenant` so the announce path and the
 * create/stop paths share the exact same state (see createControlPlane wiring).
 */
export type ReconcileFromAnnounce = (
  sessionId: string,
  announce: SessionAnnounce,
  context: { userId: string },
) => SessionDescriptor;

export type SessionsRouter = {
  readonly router: Hono<{ Variables: ValidationVars }>;
  readonly reconcileFromAnnounce: ReconcileFromAnnounce;
};

function notFound(c: { json: (body: unknown, status: number) => Response }) {
  return c.json(
    {
      code: "session.not_found",
      message: "Session not found",
      retryable: false,
    },
    404,
  );
}

export type SessionsRouterDeps = {
  readonly ajv: Ajv;
  readonly store?: SessionStore;
  readonly bus?: SessionEventBus;
  readonly provisioner?: SessionProvisioner;
  readonly registry?: AgentRegistry;
  readonly tenantProvisioner?: TenantProvisioner;
  readonly archiveStaging?: ArchiveStaging;
  readonly exportStaging?: ArchiveStaging;
};

export function createSessionsRouter(deps: SessionsRouterDeps): SessionsRouter {
  const ajv = deps.ajv;
  const store = deps.store ?? new SessionStore();
  const bus = deps.bus ?? new SessionEventBus();
  const provisioner = deps.provisioner ?? new InMemoryProvisioner();
  const registry = deps.registry ?? new AgentRegistry();
  const tenantProvisioner =
    deps.tenantProvisioner ?? new StubTenantProvisioner();
  const archiveStaging =
    deps.archiveStaging ??
    new ArchiveStaging(process.env.DATA_DIR, "staging");
  const exportStaging =
    deps.exportStaging ??
    new ArchiveStaging(process.env.DATA_DIR, "staging-export");

  const router = new Hono<{ Variables: ValidationVars }>();

  // leaseRoot: the directory where lineage leases are stored.
  // Evaluated at request time so tests can set DATA_DIR.
  function leaseRoot(): string {
    return process.env.DATA_DIR ?? process.cwd();
  }

  // A per-session service token may act ONLY on the session it was minted for.
  // Returns true (caller should bail with notFound) when a session-bound token
  // is used against a different :id. A normal user/off-mode token has no
  // sessionId → always false → behavior unchanged.
  function sessionTokenMismatch(
    auth: { sessionId?: string },
    id: string,
  ): boolean {
    return auth.sessionId !== undefined && auth.sessionId !== id;
  }

  // Owner + tenant namespace captured at create time so the terminal.exited
  // cascade (which fires outside any request) can destroy in the right
  // namespace and delete from the right user partition.
  const sessionTenant = new Map<
    string,
    { userId: string; namespace: string }
  >();

  // Durability seam: an agent re-announce repopulates the store + sessionTenant
  // after a control-plane restart. Idempotent for an already-known session so a
  // steady-state (re)connect is a no-op. Shares this closure's `store` +
  // `sessionTenant` with the create/stop paths.
  const reconcileFromAnnounce: ReconcileFromAnnounce = (
    sessionId,
    announce,
    context,
  ) => {
    const existing = store.get(sessionId);
    if (existing) {
      const patch: Partial<SessionDescriptor> = {};
      // The agent re-detects its CLI's conversation id on every reconnect, so
      // a re-announce may carry a FRESHER cliSessionId than the record (the
      // conversation advanced or forked inside the Pod). Adopt it — the
      // refresh path substitutes it into the --resume args.
      if (
        announce.cliSessionId !== undefined &&
        announce.cliSessionId !== existing.cliSessionId
      ) {
        patch.cliSessionId = announce.cliSessionId;
      }
      // Conservative parity merge: the announce carries the Pod's
      // CREATION-time displayName/labels/resourceLimits, so it only FILLS
      // fields the record lacks — it never overwrites a richer existing
      // descriptor, and an announce that omits a field (old agent) never
      // erases one. Everything else AND the owner stay untouched (put without
      // userId preserves the existing owner: the agent WS auth may resolve to
      // "default").
      if (
        announce.displayName !== undefined &&
        existing.displayName === undefined
      )
        patch.displayName = announce.displayName;
      if (announce.labels !== undefined && existing.labels === undefined)
        patch.labels = announce.labels;
      if (
        announce.resourceLimits !== undefined &&
        existing.resourceLimits === undefined
      )
        patch.resourceLimits = announce.resourceLimits;
      if (Object.keys(patch).length === 0) return existing;
      return store.put({ ...existing, ...patch });
    }
    const descriptor = store.put(
      { ...descriptorFromAnnounce(announce), id: sessionId },
      context.userId,
    );
    sessionTenant.set(descriptor.id, {
      userId: context.userId,
      namespace: tenantNamespace(context.userId),
    });
    return descriptor;
  };

  const emit: ProvisionerEmit = (sessionId, type, payload) => {
    bus.publish(sessionId, type, payload);
  };

  const controlPlaneActor = {
    id: "control-plane",
    kind: "control-plane" as const,
    displayName: "Control Plane",
  };

  function buildTerminalInputEnvelope(
    sessionId: string,
    payload: Record<string, unknown>,
  ): RemoteEventEnvelope {
    return {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      schemaVersion: REMOTE_SCHEMA_VERSION,
      eventId: randomId("evt"),
      sessionId,
      sequence: 0,
      type: "terminal.input",
      occurredAt: new Date().toISOString(),
      correlationId: `op-${randomId("input")}`,
      actor: controlPlaneActor,
      payload,
    };
  }

  function buildTerminalResizeEnvelope(
    sessionId: string,
    payload: Record<string, unknown>,
  ): RemoteEventEnvelope {
    return {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      schemaVersion: REMOTE_SCHEMA_VERSION,
      eventId: randomId("evt"),
      sessionId,
      sequence: 0,
      type: "terminal.resized",
      occurredAt: new Date().toISOString(),
      correlationId: `op-${randomId("resize")}`,
      actor: controlPlaneActor,
      payload,
    };
  }

  function stopSessionInternal(
    id: string,
    reason: string | undefined,
    userId?: string,
  ): boolean {
    const tenant = sessionTenant.get(id);
    // Enforce ownership when a userId is supplied (request-scoped stop). The
    // terminal.exited cascade calls without one (system-scoped).
    if (userId !== undefined && tenant && tenant.userId !== userId)
      return false;
    if (!store.get(id, userId)) return false;
    store.delete(id, userId);
    sessionTenant.delete(id);
    archiveStaging.clearStagedArchive(id);
    exportStaging.clearStagedArchive(id);
    void provisioner
      .destroy(id, emit, tenant?.namespace)
      .catch((error: unknown) => {
        console.error(
          `[control-plane] session destroy failed (${reason ?? "unspecified"}):`,
          error,
        );
      })
      .finally(() => bus.forget(id));
    return true;
  }

  function watchForTerminalExited(sessionId: string): void {
    const unsubscribe = bus.subscribe(
      sessionId,
      (envelope) => {
        if (envelope.type !== "terminal.exited") return;
        unsubscribe();
        // Defer the destroy so the SSE subscribers see the exit event first.
        setImmediate(() => {
          if (!store.get(sessionId)) return;
          stopSessionInternal(sessionId, "terminal.exited");
        });
      },
      { replay: false },
    );
  }

  router.post(
    "/",
    validateJsonBody(ajv, createSessionRequestSchema),
    async (c) => {
      const req = validatedBody<
        CreateSessionRequest & {
          credentials?: Record<string, string>;
          workspaceSync?: boolean;
          workspaceExport?: boolean;
          workspaceId?: string;
        }
      >(c);
      const { userId } = c.var.auth!;
      const { namespace } = await tenantProvisioner.ensureTenant(userId);
      const descriptor = store.put(buildDescriptor(req), userId);
      sessionTenant.set(descriptor.id, { userId, namespace });
      bus.publish(descriptor.id, "session.lifecycle.changed", {
        nextState: "requested",
      });
      watchForTerminalExited(descriptor.id);
      const provisionOptions: {
        credentials?: Record<string, string>;
        workspaceSync?: boolean;
        workspaceExport?: boolean;
        namespace?: string;
        sessionToken?: string;
      } = { namespace };
      if (req.credentials) provisionOptions.credentials = req.credentials;
      if (req.workspaceSync) provisionOptions.workspaceSync = true;
      if (req.workspaceExport) provisionOptions.workspaceExport = true;
      // Under bearer auth, mint a per-session service token the agent uses to
      // authenticate its callbacks (workspace sync/export, cli-session). In
      // off-mode no secret/auth is set so nothing is minted or injected.
      const secret = sessionTokenSecret();
      if (authEnabled() && secret) {
        provisionOptions.sessionToken = await mintSessionToken({
          userId,
          sessionId: descriptor.id,
          secret,
        });
      }
      // A provisioning failure (k8s API error, e.g. quota exceeded) must NOT
      // crash the control-plane via an unhandled promise rejection — that would
      // take down every other session (the store is in-process). Catch it,
      // surface a `failed` lifecycle event, and clean up the orphaned record.
      void provisioner
        .provision(descriptor, emit, provisionOptions)
        .catch((error: unknown) => {
          console.error(
            `[control-plane] provision failed for ${descriptor.id}:`,
            error,
          );
          bus.publish(descriptor.id, "session.lifecycle.changed", {
            previousState: "requested",
            nextState: "failed",
          });
          stopSessionInternal(descriptor.id, "provision.failed");
        });
      const response: CreateSessionResponse = { session: descriptor };
      return c.json(response, 201);
    },
  );

  // Workspace archive staging: the CLI uploads a tar.gz of the cwd here after
  // session creation; the session-agent fetches it (with retry) on startup and
  // extracts it into /workspace. Held in memory, dropped on stop.
  router.post("/:id/workspace", requireLeaseToken(leaseRoot), async (c) => {
    const id = c.req.param("id");
    if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
    if (!store.get(id, c.var.auth!.userId)) return notFound(c);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength === 0) {
      return c.json(
        { code: "workspace.empty", message: "Empty archive", retryable: false },
        400,
      );
    }
    archiveStaging.stageArchive(id, Buffer.from(body));
    return c.json({ sessionId: id, bytes: body.byteLength, accepted: true });
  });

  router.get("/:id/workspace", (c) => {
    const id = c.req.param("id");
    if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
    if (!store.get(id, c.var.auth!.userId)) return notFound(c);
    const archive = archiveStaging.readStagedArchive(id);
    if (!archive) return notFound(c);
    return new Response(archive as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/gzip" },
    });
  });

  // Workspace export: the session-agent tars /workspace and POSTs it here; the
  // CLI (remote workspace pull) GETs it. Held in memory, dropped on stop.
  router.post("/:id/workspace/export", requireLeaseToken(leaseRoot), async (c) => {
    const id = c.req.param("id");
    if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
    if (!store.get(id, c.var.auth!.userId)) return notFound(c);
    const body = new Uint8Array(await c.req.arrayBuffer());
    exportStaging.stageArchive(id, Buffer.from(body));
    return c.json({ sessionId: id, bytes: body.byteLength, accepted: true });
  });

  router.get("/:id/workspace/export", (c) => {
    const id = c.req.param("id");
    if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
    if (!store.get(id, c.var.auth!.userId)) return notFound(c);
    const archive = exportStaging.readStagedArchive(id);
    if (!archive) return notFound(c);
    return new Response(archive as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/gzip" },
    });
  });

  // The session-agent reports the wrapped CLI's own conversation id once it
  // detects it (newest file in the profile's conversation dir).
  router.post("/:id/cli-session", async (c) => {
    const id = c.req.param("id");
    if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
    const userId = c.var.auth!.userId;
    const session = store.get(id, userId);
    if (!session) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      cliSessionId?: string;
    };
    if (typeof body.cliSessionId === "string" && body.cliSessionId.length > 0) {
      store.put({ ...session, cliSessionId: body.cliSessionId }, userId);
    }
    return c.json({ sessionId: id, accepted: true });
  });

  router.get("/", (c) => {
    const response: ListSessionsResponse = {
      sessions: store.list(c.var.auth!.userId),
    };
    return c.json(response);
  });

  router.get("/:id", (c) => {
    const id = c.req.param("id");
    if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
    const session = store.get(id, c.var.auth!.userId);
    if (!session) return notFound(c);
    const response: GetSessionResponse = { session };
    return c.json(response);
  });

  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
    const userId = c.var.auth!.userId;
    const session = store.get(id, userId);
    if (!session) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as {
      displayName?: string;
    };
    if (
      typeof body.displayName !== "string" ||
      body.displayName.trim() === ""
    ) {
      return c.json(
        { error: "displayName is required and must be non-empty" },
        400,
      );
    }
    const newDisplayName = body.displayName.trim();
    store.put({ ...session, displayName: newDisplayName }, userId);
    return c.json({
      sessionId: id,
      displayName: newDisplayName,
      accepted: true,
    });
  });

  router.post(
    "/:id/credentials",
    validateJsonBody(ajv, refreshSessionCredentialsRequestSchema),
    async (c) => {
      const id = c.req.param("id");
      if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
      const userId = c.var.auth!.userId;
      const stored = store.get(id, userId);
      if (!stored) return notFound(c);
      // Optional rename: a `?displayName=` query stamps the descriptor so the
      // recreated Pod gets SESSION_DISPLAY_NAME and `remote ls` shows the real
      // project name. Done here (not the JSON body, which is reserved for the
      // free-form credentials map). Applied BEFORE descriptorWithFreshResume so
      // it flows into the rebuilt descriptor regardless of the resume action.
      const renameTo = c.req.query("displayName")?.trim();
      const renamedBase: SessionDescriptor =
        renameTo !== undefined &&
        renameTo.length > 0 &&
        renameTo !== stored.displayName
          ? { ...stored, displayName: renameTo }
          : stored;
      const renamed = renamedBase !== stored;
      // A refresh regenerates the Pod from the descriptor, replaying its
      // startup args. Those args were captured at CREATION time; the
      // conversation may have advanced/forked since (the agent reports the
      // current cliSessionId). Rewrite the resume couple to the freshest known
      // id BEFORE the provisioner rebuilds the Pod, so the refreshed CLI
      // resumes where the user actually is — not the stale creation-time file.
      // Without a reported cliSessionId (old agent) this is a no-op.
      const fresh = descriptorWithFreshResume(renamedBase);
      const descriptor = fresh.descriptor;
      if (renamed) {
        console.log(`[control-plane] refresh ${id}: displayName → ${renameTo}`);
      }
      if (fresh.action !== "unchanged") {
        console.log(
          `[control-plane] refresh ${id}: resume arg ${fresh.action} → ${descriptor.cliSessionId}` +
            (fresh.previous !== undefined ? ` (was ${fresh.previous})` : ""),
        );
      }
      if (renamed || fresh.action !== "unchanged") {
        // Persist so the record matches the Pod actually running (and so a
        // later announce/refresh starts from the rewritten args + name).
        store.put(descriptor, userId);
      }
      const body = validatedBody<RefreshSessionCredentialsRequest>(c);
      const refreshOptions: {
        credentials: RefreshSessionCredentialsRequest;
        namespace?: string;
      } = { credentials: body };
      const namespace = sessionTenant.get(id)?.namespace;
      if (namespace !== undefined) refreshOptions.namespace = namespace;
      await provisioner.refresh(descriptor, emit, refreshOptions);
      const response: RefreshSessionCredentialsResponse = {
        sessionId: id,
        accepted: true,
      };
      return c.json(response);
    },
  );

  router.post(
    "/:id/stop",
    validateJsonBody(ajv, stopSessionRequestSchema),
    (c) => {
      const id = c.req.param("id");
      if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
      const req = validatedBody<StopSessionRequest>(c);
      const stopped = stopSessionInternal(id, req.reason, c.var.auth!.userId);
      if (!stopped) return notFound(c);
      const response: StopSessionResponse = { sessionId: id, accepted: true };
      return c.json(response);
    },
  );

  router.post(
    "/:id/instructions",
    validateJsonBody(ajv, sendInstructionRequestSchema),
    (c) => {
      const id = c.req.param("id");
      if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
      if (!store.get(id, c.var.auth!.userId)) return notFound(c);
      const req = validatedBody<SendInstructionRequest>(c);
      const instructionId = randomId("inst");
      const payload: Record<string, unknown> = {
        instructionId,
        instruction: req.instruction,
      };
      if (req.correlationId !== undefined)
        payload.correlationId = req.correlationId;
      if (req.metadata !== undefined) payload.metadata = req.metadata;
      bus.publish(id, "session.instruction.received", payload, {
        ...(req.correlationId !== undefined
          ? { correlationId: req.correlationId }
          : {}),
      });
      const response: SendInstructionResponse = {
        instructionId,
        accepted: true,
      };
      return c.json(response, 202);
    },
  );

  router.post(
    "/:id/terminal/input",
    validateJsonBody(ajv, terminalInputSchema),
    (c) => {
      const id = c.req.param("id");
      if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
      if (!store.get(id, c.var.auth!.userId)) return notFound(c);
      const body = validatedBody<Record<string, unknown>>(c);
      const envelope = buildTerminalInputEnvelope(id, body);
      const delivered = registry.send(id, envelope);
      if (!delivered) {
        return c.json(
          {
            code: "terminal.unavailable",
            message: "No session-agent connected",
            retryable: true,
          },
          503,
        );
      }
      return c.json({ accepted: true }, 202);
    },
  );

  router.post(
    "/:id/terminal/resize",
    validateJsonBody(ajv, terminalResizeSchema),
    (c) => {
      const id = c.req.param("id");
      if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
      if (!store.get(id, c.var.auth!.userId)) return notFound(c);
      const body = validatedBody<Record<string, unknown>>(c);
      const envelope = buildTerminalResizeEnvelope(id, body);
      const delivered = registry.send(id, envelope);
      if (!delivered) {
        return c.json(
          {
            code: "terminal.unavailable",
            message: "No session-agent connected",
            retryable: true,
          },
          503,
        );
      }
      return c.json({ accepted: true }, 202);
    },
  );

  router.get("/:id/events", (c) => {
    const id = c.req.param("id");
    if (sessionTokenMismatch(c.var.auth!, id)) return notFound(c);
    if (!store.get(id, c.var.auth!.userId)) return notFound(c);

    const queue: RemoteEventEnvelope[] = [];
    let notify: (() => void) | null = null;
    const unsubscribe = bus.subscribe(id, (envelope) => {
      queue.push(envelope);
      const wake = notify;
      notify = null;
      wake?.();
    });

    return streamSSE(c, async (stream) => {
      stream.onAbort(unsubscribe);
      try {
        while (!stream.aborted) {
          while (queue.length > 0 && !stream.aborted) {
            const envelope = queue.shift();
            if (!envelope) break;
            await stream.writeSSE({
              event: envelope.type,
              data: JSON.stringify(envelope),
              id: envelope.eventId,
            });
          }
          if (stream.aborted) break;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return { router, reconcileFromAnnounce };
}
