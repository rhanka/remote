import {
  type CreateSessionRequest,
  type CreateSessionResponse,
  type GetSessionResponse,
  type ListSessionsResponse,
  type RemoteEventEnvelope,
  type SendInstructionResponse,
  type StopSessionResponse,
  REMOTE_PROTOCOL_VERSION,
  createSessionResponseSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
  remoteErrorSchema,
  remoteEventEnvelopeSchema,
  sendInstructionResponseSchema,
  sessionDescriptorSchema,
  stopSessionResponseSchema,
} from "@sentropic/remote-protocol";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it, vi } from "vitest";

import { createControlPlane, provisionerFromEnv } from "./index.js";
import { SessionEventBus } from "./sessions/events.js";

const validRequest: CreateSessionRequest = {
  profile: "codex",
  target: "k3s",
  displayName: "demo session",
};

function strictAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true });
  (addFormats as unknown as (a: Ajv) => Ajv)(ajv);
  ajv.addSchema(sessionDescriptorSchema);
  return ajv;
}

async function createSession(
  app: ReturnType<typeof createControlPlane>,
): Promise<CreateSessionResponse> {
  const response = await app.request("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validRequest),
  });
  return (await response.json()) as CreateSessionResponse;
}

describe("control plane", () => {
  it("serves a health endpoint with the protocol version", async () => {
    const app = createControlPlane();
    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "sentropic-remote-control-plane",
      protocolVersion: "0.1.0",
    });
  });

  it("threads File Storage RWX and node selector env into the k8s provisioner", () => {
    const saved = {
      K8S_NAMESPACE: process.env.K8S_NAMESPACE,
      SESSION_STORAGE_CLASS: process.env.SESSION_STORAGE_CLASS,
      SESSION_STORAGE_ACCESS_MODE: process.env.SESSION_STORAGE_ACCESS_MODE,
      SESSION_WORKSPACE_SIZE: process.env.SESSION_WORKSPACE_SIZE,
      SESSION_NODE_SELECTOR: process.env.SESSION_NODE_SELECTOR,
    };
    try {
      process.env.K8S_NAMESPACE = "sentropic-remote";
      process.env.SESSION_STORAGE_CLASS = "matchid-rwx";
      process.env.SESSION_STORAGE_ACCESS_MODE = "ReadWriteMany";
      process.env.SESSION_WORKSPACE_SIZE = "100G";
      process.env.SESSION_NODE_SELECTOR = "k8s.scaleway.com/pool-name=burst";

      const provisioner = provisionerFromEnv() as unknown as {
        options: {
          storageClassName?: string;
          storageAccessMode?: string;
          defaultWorkspaceSize?: string;
          nodeSelector?: Record<string, string>;
        };
      };

      expect(provisioner.options.storageClassName).toBe("matchid-rwx");
      expect(provisioner.options.storageAccessMode).toBe("ReadWriteMany");
      expect(provisioner.options.defaultWorkspaceSize).toBe("100G");
      expect(provisioner.options.nodeSelector).toEqual({
        "k8s.scaleway.com/pool-name": "burst",
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("serves an OpenAPI 3.1 document referencing protocol components", async () => {
    const app = createControlPlane();
    const response = await app.request("/openapi.json");

    expect(response.status).toBe(200);
    const doc = (await response.json()) as Record<string, unknown>;
    expect(doc.openapi).toBe("3.1.0");
    expect((doc.info as { version: string }).version).toBe(
      REMOTE_PROTOCOL_VERSION,
    );
    const schemas = (doc.components as { schemas: Record<string, unknown> })
      .schemas;
    expect(schemas).toHaveProperty("SessionDescriptor");
    expect(schemas).toHaveProperty("CreateSessionRequest");
    expect(schemas).toHaveProperty("RemoteError");
    const paths = doc.paths as Record<
      string,
      Record<string, { security?: unknown; responses: Record<string, unknown> }>
    >;
    expect(paths).toHaveProperty("/sessions/{id}");
    expect(paths).toHaveProperty("/sessions/{id}/stop");
    expect(paths).toHaveProperty("/sessions/{id}/credentials");
    expect(paths).toHaveProperty("/sessions/{id}/instructions");
    expect(paths).toHaveProperty("/sessions/{id}/events");
    expect(paths).toHaveProperty("/sessions/{id}/terminal/input");

    // The bearer security scheme is declared and applied document-wide.
    const securitySchemes = (
      doc.components as {
        securitySchemes?: Record<string, { scheme?: string }>;
      }
    ).securitySchemes;
    expect(securitySchemes?.bearerAuth?.scheme).toBe("bearer");
    expect(doc.security).toEqual([{ bearerAuth: [] }]);

    // Protected routes document a 401; the public liveness probe opts out.
    expect(paths["/sessions"]!.get!.responses).toHaveProperty("401");
    expect(paths["/sessions/{id}/stop"]!.post!.responses).toHaveProperty("401");
    expect(paths["/healthz"]!.get!.security).toEqual([]);
    expect(paths["/healthz"]!.get!.responses).not.toHaveProperty("401");

    // Workspaces routes are documented too, with the same 401 contract.
    expect(paths).toHaveProperty("/workspaces");
    expect(paths).toHaveProperty("/workspaces/{id}");
    expect(paths).toHaveProperty("/workspaces/{id}/lock");
    expect(paths["/workspaces"]!.post!.responses).toHaveProperty("401");
    expect(paths["/workspaces/{id}/lock"]!.post!.responses).toHaveProperty(
      "409",
    );
  });

  it("streams protocol events via SSE for an existing session", async () => {
    const app = createControlPlane();
    const created = await createSession(app);
    const id = created.session.id;

    const controller = new AbortController();
    const sseResponse = await app.fetch(
      new Request(`http://localhost/sessions/${id}/events`, {
        signal: controller.signal,
      }),
    );
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get("content-type")).toContain(
      "text/event-stream",
    );

    const instructionPromise = app.request(`/sessions/${id}/instructions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "echo hello" }),
    });

    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Read until we receive an instruction.received event (the bus now
    // replays the lifecycle backlog so the first chunk is not the one we
    // assert against).
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("session.instruction.received")) break;
    }

    const instructionResponse = await instructionPromise;
    expect(instructionResponse.status).toBe(202);
    controller.abort();
    await reader.cancel().catch(() => {});

    const envelopes = buffer
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as RemoteEventEnvelope);
    expect(envelopes.length).toBeGreaterThan(0);
    const validate = strictAjv().compile(remoteEventEnvelopeSchema);
    for (const envelope of envelopes) expect(validate(envelope)).toBe(true);
    const instruction = envelopes.find(
      (envelope) => envelope.type === "session.instruction.received",
    );
    expect(instruction).toBeDefined();
    expect(instruction!.sessionId).toBe(id);
    expect((instruction!.payload as { instruction: string }).instruction).toBe(
      "echo hello",
    );
  });

  it("returns 404 on the events stream for unknown sessions", async () => {
    const app = createControlPlane();
    const response = await app.request("/sessions/missing/events");
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("session.not_found");
  });

  it("creates a session and returns a schema-conformant descriptor", async () => {
    const app = createControlPlane();
    const response = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validRequest),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as CreateSessionResponse;
    expect(strictAjv().compile(createSessionResponseSchema)(body)).toBe(true);
    expect(body.session.profile).toBe("codex");
    expect(body.session.workspacePath).toBe("/workspace");
  });

  it("lists, fetches, stops, and instructs sessions through the store", async () => {
    const app = createControlPlane();
    const created = await createSession(app);
    const id = created.session.id;
    const ajv = strictAjv();

    const list = await app.request("/sessions");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as ListSessionsResponse;
    expect(ajv.compile(listSessionsResponseSchema)(listBody)).toBe(true);
    expect(listBody.sessions.map((session) => session.id)).toContain(id);

    const get = await app.request(`/sessions/${id}`);
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as GetSessionResponse;
    expect(ajv.compile(getSessionResponseSchema)(getBody)).toBe(true);
    expect(getBody.session.id).toBe(id);

    const instruction = await app.request(`/sessions/${id}/instructions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "ls /workspace" }),
    });
    expect(instruction.status).toBe(202);
    const instructionBody =
      (await instruction.json()) as SendInstructionResponse;
    expect(ajv.compile(sendInstructionResponseSchema)(instructionBody)).toBe(
      true,
    );

    const stop = await app.request(`/sessions/${id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    });
    expect(stop.status).toBe(200);
    const stopBody = (await stop.json()) as StopSessionResponse;
    expect(ajv.compile(stopSessionResponseSchema)(stopBody)).toBe(true);
    expect(stopBody.accepted).toBe(true);

    const afterStop = await app.request(`/sessions/${id}`);
    expect(afterStop.status).toBe(404);
  });

  it("delegates provisioning and destruction to the injected provisioner", async () => {
    type Call =
      | { op: "provision"; sessionId: string }
      | { op: "destroy"; sessionId: string };
    const calls: Call[] = [];
    const provisioner = {
      async provision(descriptor: { id: string }) {
        calls.push({ op: "provision", sessionId: descriptor.id });
      },
      async refresh(_descriptor: { id: string }) {
        return undefined;
      },
      async destroy(sessionId: string) {
        calls.push({ op: "destroy", sessionId });
      },
      async inspect() {
        return undefined;
      },
    };
    const app = createControlPlane({ provisioner });
    const created = await createSession(app);
    const id = created.session.id;

    await app.request(`/sessions/${id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    });

    expect(calls).toEqual([
      { op: "provision", sessionId: id },
      { op: "destroy", sessionId: id },
    ]);
  });

  it("does not crash when provisioning fails; cleans up the orphaned session", async () => {
    // Regression: a rejecting provision() used to be an unhandled rejection that
    // crashed the whole control-plane (in-process store → every session lost).
    const provisioner = {
      async provision() {
        throw new Error("pods is forbidden: exceeded quota (simulated)");
      },
      async refresh() {
        return undefined;
      },
      async destroy() {
        return undefined;
      },
      async inspect() {
        return undefined;
      },
    };
    const app = createControlPlane({ provisioner });
    const created = await createSession(app);
    const id = created.session.id;
    // The rejection is handled asynchronously (catch → failed event + cleanup).
    await new Promise((resolve) => setTimeout(resolve, 25));
    const res = await app.request(`/sessions/${id}`);
    // Session was cleaned up and the process is still alive to answer.
    expect(res.status).toBe(404);
  });

  it("auto-destroys the session when the agent publishes terminal.exited", async () => {
    type Call =
      | { op: "provision"; sessionId: string }
      | { op: "destroy"; sessionId: string };
    const calls: Call[] = [];
    const provisioner = {
      async provision(descriptor: { id: string }) {
        calls.push({ op: "provision", sessionId: descriptor.id });
      },
      async refresh(_descriptor: { id: string }) {
        return undefined;
      },
      async destroy(sessionId: string) {
        calls.push({ op: "destroy", sessionId });
      },
      async inspect() {
        return undefined;
      },
    };
    const { AgentRegistry } = await import("./agents/registry.js");
    const registry = new AgentRegistry();
    const bus = new SessionEventBus();
    const app = createControlPlane({ provisioner, registry, bus });
    const created = await createSession(app);
    const id = created.session.id;

    bus.publish(id, "terminal.exited", { exitCode: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toEqual([
      { op: "provision", sessionId: id },
      { op: "destroy", sessionId: id },
    ]);
    const listed = await app.request("/sessions");
    const body = (await listed.json()) as { sessions: Array<unknown> };
    expect(body.sessions).toHaveLength(0);
  });

  it("refreshes session credentials through the provisioner", async () => {
    type Call =
      | { op: "provision"; sessionId: string }
      | { op: "refresh"; sessionId: string; credentials: string[] };
    const calls: Call[] = [];
    const provisioner = {
      async provision(descriptor: { id: string }) {
        calls.push({ op: "provision", sessionId: descriptor.id });
      },
      async refresh(
        _descriptor: { id: string },
        _emit: unknown,
        options?: { credentials?: Record<string, string> },
      ) {
        calls.push({
          op: "refresh",
          sessionId: _descriptor.id,
          credentials: Object.keys(options?.credentials ?? {}),
        });
      },
      async destroy() {
        return undefined;
      },
      async inspect() {
        return undefined;
      },
    };
    const app = createControlPlane({ provisioner });
    const created = await createSession(app);
    const id = created.session.id;

    const response = await app.request(`/sessions/${id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ".codex/auth.json": "Zm9v" }),
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { op: "provision", sessionId: id },
      { op: "refresh", sessionId: id, credentials: [".codex/auth.json"] },
    ]);
  });

  // --- Refresh resumes the FRESHEST conversation, not the creation-time one --

  type RefreshSeen = {
    cliSessionId?: string;
    metadata?: Record<string, unknown>;
  };
  function capturingProvisioner(seen: RefreshSeen[]) {
    return {
      async provision() {},
      async refresh(descriptor: RefreshSeen) {
        seen.push(descriptor);
      },
      async destroy() {},
      async inspect() {
        return undefined;
      },
    };
  }
  async function createSessionWith(
    app: ReturnType<typeof createControlPlane>,
    body: Record<string, unknown>,
  ): Promise<string> {
    const response = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateSessionResponse;
    return created.session.id;
  }
  async function reportCliSession(
    app: ReturnType<typeof createControlPlane>,
    id: string,
    cliSessionId: string,
  ): Promise<void> {
    const response = await app.request(`/sessions/${id}/cli-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliSessionId }),
    });
    expect(response.status).toBe(200);
  }
  async function refreshCredentials(
    app: ReturnType<typeof createControlPlane>,
    id: string,
  ): Promise<void> {
    const response = await app.request(`/sessions/${id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ".claude/.credentials.json": "Zm9v" }),
    });
    expect(response.status).toBe(200);
  }

  it("refresh substitutes the freshest cliSessionId into claude --resume args", async () => {
    const seen: RefreshSeen[] = [];
    const app = createControlPlane({ provisioner: capturingProvisioner(seen) });
    const id = await createSessionWith(app, {
      profile: "claude",
      target: "k3s",
      metadata: { startup: { args: ["--resume", "conv-old", "--model", "opus"] } },
    });
    // The agent later reports that the conversation advanced/forked in the Pod.
    await reportCliSession(app, id, "conv-fork");

    await refreshCredentials(app, id);

    // The provisioner rebuilt the Pod from the REWRITTEN descriptor…
    expect(seen).toHaveLength(1);
    expect(seen[0]!.metadata).toEqual({
      startup: { args: ["--resume", "conv-fork", "--model", "opus"] },
    });
    // …and the rewrite is persisted on the session record.
    const got = await app.request(`/sessions/${id}`);
    const { session } = (await got.json()) as GetSessionResponse;
    expect(session.metadata).toEqual({
      startup: { args: ["--resume", "conv-fork", "--model", "opus"] },
    });
  });

  it("refresh substitutes the codex `resume <id>` subcommand form", async () => {
    const seen: RefreshSeen[] = [];
    const app = createControlPlane({ provisioner: capturingProvisioner(seen) });
    const id = await createSessionWith(app, {
      profile: "codex",
      target: "k3s",
      metadata: { startup: { args: ["resume", "conv-old"] } },
    });
    await reportCliSession(app, id, "conv-new");

    await refreshCredentials(app, id);

    expect(seen[0]!.metadata).toEqual({
      startup: { args: ["resume", "conv-new"] },
    });
  });

  it("refresh ADDS a resume couple when the original args had none", async () => {
    const seen: RefreshSeen[] = [];
    const app = createControlPlane({ provisioner: capturingProvisioner(seen) });
    const id = await createSessionWith(app, { profile: "claude", target: "k3s" });
    await reportCliSession(app, id, "conv-live");

    await refreshCredentials(app, id);

    // The whole point of the refresh is to come back to the conversation.
    expect(seen[0]!.metadata).toEqual({
      startup: { args: ["--resume", "conv-live"] },
    });
  });

  it("refresh leaves args untouched when no cliSessionId was reported (old agent compat)", async () => {
    const seen: RefreshSeen[] = [];
    const app = createControlPlane({ provisioner: capturingProvisioner(seen) });
    const id = await createSessionWith(app, {
      profile: "claude",
      target: "k3s",
      metadata: { startup: { args: ["--resume", "conv-old"] } },
    });

    await refreshCredentials(app, id);

    expect(seen[0]!.metadata).toEqual({
      startup: { args: ["--resume", "conv-old"] },
    });
    const got = await app.request(`/sessions/${id}`);
    const { session } = (await got.json()) as GetSessionResponse;
    expect(session.metadata).toEqual({
      startup: { args: ["--resume", "conv-old"] },
    });
  });

  it("refresh leaves args untouched when the resume id is already the fresh one", async () => {
    const seen: RefreshSeen[] = [];
    const app = createControlPlane({ provisioner: capturingProvisioner(seen) });
    const id = await createSessionWith(app, {
      profile: "claude",
      target: "k3s",
      metadata: { startup: { args: ["--resume", "conv-same"] } },
    });
    await reportCliSession(app, id, "conv-same");

    await refreshCredentials(app, id);

    expect(seen[0]!.metadata).toEqual({
      startup: { args: ["--resume", "conv-same"] },
    });
  });

  it("forwards terminal.input through the agent registry to the connected agent", async () => {
    const sent: RemoteEventEnvelope[] = [];
    const { AgentRegistry } = await import("./agents/registry.js");
    const registry = new AgentRegistry();
    const app = createControlPlane({ registry });
    const created = await createSession(app);
    const id = created.session.id;

    registry.register(id, {
      send(envelope) {
        sent.push(envelope);
      },
      close() {},
    });

    const response = await app.request(`/sessions/${id}/terminal/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        terminalId: "term-1",
        data: "ls\n",
        encoding: "utf8",
      }),
    });

    expect(response.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("terminal.input");
    expect(sent[0]!.sessionId).toBe(id);
    expect(sent[0]!.payload).toMatchObject({
      terminalId: "term-1",
      data: "ls\n",
      encoding: "utf8",
    });
  });

  it("forwards terminal.resize to the connected agent", async () => {
    const sent: RemoteEventEnvelope[] = [];
    const { AgentRegistry } = await import("./agents/registry.js");
    const registry = new AgentRegistry();
    const app = createControlPlane({ registry });
    const created = await createSession(app);
    const id = created.session.id;

    registry.register(id, {
      send(envelope) {
        sent.push(envelope);
      },
      close() {},
    });

    const response = await app.request(`/sessions/${id}/terminal/resize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        terminalId: "term-1",
        columns: 132,
        rows: 50,
      }),
    });

    expect(response.status).toBe(202);
    const resize = sent.find(
      (envelope) => envelope.type === "terminal.resized",
    );
    expect(resize).toBeDefined();
    expect(resize!.payload).toMatchObject({
      terminalId: "term-1",
      columns: 132,
      rows: 50,
    });
  });

  it("replays buffered events to a late SSE subscriber", async () => {
    const app = createControlPlane();
    const created = await createSession(app);
    const id = created.session.id;

    // Wait a tick so the create-time lifecycle event lands in the buffer.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const controller = new AbortController();
    const sseResponse = await app.fetch(
      new Request(`http://localhost/sessions/${id}/events`, {
        signal: controller.signal,
      }),
    );
    expect(sseResponse.status).toBe(200);

    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("session.lifecycle.changed")) break;
    }
    controller.abort();
    await reader.cancel().catch(() => {});

    expect(buffer).toContain("session.lifecycle.changed");
  });

  it("forgets buffered events after a session is stopped", async () => {
    const bus = new SessionEventBus();
    const app = createControlPlane({ bus });
    const created = await createSession(app);
    const id = created.session.id;

    await app.request(`/sessions/${id}/instructions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "echo before-stop" }),
    });
    await app.request(`/sessions/${id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const replayed: RemoteEventEnvelope[] = [];
    const unsubscribe = bus.subscribe(id, (envelope) =>
      replayed.push(envelope),
    );
    unsubscribe();

    expect(replayed).toEqual([]);
  });

  it("returns terminal.unavailable when no agent is connected", async () => {
    const app = createControlPlane();
    const created = await createSession(app);
    const response = await app.request(
      `/sessions/${created.session.id}/terminal/input`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          terminalId: "term-x",
          data: "ls\n",
          encoding: "utf8",
        }),
      },
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("terminal.unavailable");
  });

  it("returns session.not_found for unknown ids", async () => {
    const app = createControlPlane();
    const response = await app.request("/sessions/missing");
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(strictAjv().compile(remoteErrorSchema)(body)).toBe(true);
    expect(body.code).toBe("session.not_found");
  });

  it("rejects an invalid create-session payload with validation.failed", async () => {
    const app = createControlPlane();
    const response = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "not-a-profile", target: "bogus" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(strictAjv().compile(remoteErrorSchema)(body)).toBe(true);
    expect(body.code).toBe("validation.failed");
    expect(body.retryable).toBe(false);
  });

  it("rejects malformed JSON bodies with validation.failed", async () => {
    const app = createControlPlane();
    const response = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("validation.failed");
  });

  it("creates, lists, binds, and deletes a workspace", async () => {
    type Call =
      | { op: "provisionWorkspace"; id: string }
      | { op: "destroyWorkspace"; id: string }
      | {
          op: "provision";
          sessionId: string;
          workspaceId?: string | undefined;
        };
    const calls: Call[] = [];
    const provisioner = {
      async provision(descriptor: { id: string; workspaceId?: string }) {
        calls.push({
          op: "provision",
          sessionId: descriptor.id,
          workspaceId: descriptor.workspaceId,
        });
      },
      async refresh() {},
      async destroy() {},
      async inspect() {
        return undefined;
      },
      async provisionWorkspace(id: string) {
        calls.push({ op: "provisionWorkspace", id });
      },
      async destroyWorkspace(id: string) {
        calls.push({ op: "destroyWorkspace", id });
      },
    };
    const app = createControlPlane({ provisioner });

    const created = (await (
      await app.request("/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "proj" }),
      })
    ).json()) as { workspace: { id: string } };
    const wsId = created.workspace.id;
    expect(wsId).toMatch(/^ws-/);
    expect(calls).toContainEqual({ op: "provisionWorkspace", id: wsId });

    const listed = (await (await app.request("/workspaces")).json()) as {
      workspaces: Array<{ id: string }>;
    };
    expect(listed.workspaces.map((w) => w.id)).toContain(wsId);

    // a session bound to the workspace carries workspaceId into provisioning
    await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profile: "shell",
        target: "k3s",
        workspaceId: wsId,
      }),
    });
    expect(
      calls.some((c) => c.op === "provision" && c.workspaceId === wsId),
    ).toBe(true);

    const del = await app.request(`/workspaces/${wsId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(calls).toContainEqual({ op: "destroyWorkspace", id: wsId });
  });

  it("scopes sessions per authenticated user (no cross-user access)", async () => {
    const auth = {
      authenticate: async (r: Request) => ({
        userId: r.headers.get("x-test-user") ?? "default",
        claims: {},
      }),
    };
    const app = createControlPlane({ authenticator: auth });
    const mk = (u: string) =>
      app.request("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": u },
        body: JSON.stringify({ profile: "shell", target: "k3s" }),
      });
    const a = (await (await mk("alice")).json()) as { session: { id: string } };
    await mk("bob");

    const bobList = (await (
      await app.request("/sessions", { headers: { "x-test-user": "bob" } })
    ).json()) as { sessions: Array<{ id: string }> };
    expect(bobList.sessions.some((s) => s.id === a.session.id)).toBe(false);

    const aliceList = (await (
      await app.request("/sessions", { headers: { "x-test-user": "alice" } })
    ).json()) as { sessions: Array<{ id: string }> };
    expect(aliceList.sessions.some((s) => s.id === a.session.id)).toBe(true);

    const bobGet = await app.request(`/sessions/${a.session.id}`, {
      headers: { "x-test-user": "bob" },
    });
    expect(bobGet.status).toBe(404);

    const bobStop = await app.request(`/sessions/${a.session.id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "bob" },
      body: "{}",
    });
    expect(bobStop.status).toBe(404);
  });

  it("scopes a minted session token back to its owner under bearer auth", async () => {
    const prevAuth = process.env.REMOTE_AUTH;
    const prevSecret = process.env.REMOTE_AUTH_SECRET;
    process.env.REMOTE_AUTH = "bearer";
    process.env.REMOTE_AUTH_SECRET = "integration-secret";
    try {
      const { mintSessionToken } = await import("./auth/session-token.js");
      // createControlPlane with no injected authenticator → builds from env
      // (BearerAuthenticator wrapped with withSessionTokens).
      const app = createControlPlane();

      // alice creates a session with a real user token (sub=alice).
      const { SignJWT } = await import("jose");
      const aliceToken = await new SignJWT({ sub: "alice" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .sign(new TextEncoder().encode("integration-secret"));
      const created = (await (
        await app.request("/sessions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${aliceToken}`,
          },
          body: JSON.stringify({ profile: "shell", target: "k3s" }),
        })
      ).json()) as { session: { id: string } };
      const id = created.session.id;

      // The agent's callback carries a minted session token (no user JWT). It
      // must resolve to alice and reach alice's session (200, not 401/404).
      const sessionToken = await mintSessionToken({
        userId: "alice",
        sessionId: id,
        secret: "integration-secret",
      });
      const cb = await app.request(`/sessions/${id}/cli-session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ cliSessionId: "conv-123" }),
      });
      expect(cb.status).toBe(200);

      // A session token minted for bob must NOT reach alice's session.
      const bobToken = await mintSessionToken({
        userId: "bob",
        sessionId: id,
        secret: "integration-secret",
      });
      const denied = await app.request(`/sessions/${id}/cli-session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({ cliSessionId: "conv-456" }),
      });
      expect(denied.status).toBe(404);
    } finally {
      if (prevAuth === undefined) delete process.env.REMOTE_AUTH;
      else process.env.REMOTE_AUTH = prevAuth;
      if (prevSecret === undefined) delete process.env.REMOTE_AUTH_SECRET;
      else process.env.REMOTE_AUTH_SECRET = prevSecret;
    }
  });

  it("binds a session token to its one session (rejects it on another session of the same user)", async () => {
    const prevAuth = process.env.REMOTE_AUTH;
    const prevSecret = process.env.REMOTE_AUTH_SECRET;
    process.env.REMOTE_AUTH = "bearer";
    process.env.REMOTE_AUTH_SECRET = "integration-secret";
    try {
      const { mintSessionToken } = await import("./auth/session-token.js");
      const { SignJWT } = await import("jose");
      const app = createControlPlane();

      const aliceToken = await new SignJWT({ sub: "alice" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .sign(new TextEncoder().encode("integration-secret"));
      const mk = () =>
        app.request("/sessions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${aliceToken}`,
          },
          body: JSON.stringify({ profile: "shell", target: "k3s" }),
        });

      // alice owns two sessions, S1 and S2.
      const s1 = (await (await mk()).json()) as { session: { id: string } };
      const s2 = (await (await mk()).json()) as { session: { id: string } };
      const id1 = s1.session.id;
      const id2 = s2.session.id;
      expect(id1).not.toBe(id2);

      // A session token minted for S1 is accepted on S1's route...
      const tokenForS1 = await mintSessionToken({
        userId: "alice",
        sessionId: id1,
        secret: "integration-secret",
      });
      const allowed = await app.request(`/sessions/${id1}/cli-session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenForS1}`,
        },
        body: JSON.stringify({ cliSessionId: "conv-s1" }),
      });
      expect(allowed.status).toBe(200);

      // ...but rejected (404, no existence leak) on S2 — same user, other id.
      const denied = await app.request(`/sessions/${id2}/cli-session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenForS1}`,
        },
        body: JSON.stringify({ cliSessionId: "conv-s2" }),
      });
      expect(denied.status).toBe(404);
      const body = (await denied.json()) as { code: string };
      expect(body.code).toBe("session.not_found");
    } finally {
      if (prevAuth === undefined) delete process.env.REMOTE_AUTH;
      else process.env.REMOTE_AUTH = prevAuth;
      if (prevSecret === undefined) delete process.env.REMOTE_AUTH_SECRET;
      else process.env.REMOTE_AUTH_SECRET = prevSecret;
    }
  });

  it("warns at startup when bearer auth is on but no session-token secret is set", async () => {
    const prevAuth = process.env.REMOTE_AUTH;
    const prevSecret = process.env.REMOTE_AUTH_SECRET;
    const prevSessionSecret = process.env.REMOTE_SESSION_TOKEN_SECRET;
    const prevJwks = process.env.REMOTE_AUTH_JWKS_URL;
    process.env.REMOTE_AUTH = "bearer";
    delete process.env.REMOTE_AUTH_SECRET;
    delete process.env.REMOTE_SESSION_TOKEN_SECRET;
    process.env.REMOTE_AUTH_JWKS_URL =
      "https://issuer.example/.well-known/jwks.json";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createControlPlane();
      expect(warnSpy).toHaveBeenCalled();
      const message = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(message).toContain("REMOTE_SESSION_TOKEN_SECRET");
    } finally {
      warnSpy.mockRestore();
      if (prevAuth === undefined) delete process.env.REMOTE_AUTH;
      else process.env.REMOTE_AUTH = prevAuth;
      if (prevSecret === undefined) delete process.env.REMOTE_AUTH_SECRET;
      else process.env.REMOTE_AUTH_SECRET = prevSecret;
      if (prevSessionSecret === undefined)
        delete process.env.REMOTE_SESSION_TOKEN_SECRET;
      else process.env.REMOTE_SESSION_TOKEN_SECRET = prevSessionSecret;
      if (prevJwks === undefined) delete process.env.REMOTE_AUTH_JWKS_URL;
      else process.env.REMOTE_AUTH_JWKS_URL = prevJwks;
    }
  });

  it("threads the tenant namespace into provision and destroy", async () => {
    const calls: Array<{ op: string; namespace: string | undefined }> = [];
    const provisioner = {
      async provision(
        _d: { id: string },
        _e: unknown,
        options?: { namespace?: string },
      ) {
        calls.push({ op: "provision", namespace: options?.namespace });
      },
      async refresh() {},
      async destroy(_id: string, _e: unknown, namespace?: string) {
        calls.push({ op: "destroy", namespace });
      },
      async inspect() {
        return undefined;
      },
    };
    const auth = {
      authenticate: async (r: Request) => ({
        userId: r.headers.get("x-test-user") ?? "default",
        claims: {},
      }),
    };
    const app = createControlPlane({ provisioner, authenticator: auth });
    const created = (await (
      await app.request("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "alice" },
        body: JSON.stringify({ profile: "shell", target: "k3s" }),
      })
    ).json()) as { session: { id: string } };
    await app.request(`/sessions/${created.session.id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "alice" },
      body: "{}",
    });

    const expectedNs = (await import("./tenancy/namespace.js")).tenantNamespace(
      "alice",
    );
    expect(calls).toEqual([
      { op: "provision", namespace: expectedNs },
      { op: "destroy", namespace: expectedNs },
    ]);
  });

  // --- Durability: agent session.announce repopulates the store ------------

  type FakeWs = {
    sent: string[];
    closed: { code?: number; reason?: string } | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
  };
  function fakeWs(): FakeWs {
    return {
      sent: [],
      closed: null,
      send(data) {
        this.sent.push(data);
      },
      close(code, reason) {
        this.closed = {
          ...(code !== undefined ? { code } : {}),
          ...(reason !== undefined ? { reason } : {}),
        };
      },
    };
  }
  function announceFrame(body: unknown): { data: string } {
    return { data: JSON.stringify({ type: "session.announce", body }) };
  }

  it("repopulates an unknown session from an agent announce (restart durability)", async () => {
    // Simulate a control-plane restart: NO POST /sessions; the store is empty.
    const app = createControlPlane();
    const id = "sess-restored-1";
    const events = app.buildAgentSocketEvents(id);
    const ws = fakeWs();

    // onOpen for an unknown session must NOT immediately close it.
    events.onOpen?.(new Event("open"), ws as never);
    expect(ws.closed).toBeNull();

    // The agent's first frame is its session.announce → repopulate.
    events.onMessage?.(
      announceFrame({
        sessionId: id,
        profile: "codex",
        target: "k3s",
        workspacePath: "/workspace",
        workspaceId: "ws-42",
      }) as never,
      ws as never,
    );

    // Now listable (owner default) and attachable.
    const listed = await app.request("/sessions");
    const list = (await listed.json()) as ListSessionsResponse;
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]!.id).toBe(id);
    expect(list.sessions[0]!.profile).toBe("codex");
    expect(list.sessions[0]!.workspaceId).toBe("ws-42");
    expect(list.sessions[0]!.createdBy.kind).toBe("control-plane");

    const got = await app.request(`/sessions/${id}`);
    expect(got.status).toBe(200);
    const single = (await got.json()) as GetSessionResponse;
    expect(single.session.id).toBe(id);
  });

  it("preserves home + startupArgs across announce→reconcile so a refreshed pod keeps parity", async () => {
    // Simulate a control-plane restart with a session that was migrated with
    // HOME parity and a --resume conversation. The announce is the only record.
    const app = createControlPlane();
    const id = "sess-restored-parity";
    const events = app.buildAgentSocketEvents(id);
    const ws = fakeWs();
    events.onOpen?.(new Event("open"), ws as never);
    events.onMessage?.(
      announceFrame({
        sessionId: id,
        profile: "claude",
        target: "k3s",
        workspacePath: "/home/user/src/proj",
        workspaceId: "ws-42",
        home: "/home/user",
        startupArgs: ["--resume", "conv-123"],
      }) as never,
      ws as never,
    );

    // The reconstructed descriptor maps home + startup metadata to the exact
    // locations buildSessionPodSpec reads.
    const got = await app.request(`/sessions/${id}`);
    expect(got.status).toBe(200);
    const { session } = (await got.json()) as GetSessionResponse;
    expect(session.home).toBe("/home/user");
    expect(session.metadata).toEqual({
      startup: { args: ["--resume", "conv-123"] },
    });

    // …so a post-restart `remote refresh` regenerates a Pod with the SAME
    // HOME and SESSION_STARTUP_ARGS as the original (no fresh /root session).
    const { buildSessionPodSpec } = await import(
      "@sentropic/remote-k8s-orchestrator"
    );
    const pod = buildSessionPodSpec(session);
    const env = pod.spec.containers[0]!.env;
    expect(env.find((e) => e.name === "HOME")?.value).toBe("/home/user");
    expect(env.find((e) => e.name === "SESSION_STARTUP_ARGS")?.value).toBe(
      JSON.stringify(["--resume", "conv-123"]),
    );
  });

  it("preserves displayName/labels/resourceLimits across announce→refresh (restart parity)", async () => {
    // Control-plane restarted from scratch: the announce is the ONLY record of
    // the session's custom name/labels/limits. A refresh must regenerate the
    // Pod from a descriptor that still carries them — before this, a
    // post-restart refresh silently fell back to default resources.
    const refreshed: Array<{
      displayName?: string;
      labels?: Record<string, string>;
      resourceLimits?: { cpu?: string; memory?: string };
    }> = [];
    const provisioner = {
      async provision() {},
      async refresh(d: {
        displayName?: string;
        labels?: Record<string, string>;
        resourceLimits?: { cpu?: string; memory?: string };
      }) {
        refreshed.push(d);
      },
      async destroy() {},
      async inspect() {
        return undefined;
      },
    };
    const app = createControlPlane({ provisioner });
    const id = "sess-restored-limits";
    const events = app.buildAgentSocketEvents(id);
    const ws = fakeWs();
    events.onOpen?.(new Event("open"), ws as never);
    events.onMessage?.(
      announceFrame({
        sessionId: id,
        profile: "claude",
        target: "k3s",
        workspacePath: "/home/user/src/proj",
        home: "/home/user",
        displayName: "big-build",
        labels: { team: "core" },
        resourceLimits: { cpu: "4", memory: "8Gi" },
      }) as never,
      ws as never,
    );

    // The reconstructed descriptor carries the parity fields…
    const got = await app.request(`/sessions/${id}`);
    expect(got.status).toBe(200);
    const { session } = (await got.json()) as GetSessionResponse;
    expect(session.displayName).toBe("big-build");
    expect(session.labels).toEqual({ team: "core" });
    expect(session.resourceLimits).toEqual({ cpu: "4", memory: "8Gi" });

    // …a refresh hands the provisioner that SAME descriptor…
    const refresh = await app.request(`/sessions/${id}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ".claude/.credentials.json": "eA==" }),
    });
    expect(refresh.status).toBe(200);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]!.displayName).toBe("big-build");
    expect(refreshed[0]!.labels).toEqual({ team: "core" });
    expect(refreshed[0]!.resourceLimits).toEqual({ cpu: "4", memory: "8Gi" });

    // …and the regenerated Pod applies the custom limits + re-injects the
    // announce-parity env vars for the NEXT restart cycle.
    const { buildSessionPodSpec } = await import(
      "@sentropic/remote-k8s-orchestrator"
    );
    const pod = buildSessionPodSpec(session);
    const container = pod.spec.containers[0]! as {
      env: ReadonlyArray<{ name: string; value: string }>;
      resources?: { limits?: Record<string, string> };
    };
    // Custom cpu/memory override the baseline; the anti-eviction
    // ephemeral-storage cap is always added (v0.5.12) — see SESSION_AGENT_EPHEMERAL_LIMIT.
    expect(container.resources?.limits).toEqual({
      cpu: "4",
      memory: "8Gi",
      "ephemeral-storage": "8Gi",
    });
    const env = container.env;
    expect(env.find((e) => e.name === "SESSION_DISPLAY_NAME")?.value).toBe(
      "big-build",
    );
    expect(env.find((e) => e.name === "SESSION_LABELS")?.value).toBe(
      JSON.stringify({ team: "core" }),
    );
    expect(env.find((e) => e.name === "SESSION_RESOURCE_LIMITS")?.value).toBe(
      JSON.stringify({ cpu: "4", memory: "8Gi" }),
    );
  });

  it("re-announce fills missing parity fields but never overwrites a richer record", async () => {
    const app = createControlPlane();
    const id = "sess-merge-conservative";
    const events = app.buildAgentSocketEvents(id);
    const ws = fakeWs();
    events.onOpen?.(new Event("open"), ws as never);
    // First announce: an OLD agent without the parity fields establishes the
    // session (post-restart), so the record lacks displayName/limits.
    events.onMessage?.(
      announceFrame({ sessionId: id, profile: "claude", target: "k3s" }) as never,
      ws as never,
    );
    // Re-announce (upgraded agent image after refresh): fills the gaps.
    events.onMessage?.(
      announceFrame({
        sessionId: id,
        profile: "claude",
        target: "k3s",
        displayName: "filled-in",
        resourceLimits: { memory: "2Gi" },
      }) as never,
      ws as never,
    );
    let { session } = (await (
      await app.request(`/sessions/${id}`)
    ).json()) as GetSessionResponse;
    expect(session.displayName).toBe("filled-in");
    expect(session.resourceLimits).toEqual({ memory: "2Gi" });

    // A later announce with DIFFERENT values does not clobber the record.
    events.onMessage?.(
      announceFrame({
        sessionId: id,
        profile: "claude",
        target: "k3s",
        displayName: "stale-name",
        resourceLimits: { memory: "1Gi" },
      }) as never,
      ws as never,
    );
    ({ session } = (await (
      await app.request(`/sessions/${id}`)
    ).json()) as GetSessionResponse);
    expect(session.displayName).toBe("filled-in");
    expect(session.resourceLimits).toEqual({ memory: "2Gi" });
  });

  it("makes a repopulated session stoppable", async () => {
    const app = createControlPlane();
    const id = "sess-restored-2";
    const events = app.buildAgentSocketEvents(id);
    const ws = fakeWs();
    events.onOpen?.(new Event("open"), ws as never);
    events.onMessage?.(
      announceFrame({ sessionId: id, profile: "shell" }) as never,
      ws as never,
    );

    const stop = await app.request(`/sessions/${id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(stop.status).toBe(200);
    const after = await app.request("/sessions");
    expect(((await after.json()) as ListSessionsResponse).sessions).toHaveLength(
      0,
    );
  });

  it("announcing a known session is idempotent (no duplicate, no error)", async () => {
    const app = createControlPlane();
    const created = await createSession(app);
    const id = created.session.id;

    const events = app.buildAgentSocketEvents(id);
    const ws = fakeWs();
    events.onOpen?.(new Event("open"), ws as never);
    expect(ws.closed).toBeNull();
    events.onMessage?.(
      announceFrame({
        sessionId: id,
        profile: "codex",
        target: "k3s",
        workspacePath: "/workspace",
      }) as never,
      ws as never,
    );

    const listed = await app.request("/sessions");
    const list = (await listed.json()) as ListSessionsResponse;
    expect(list.sessions).toHaveLength(1);
    // The original descriptor (its displayName) is preserved, not overwritten.
    expect(list.sessions[0]!.displayName).toBe("demo session");
  });

  it("adopts a fresher cliSessionId from a re-announce of a KNOWN session", async () => {
    const app = createControlPlane();
    const created = await createSession(app);
    const id = created.session.id;

    const events = app.buildAgentSocketEvents(id);
    const ws = fakeWs();
    events.onOpen?.(new Event("open"), ws as never);
    // The agent re-detects its conversation id on every reconnect — e.g. the
    // conversation forked inside the Pod since creation.
    events.onMessage?.(
      announceFrame({
        sessionId: id,
        profile: "codex",
        target: "k3s",
        workspacePath: "/workspace",
        cliSessionId: "conv-forked",
      }) as never,
      ws as never,
    );

    const got = await app.request(`/sessions/${id}`);
    const { session } = (await got.json()) as GetSessionResponse;
    // Only cliSessionId is adopted; the rest of the record is untouched.
    expect(session.cliSessionId).toBe("conv-forked");
    expect(session.displayName).toBe("demo session");
    // Ownership is preserved too: still listable by the same (default) owner.
    const listed = await app.request("/sessions");
    expect(
      ((await listed.json()) as ListSessionsResponse).sessions,
    ).toHaveLength(1);
  });

  it("ignores a malformed announce without crashing and closes cleanly", async () => {
    const app = createControlPlane();
    const id = "sess-bad";
    const events = app.buildAgentSocketEvents(id);
    const ws = fakeWs();
    events.onOpen?.(new Event("open"), ws as never);

    // Missing required `profile` → invalid against sessionAnnounceSchema.
    expect(() =>
      events.onMessage?.(
        announceFrame({ sessionId: id }) as never,
        ws as never,
      ),
    ).not.toThrow();
    // Session not established, socket closed cleanly (1008), no crash.
    expect(ws.closed?.code).toBe(1008);
    const listed = await app.request("/sessions");
    expect(
      ((await listed.json()) as ListSessionsResponse).sessions,
    ).toHaveLength(0);

    // Non-JSON garbage is also tolerated.
    expect(() =>
      events.onMessage?.({ data: "{not json" } as never, ws as never),
    ).not.toThrow();
  });

  it("registers the terminal after a repopulated session can be driven", async () => {
    const { AgentRegistry } = await import("./agents/registry.js");
    const registry = new AgentRegistry();
    const app = createControlPlane({ registry });
    const id = "sess-restored-3";
    const events = app.buildAgentSocketEvents(id);
    const ws = fakeWs();
    events.onOpen?.(new Event("open"), ws as never);
    events.onMessage?.(
      announceFrame({ sessionId: id, profile: "shell" }) as never,
      ws as never,
    );
    expect(registry.get(id)).toBeDefined();

    // The control-plane can now forward terminal input to the re-registered agent.
    const response = await app.request(`/sessions/${id}/terminal/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalId: "t1", data: "ls\n", encoding: "utf8" }),
    });
    expect(response.status).toBe(202);
    expect(ws.sent.some((s) => s.includes("terminal.input"))).toBe(true);
  });
});

