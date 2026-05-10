import { describe, expect, it } from "vitest";
import { createControlPlane } from "./index.js";

describe("control plane", () => {
  it("serves a health endpoint with the protocol version", async () => {
    const app = createControlPlane();
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      service: "remote-controle-control-plane",
      protocolVersion: "0.0.0"
    });

    await app.close();
  });
});
