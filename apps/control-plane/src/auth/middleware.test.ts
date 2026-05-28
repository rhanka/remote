import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { OffAuthenticator, BearerAuthenticator } from "./authenticator.js";
import { authMiddleware } from "./middleware.js";

describe("authMiddleware", () => {
  it("sets c.var.auth and calls next on success", async () => {
    const app = new Hono();
    app.use("*", authMiddleware(new OffAuthenticator()));
    app.get("/x", (c) => c.json({ user: (c.var as { auth?: { userId: string } }).auth?.userId }));
    const res = await app.request("/x");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "default" });
  });

  it("returns 401 when authentication fails", async () => {
    const app = new Hono();
    app.use("*", authMiddleware(new BearerAuthenticator({ secret: "s" })));
    app.get("/x", (c) => c.json({ ok: true }));
    const res = await app.request("/x");
    expect(res.status).toBe(401);
  });
});