describe("workspace soft-lock", () => {
  async function createWorkspace(
    app: ReturnType<typeof createControlPlane>,
  ): Promise<string> {
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "lock-test" }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { workspace: { id: string } }).workspace.id;
  }

  async function acquire(
    app: ReturnType<typeof createControlPlane>,
    id: string,
    holder: string,
    ttlSeconds?: number,
  ): Promise<Response> {
    return app.request(`/workspaces/${id}/lock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        ttlSeconds === undefined ? { holder } : { holder, ttlSeconds },
      ),
    });
  }

  it("acquires, blocks a different holder (409), refreshes the holder, and releases", async () => {
    const app = createControlPlane();
    const id = await createWorkspace(app);

    const a1 = await acquire(app, id, "alice");
    expect(a1.status).toBe(200);
    expect(((await a1.json()) as { holder: string }).holder).toBe("alice");

    const b = await acquire(app, id, "bob");
    expect(b.status).toBe(409);
    const bBody = (await b.json()) as { code: string; holder: string };
    expect(bBody.code).toBe("workspace.locked");
    expect(bBody.holder).toBe("alice");

    // Same holder may re-acquire (refresh).
    expect((await acquire(app, id, "alice")).status).toBe(200);

    const get = await app.request(`/workspaces/${id}`);
    const getBody = (await get.json()) as { lock?: { holder: string } };
    expect(getBody.lock?.holder).toBe("alice");

    const release = await app.request(`/workspaces/${id}/lock`, {
      method: "DELETE",
    });
    expect(release.status).toBe(200);
    expect(((await release.json()) as { released: boolean }).released).toBe(
      true,
    );

    // Released → another holder can take it.
    expect((await acquire(app, id, "bob")).status).toBe(200);
  });

  it("expires the lock once its TTL elapses", async () => {
    // Only Date.now() is mocked (what activeLock uses) — async/timers untouched.
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000_000);
      const app = createControlPlane();
      const id = await createWorkspace(app);

      expect((await acquire(app, id, "alice", 1)).status).toBe(200);
      // Before expiry, a different holder is blocked.
      expect((await acquire(app, id, "bob")).status).toBe(409);

      // Advance past the 1s TTL.
      nowSpy.mockReturnValue(1_000_000 + 1_001);

      const late = await acquire(app, id, "bob");
      expect(late.status).toBe(200);
      expect(((await late.json()) as { holder: string }).holder).toBe("bob");
    } finally {
      nowSpy.mockRestore();
    }
  });
});
