import { SignJWT, jwtVerify } from "jose";

import {
  SESSION_TOKEN_AUDIENCE,
  type AuthContext,
  type Authenticator,
} from "./authenticator.js";

/** Re-exported for callers that mint/verify against the reserved audience.
 * The canonical definition lives in authenticator.ts to avoid an import
 * cycle (BearerAuthenticator must reference it too). */
export { SESSION_TOKEN_AUDIENCE };
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export type MintSessionTokenOptions = {
  readonly userId: string;
  readonly sessionId: string;
  readonly secret: string;
  readonly ttlSeconds?: number;
};

/** Mint an HS256 service token tying a session-agent's callbacks back to the
 * owning userId. Carried into the container as REMOTE_TOKEN. */
export async function mintSessionToken(
  opts: MintSessionTokenOptions,
): Promise<string> {
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  return new SignJWT({ sub: opts.userId, sid: opts.sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(SESSION_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(new TextEncoder().encode(opts.secret));
}

/** The HS256 secret used to mint/verify session tokens; falls back to the
 * user-auth secret so a single-secret deploy needs no extra config. */
export function sessionTokenSecret(): string | undefined {
  return (
    process.env.REMOTE_SESSION_TOKEN_SECRET ?? process.env.REMOTE_AUTH_SECRET
  );
}

/** True when bearer auth is enabled (anything other than the default "off"). */
export function authEnabled(): boolean {
  return (process.env.REMOTE_AUTH ?? "off") !== "off";
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return match ? match[1] : undefined;
}

/**
 * Wrap a user Authenticator so that a per-session service token (minted by
 * {@link mintSessionToken}) is accepted and resolved to the session's userId,
 * while every other request — real user tokens, no header — falls through to
 * the wrapped authenticator unchanged.
 */
export function withSessionTokens(
  userAuth: Authenticator,
  secret: string,
): Authenticator {
  const key = new TextEncoder().encode(secret);
  return {
    async authenticate(req: Request): Promise<AuthContext> {
      const token = bearerToken(req);
      if (token === undefined) return userAuth.authenticate(req);
      try {
        const { payload } = await jwtVerify(token, key, {
          audience: SESSION_TOKEN_AUDIENCE,
        });
        if (typeof payload.sub === "string" && payload.sub.length > 0) {
          // Bind this token to the one session it was minted for; routes
          // enforce it against the :id path param. Only the session-token
          // path sets this — user delegation leaves it undefined.
          return {
            userId: payload.sub,
            claims: payload as Record<string, unknown>,
            ...(typeof payload.sid === "string" && payload.sid.length > 0
              ? { sessionId: payload.sid }
              : {}),
          };
        }
      } catch {
        // Not a valid session token (wrong audience, bad signature, expired,
        // or a real user JWT) — fall through to the user authenticator.
      }
      return userAuth.authenticate(req);
    },
  };
}
