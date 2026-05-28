import type { MiddlewareHandler } from "hono";
import { AuthError, type Authenticator } from "./authenticator.js";

export function authMiddleware(auth: Authenticator): MiddlewareHandler {
  return async (c, next) => {
    try {
      const ctx = await auth.authenticate(c.req.raw);
      c.set("auth", ctx);
    } catch (error) {
      const message = error instanceof AuthError ? error.message : "unauthorized";
      return c.json({ code: "auth.unauthorized", message, retryable: false }, 401);
    }
    await next();
  };
}
