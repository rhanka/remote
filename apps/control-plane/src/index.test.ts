import {
  type CreateSessionRequest,
  type CreateSessionResponse,
  type GetSessionResponse,
  type ListSessionsResponse,
  type SendInstructionResponse,
  type StopSessionResponse,
  REMOTE_PROTOCOL_VERSION,
  createSessionResponseSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
  remoteErrorSchema,
  sendInstructionResponseSchema,
  sessionDescriptorSchema,
  stopSessionResponseSchema,
} from "@remote-controle/protocol";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { createControlPlane } from "./index.js";

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
      service: "remote-controle-control-plane",
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
