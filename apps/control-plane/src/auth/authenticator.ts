import { jwtVerify, createRemoteJWKSet } from "jose";

export type AuthContext = {
  readonly userId: string;
  readonly claims: Record<string, unknown>;
};

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface Authenticator {
  authenticate(req: Request): Promise<AuthContext>;
}

export class OffAuthenticator implements Authenticator {
  async authenticate(): Promise<AuthContext> {
    return { userId: "default", claims: {} };
  }
}

function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) throw new AuthError("missing bearer token");
  return m[1]!;
}

export type BearerOptions = {
  readonly secret?: string;
  readonly jwksUrl?: string;
  readonly issuer?: string;
  readonly userClaim?: string;
};

export class BearerAuthenticator implements Authenticator {
  private readonly opts: BearerOptions;
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;
  constructor(opts: BearerOptions) {
    this.opts = opts;
    if (opts.jwksUrl) this.jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  }
  async authenticate(req: Request): Promise<AuthContext> {
    const token = bearer(req);
    const key = this.jwks ?? new TextEncoder().encode(this.opts.secret ?? "");
    try {
      const { payload } = await jwtVerify(token, key as never, {
        ...(this.opts.issuer ? { issuer: this.opts.issuer } : {}),
      });
      const claim = this.opts.userClaim ?? "sub";
      const userId = payload[claim];
      if (typeof userId !== "string" || userId.length === 0) {
        throw new AuthError("token has no user id");
      }
      return { userId, claims: payload as Record<string, unknown> };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(`token verification failed: ${(error as Error).message}`);
    }
  }
}

export function authenticatorFromEnv(): Authenticator {
  if ((process.env.REMOTE_AUTH ?? "off") === "off") return new OffAuthenticator();
  return new BearerAuthenticator({
    ...(process.env.REMOTE_AUTH_SECRET ? { secret: process.env.REMOTE_AUTH_SECRET } : {}),
    ...(process.env.REMOTE_AUTH_JWKS_URL ? { jwksUrl: process.env.REMOTE_AUTH_JWKS_URL } : {}),
    ...(process.env.REMOTE_AUTH_ISSUER ? { issuer: process.env.REMOTE_AUTH_ISSUER } : {}),
    ...(process.env.REMOTE_AUTH_USER_CLAIM ? { userClaim: process.env.REMOTE_AUTH_USER_CLAIM } : {}),
  });
}
