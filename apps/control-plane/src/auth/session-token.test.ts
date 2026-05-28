import { describe, expect, it } from "vitest";

import { OffAuthenticator, type Authenticator } from "./authenticator.js";
import { mintSessionToken, withSessionTokens } from "./session-token.js";

const SECRET = "test-session-token-secret";

function bearerRequest(token: string): Request {
  return new Request("http://cp/sessions/sess-1/workspace", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("session-token", () => {
  it("mints a token that withSessionTokens verifies back to its userId", async () => {
    const token = await mintSessionToken({
      userId: "alice",
      sessionId: "sess-1",
      secret: SECRET,
    });
    const auth = withSessionTokens(new OffAuthenticator(), SECRET);
    const ctx = await auth.authenticate(bearerRequest(token));
    expect(ctx.userId).toBe("alice");
  });

  it("delegates to userAuth for a token not minted for the agent audience", async () => {
    const userAuth: Authenticator = {
      authenticate: async () => ({ userId: "USERAUTH", claims: {} }),
    };
    const auth = withSessionTokens(userAuth, SECRET);
    // garbage bearer token → session-token path fails → delegate
    const ctx = await auth.authenticate(bearerRequest("not-a-real-jwt"));
    expect(ctx.userId).toBe("USERAUTH");
  });

  it("delegates to userAuth when no Authorization header is present", async () => {
    const userAuth: Authenticator = {
      authenticate: async () => ({ userId: "USERAUTH", claims: {} }),
    };
    const auth = withSessionTokens(userAuth, SECRET);
    const ctx = await auth.authenticate(
      new Request("http://cp/sessions"),
    );
    expect(ctx.userId).toBe("USERAUTH");
  });

  it("delegates a token minted for a different audience to userAuth", async () => {
    // A plain user JWT (signed with the same secret but no agent audience)
    // must fall through, not be accepted by the session-token path.
    const { SignJWT } = await import("jose");
    const userToken = await new SignJWT({ sub: "carol" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .sign(new TextEncoder().encode(SECRET));
    const userAuth: Authenticator = {
      authenticate: async () => ({ userId: "USERAUTH", claims: {} }),
    };
    const auth = withSessionTokens(userAuth, SECRET);
    const ctx = await auth.authenticate(bearerRequest(userToken));
    expect(ctx.userId).toBe("USERAUTH");
  });
});
