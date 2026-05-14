import { describe, expect, it } from "vitest";
import { createControlPlane } from "./index.js";

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
});
