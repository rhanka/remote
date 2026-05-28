import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT } from "jose";
import { OffAuthenticator, BearerAuthenticator } from "./authenticator.js";

const SECRET = "test-secret-do-not-use-in-prod";

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://cp/sessions", { headers });
}

describe("OffAuthenticator", () => {
  it("returns the default user regardless of headers", async () => {
    const auth = new OffAuthenticator();
    // OffAuthenticator ignores all input; building requests proves headers are irrelevant.
    reqWith({ authorization: "Bearer whatever" });
    const ctx = await auth.authenticate();
    expect(ctx.userId).toBe("default");
    expect(ctx.claims).toEqual({});
  });

  it("returns the default user with no headers", async () => {
    const auth = new OffAuthenticator();
    reqWith({});
    const ctx = await auth.authenticate();
    expect(ctx.userId).toBe("default");
  });
});

describe("BearerAuthenticator", () => {
  let token: string;

  beforeAll(async () => {
    token = await new SignJWT({ sub: "alice" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .sign(new TextEncoder().encode(SECRET));
  });

  it("authenticates a valid HS256 JWT and extracts the user id", async () => {
    const auth = new BearerAuthenticator({ secret: SECRET });
    const ctx = await auth.authenticate(reqWith({ authorization: `Bearer ${token}` }));
    expect(ctx.userId).toBe("alice");
  });

  it("rejects when the Authorization header is missing", async () => {
    const auth = new BearerAuthenticator({ secret: SECRET });
    await expect(auth.authenticate(reqWith({}))).rejects.toThrow();
  });

  it("rejects when the secret is wrong", async () => {
    const auth = new BearerAuthenticator({ secret: "wrong-secret" });
    await expect(
      auth.authenticate(reqWith({ authorization: `Bearer ${token}` })),
    ).rejects.toThrow();
  });
});
