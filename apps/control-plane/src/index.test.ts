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
import { describe, expect, it } from "vitest";

import { createControlPlane } from "./index.js";
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
    const paths = doc.paths as Record<string, unknown>;
    expect(paths).toHaveProperty("/sessions/{id}");
    expect(paths).toHaveProperty("/sessions/{id}/stop");
    expect(paths).toHaveProperty("/sessions/{id}/instructions");
    expect(paths).toHaveProperty("/sessions/{id}/events");
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
});
