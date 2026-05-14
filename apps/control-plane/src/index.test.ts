import {
  type CreateSessionRequest,
  type CreateSessionResponse,
  REMOTE_PROTOCOL_VERSION,
  createSessionResponseSchema,
  remoteErrorSchema,
  sessionDescriptorSchema,
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
  return ajv;
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
    const ajv = strictAjv();
    ajv.addSchema(sessionDescriptorSchema);
    const validateResponse = ajv.compile(createSessionResponseSchema);
    expect(validateResponse(body)).toBe(true);
    expect(body.session.profile).toBe("codex");
    expect(body.session.workspacePath).toBe("/workspace");
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
    const ajv = strictAjv();
    const validate = ajv.compile(remoteErrorSchema);
    expect(validate(body)).toBe(true);
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
