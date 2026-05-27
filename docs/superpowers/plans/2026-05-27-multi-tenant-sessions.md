# Multi-tenant Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the control-plane multi-user — authenticate each request to a `userId`, resolve a per-user namespace, and scope every session/workspace operation to it — while `REMOTE_AUTH=off` preserves today's single-namespace behavior.

**Architecture:** A pluggable `Authenticator` (Hono middleware) yields `{userId}` per request. `tenantNamespace(userId)` maps it to a namespace; a `TenantProvisioner` ensures that namespace exists (poc-k8s in prod, stub in dev). The `K8sSessionProvisioner` becomes namespace-per-call. Session/workspace stores partition by `userId` and 404 on non-owned ids. The remote-cli sends a bearer token.

**Tech Stack:** TypeScript (ESM), Hono, Ajv, vitest, @kubernetes/client-node, commander.

---

## File Structure

- `apps/control-plane/src/auth/authenticator.ts` (new) — `Authenticator` interface, `OffAuthenticator`, `BearerAuthenticator`, `authenticatorFromEnv()`.
- `apps/control-plane/src/auth/authenticator.test.ts` (new) — auth adapters unit tests.
- `apps/control-plane/src/auth/middleware.ts` (new) — Hono middleware setting `c.var.auth`.
- `apps/control-plane/src/tenancy/namespace.ts` (new) — `tenantNamespace(userId)`.
- `apps/control-plane/src/tenancy/namespace.test.ts` (new).
- `apps/control-plane/src/tenancy/tenant-provisioner.ts` (new) — `TenantProvisioner`, `StubTenantProvisioner`, `PocK8sTenantProvisioner`.
- `apps/control-plane/src/tenancy/tenant-provisioner.test.ts` (new).
- `apps/control-plane/src/sessions/store.ts` (modify) — partition by `userId`.
- `apps/control-plane/src/routes/sessions.ts` (modify) — read `c.var.auth`, scope ops, pass namespace.
- `apps/control-plane/src/routes/workspaces.ts` (modify) — same.
- `apps/control-plane/src/index.ts` (modify) — wire authenticator + tenant provisioner + middleware.
- `apps/control-plane/src/validation.ts` (modify) — extend `ValidationVars` with `auth`.
- `packages/k8s-orchestrator/src/k8s/provisioner.ts` (modify) — namespace-per-call.
- `packages/k8s-orchestrator/src/index.ts` (modify) — `ProvisionOptions.namespace`.
- `packages/remote-cli/src/attach.ts` + `config.ts` + `index.ts` (modify) — `REMOTE_TOKEN`/`remote config token` → `Authorization` header.
- `e2e/two-user-isolation.test.ts` (new) — isolation e2e.

> Note: `ValidationVars` is the Hono `Variables` type in `apps/control-plane/src/validation.ts`; routes read it via `c.var`. Confirm the exact export name when you open the file and match it.

---

## Task 1: `Authenticator` seam + adapters

**Files:**
- Create: `apps/control-plane/src/auth/authenticator.ts`
- Test: `apps/control-plane/src/auth/authenticator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/control-plane/src/auth/authenticator.test.ts
import { describe, expect, it } from "vitest";
import { OffAuthenticator, BearerAuthenticator } from "./authenticator.js";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://cp/sessions", { headers });
}

describe("OffAuthenticator", () => {
  it("always returns the default user", async () => {
    const a = new OffAuthenticator();
    expect((await a.authenticate(req())).userId).toBe("default");
  });
});

describe("BearerAuthenticator", () => {
  const secret = "test-secret";
  // HS256 JWT with { sub: "alice" }, signed with `secret` (precomputed).
  const token =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbGljZSJ9.Iix6r0Vd6Hb5n8M3kE0pX2m8mUUmS6h0a3lqg2I3rJk";

  it("extracts userId from a valid HS256 sub", async () => {
    const a = new BearerAuthenticator({ secret });
    const ctx = await a.authenticate(req({ authorization: `Bearer ${token}` }));
    expect(ctx.userId).toBe("alice");
  });

  it("rejects a missing token", async () => {
    const a = new BearerAuthenticator({ secret });
    await expect(a.authenticate(req())).rejects.toThrow(/missing|unauthor/i);
  });

  it("rejects a bad signature", async () => {
    const a = new BearerAuthenticator({ secret: "wrong" });
    await expect(
      a.authenticate(req({ authorization: `Bearer ${token}` })),
    ).rejects.toThrow();
  });
});
```

> The engineer should regenerate the token with the chosen JWT lib for `{sub:"alice"}`/`secret` rather than trusting the literal above; replace it with the real value before running.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@sentropic/remote-control-plane -- authenticator`
Expected: FAIL ("Cannot find module './authenticator.js'").

- [ ] **Step 3: Write the implementation**

Use `jose` (add to control-plane deps: `npm i -w @sentropic/remote-control-plane jose@latest`) for JWT verify.

```ts
// apps/control-plane/src/auth/authenticator.ts
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
  readonly userClaim?: string; // default "sub"
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@sentropic/remote-control-plane -- authenticator`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/auth/authenticator.ts apps/control-plane/src/auth/authenticator.test.ts apps/control-plane/package.json package-lock.json
git commit -m "feat(control-plane): Authenticator seam (off + bearer adapters)"
```

---

## Task 2: Auth middleware + `ValidationVars.auth`

**Files:**
- Create: `apps/control-plane/src/auth/middleware.ts`
- Modify: `apps/control-plane/src/validation.ts` (add `auth?: AuthContext` to the Variables type)

- [ ] **Step 1: Write the failing test**

```ts
// apps/control-plane/src/auth/middleware.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@sentropic/remote-control-plane -- middleware`
Expected: FAIL ("Cannot find module './middleware.js'").

- [ ] **Step 3: Write the implementation**

```ts
// apps/control-plane/src/auth/middleware.ts
import type { MiddlewareHandler } from "hono";
import { AuthError, type Authenticator } from "./authenticator.js";

export function authMiddleware(auth: Authenticator): MiddlewareHandler {
  return async (c, next) => {
    try {
      const ctx = await auth.authenticate(c.req.raw);
      c.set("auth", ctx);
    } catch (error) {
      const message = error instanceof AuthError ? error.message : "unauthorized";
      return c.json({ code: "unauthorized", message, retryable: false }, 401);
    }
    await next();
  };
}
```

In `apps/control-plane/src/validation.ts`, extend the Variables type (it currently holds the validated-body var). Add:

```ts
import type { AuthContext } from "./auth/authenticator.js";
// inside the ValidationVars type:
//   auth?: AuthContext;
```

Add `auth?: AuthContext;` to the existing `ValidationVars` type definition (open the file and add the property; do not remove existing fields).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@sentropic/remote-control-plane -- middleware`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/auth/middleware.ts apps/control-plane/src/auth/middleware.test.ts apps/control-plane/src/validation.ts
git commit -m "feat(control-plane): auth middleware sets c.var.auth, 401 on failure"
```

---

## Task 3: `tenantNamespace` + namespace-per-call provisioner

**Files:**
- Create: `apps/control-plane/src/tenancy/namespace.ts`, `.test.ts`
- Modify: `packages/k8s-orchestrator/src/index.ts` (`ProvisionOptions.namespace?`), `packages/k8s-orchestrator/src/k8s/provisioner.ts`

- [ ] **Step 1: Write the failing test (namespace)**

```ts
// apps/control-plane/src/tenancy/namespace.test.ts
import { describe, expect, it } from "vitest";
import { tenantNamespace } from "./namespace.js";

describe("tenantNamespace", () => {
  it("maps the default user to the shared namespace", () => {
    expect(tenantNamespace("default")).toBe("sentropic-remote");
  });
  it("is deterministic and DNS-safe for arbitrary ids", () => {
    const ns = tenantNamespace("alice@example.com");
    expect(ns).toBe(tenantNamespace("alice@example.com"));
    expect(ns).toMatch(/^user-[a-f0-9]{8}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@sentropic/remote-control-plane -- namespace`
Expected: FAIL ("Cannot find module './namespace.js'").

- [ ] **Step 3: Write the implementation**

```ts
// apps/control-plane/src/tenancy/namespace.ts
import { createHash } from "node:crypto";

const SHARED_NS = "sentropic-remote";

export function tenantNamespace(userId: string): string {
  if (userId === "default") return SHARED_NS;
  const h = createHash("sha256").update(userId).digest("hex").slice(0, 8);
  return `user-${h}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@sentropic/remote-control-plane -- namespace`
Expected: PASS.

- [ ] **Step 5: Make the provisioner namespace-aware (test first)**

Add to `packages/k8s-orchestrator/src/k8s/provisioner.test.ts` (mirror its existing client-mock style) a test asserting the pod/pvc are created in the per-call namespace when `options.namespace` is set:

```ts
it("provisions into the namespace passed in options", async () => {
  const created: Array<{ kind: string; ns: string }> = [];
  const client = {
    create: async (o: { kind: string; metadata: { namespace: string } }) => {
      created.push({ kind: o.kind, ns: o.metadata.namespace });
    },
    delete: async () => {},
  };
  const p = new K8sSessionProvisioner(client as never, { namespace: "sentropic-remote" });
  await p.provision(
    { id: "s1", profile: "shell", target: "k3s", workspacePath: "/workspace",
      createdAt: "2026-05-27T00:00:00.000Z", createdBy: { id: "cp", kind: "control-plane" } },
    () => {},
    { namespace: "user-abc12345" },
  );
  expect(created.every((c) => c.ns === "user-abc12345")).toBe(true);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test --workspace=@sentropic/remote-k8s-orchestrator -- provisioner`
Expected: FAIL (created in the constructor namespace, not `user-abc12345`).

- [ ] **Step 7: Implement namespace-per-call**

In `packages/k8s-orchestrator/src/index.ts`, add to `ProvisionOptions`:

```ts
  readonly namespace?: string;
```

In `packages/k8s-orchestrator/src/k8s/provisioner.ts`, resolve the effective namespace at the top of `provision`/`destroy` and pass it to every spec builder. The spec builders already take `SpecBuilderOptions` whose `.namespace` they use — override it per call:

```ts
const ns = options.namespace ?? this.options.namespace;
const opts = { ...this.options, namespace: ns };
// use `opts` in buildSessionAuthSecret / buildSessionPvcSpec / buildSessionPodSpec
```

For `destroy`, accept the namespace. Since the `SessionProvisioner.destroy(sessionId, emit)` signature has no options, thread it through a third optional arg: change the interface to `destroy(sessionId, emit, namespace?)` and update all implementations (InMemory ignores it, Docker ignores it, K8s uses `namespace ?? this.options.namespace`). Update the control-plane call site in Task 4.

- [ ] **Step 8: Run tests**

Run: `npm test --workspace=@sentropic/remote-k8s-orchestrator`
Expected: PASS (existing + new).

- [ ] **Step 9: Commit**

```bash
git add apps/control-plane/src/tenancy/namespace.ts apps/control-plane/src/tenancy/namespace.test.ts packages/k8s-orchestrator/src
git commit -m "feat(tenancy): tenantNamespace + namespace-per-call provisioner"
```

---

## Task 4: `TenantProvisioner` + scope create/list/stop by user

**Files:**
- Create: `apps/control-plane/src/tenancy/tenant-provisioner.ts`, `.test.ts`
- Modify: `apps/control-plane/src/sessions/store.ts`, `routes/sessions.ts`, `routes/workspaces.ts`, `index.ts`

- [ ] **Step 1: Write the failing test (tenant provisioner)**

```ts
// apps/control-plane/src/tenancy/tenant-provisioner.test.ts
import { describe, expect, it, vi } from "vitest";
import { StubTenantProvisioner, PocK8sTenantProvisioner } from "./tenant-provisioner.js";

describe("StubTenantProvisioner", () => {
  it("returns the shared namespace for any user", async () => {
    const t = new StubTenantProvisioner();
    expect((await t.ensureTenant("alice")).namespace).toBe("sentropic-remote");
  });
});

describe("PocK8sTenantProvisioner", () => {
  it("POSTs the userId and returns the namespace", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ namespace: "user-abc12345", status: "ready" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const t = new PocK8sTenantProvisioner("http://poc:9000", fetchImpl);
    const out = await t.ensureTenant("alice");
    expect(out.namespace).toBe("user-abc12345");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://poc:9000/tenants",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace=@sentropic/remote-control-plane -- tenant-provisioner`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Implement the tenant provisioner**

```ts
// apps/control-plane/src/tenancy/tenant-provisioner.ts
import { tenantNamespace } from "./namespace.js";

export interface TenantProvisioner {
  ensureTenant(userId: string): Promise<{ namespace: string }>;
}

export class StubTenantProvisioner implements TenantProvisioner {
  async ensureTenant(userId: string): Promise<{ namespace: string }> {
    return { namespace: tenantNamespace(userId) };
  }
}

export class PocK8sTenantProvisioner implements TenantProvisioner {
  private readonly cache = new Set<string>();
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async ensureTenant(userId: string): Promise<{ namespace: string }> {
    const ns = tenantNamespace(userId);
    if (this.cache.has(userId)) return { namespace: ns };
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(`ensureTenant: ${res.status}`);
    const json = (await res.json()) as { namespace?: string };
    this.cache.add(userId);
    return { namespace: json.namespace ?? ns };
  }
}

export function tenantProvisionerFromEnv(): TenantProvisioner {
  const url = process.env.POC_K8S_TENANTS_URL;
  return url ? new PocK8sTenantProvisioner(url) : new StubTenantProvisioner();
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test --workspace=@sentropic/remote-control-plane -- tenant-provisioner`
Expected: PASS.

- [ ] **Step 5: Partition the session store (test first)**

In `apps/control-plane/src/sessions/store.ts`, add an owner to each entry. Test:

```ts
// apps/control-plane/src/sessions/store.test.ts (create if absent)
import { describe, expect, it } from "vitest";
import { SessionStore } from "./store.js";

const desc = (id: string) => ({
  id, profile: "shell", target: "k3s", workspacePath: "/workspace",
  createdAt: "2026-05-27T00:00:00.000Z", createdBy: { id: "cp", kind: "control-plane" as const },
});

describe("SessionStore partition", () => {
  it("lists only the owner's sessions and 404-style get for others", () => {
    const s = new SessionStore();
    s.put(desc("a1"), "alice");
    s.put(desc("b1"), "bob");
    expect(s.list("alice").map((d) => d.id)).toEqual(["a1"]);
    expect(s.get("a1", "bob")).toBeUndefined();
    expect(s.get("a1", "alice")?.id).toBe("a1");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test --workspace=@sentropic/remote-control-plane -- store`
Expected: FAIL (current `put/get/list` take no owner).

- [ ] **Step 7: Implement store partition**

Modify `SessionStore` so `put(descriptor, userId)`, `get(id, userId)`, `list(userId)`, `delete(id, userId)` enforce ownership (store `userId` alongside; `get`/`delete` return undefined/false if the owner mismatches). Keep a private `owners: Map<string,string>`.

- [ ] **Step 8: Wire auth + tenancy into routes + index (test first)**

Add an integration test to `apps/control-plane/src/index.test.ts` proving cross-user isolation with an injected authenticator that maps a header to a user:

```ts
it("scopes sessions per authenticated user (no cross-user access)", async () => {
  const { OffAuthenticator } = await import("./auth/authenticator.js");
  // a test authenticator: userId = X-Test-User header
  const auth = { authenticate: async (r: Request) => ({ userId: r.headers.get("x-test-user") ?? "default", claims: {} }) };
  const app = createControlPlane({ authenticator: auth });
  const mk = (u: string) => app.request("/sessions", {
    method: "POST", headers: { "content-type": "application/json", "x-test-user": u },
    body: JSON.stringify({ profile: "shell", target: "k3s" }),
  });
  const a = (await (await mk("alice")).json()) as { session: { id: string } };
  await mk("bob");
  const bobList = (await (await app.request("/sessions", { headers: { "x-test-user": "bob" } })).json()) as { sessions: Array<{ id: string }> };
  expect(bobList.sessions.some((s) => s.id === a.session.id)).toBe(false);
  const bobStop = await app.request(`/sessions/${a.session.id}/stop`, {
    method: "POST", headers: { "content-type": "application/json", "x-test-user": "bob" }, body: "{}",
  });
  expect(bobStop.status).toBe(404);
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `npm test --workspace=@sentropic/remote-control-plane -- index`
Expected: FAIL (`createControlPlane` has no `authenticator` option; routes ignore user).

- [ ] **Step 10: Implement the wiring**

- `createControlPlane(options)`: accept `authenticator?: Authenticator` and `tenantProvisioner?: TenantProvisioner` (default `authenticatorFromEnv()` / `tenantProvisionerFromEnv()`); apply `authMiddleware(authenticator)` on `/sessions` and `/workspaces` routes (mount it before those routers). Pass the `tenantProvisioner` into both routers.
- `createSessionsRouter`/`createWorkspacesRouter`: read `const { userId } = c.var.auth!` in each handler; `const { namespace } = await tenantProvisioner.ensureTenant(userId)`; pass `userId` to store ops and `namespace` to `provisioner.provision/destroy`. The `terminal.exited` auto-stop path (watchForTerminalExited) must capture the session's namespace + userId at create time (store them) so the cascade destroy targets the right namespace.
- `provisionerFromEnv()` already chosen earlier; leave as is.

- [ ] **Step 11: Run tests**

Run: `npm test --workspace=@sentropic/remote-control-plane`
Expected: PASS (existing + isolation test). Existing tests use no `x-test-user` → `OffAuthenticator` → `default` user → `sentropic-remote` ns → unchanged behavior.

- [ ] **Step 12: Commit**

```bash
git add apps/control-plane/src packages/k8s-orchestrator/src
git commit -m "feat(control-plane): per-user tenancy — scope sessions/workspaces by authenticated user"
```

---

## Task 5: CLI bearer token + two-user isolation e2e

**Files:**
- Modify: `packages/remote-cli/src/config.ts`, `attach.ts`, `index.ts`
- Create: `e2e/two-user-isolation.test.ts`

- [ ] **Step 1: Token plumbing in the CLI (test first)**

In `packages/remote-cli/src/config.ts` add `getToken()` (reads `REMOTE_TOKEN` env, else `config.json` `token`) + `setToken(value)`. Test in `config.test.ts` (create if absent) that `setToken` then `getToken` round-trips and `REMOTE_TOKEN` env wins.

```ts
// packages/remote-cli/src/config.test.ts (excerpt)
import { describe, expect, it, beforeEach } from "vitest";
import { setToken, getToken } from "./config.js";
beforeEach(() => { delete process.env.REMOTE_TOKEN; });
it("env REMOTE_TOKEN overrides stored token", () => {
  setToken("stored");
  process.env.REMOTE_TOKEN = "env-tok";
  expect(getToken()).toBe("env-tok");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace=@sentropic/remote-cli -- config`
Expected: FAIL (`getToken`/`setToken` missing).

- [ ] **Step 3: Implement token storage + send the header**

- `config.ts`: add `token?` to the config object; `getToken()` = `process.env.REMOTE_TOKEN ?? readRemoteConfig().token`; `setToken(v)` persists it.
- `attach.ts`: every `fetch`/`fetchImpl` call (createRemoteSession, listRemoteSessions, stopRemoteSession, refreshRemoteSession, attach SSE, terminal input/resize, workspace endpoints) adds `Authorization: Bearer <token>` when `getToken()` is set. Centralize via a small `authHeaders()` helper imported from config; merge into existing `headers`.
- `index.ts`: add `remote config token <value>` subcommand (mirrors `config set`).

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test --workspace=@sentropic/remote-cli`
Expected: PASS.

- [ ] **Step 5: Two-user isolation e2e (docker backend)**

```ts
// e2e/two-user-isolation.test.ts
import { describe, expect, it } from "vitest";
import { createSession, listSessions, stopSession } from "../apps/operator-ui/src/lib/api.js";

const baseUrl = process.env.REMOTE_E2E_BASE_URL;
const runIf = baseUrl ? describe : describe.skip;

// helper: call /sessions with a per-user token header
async function listFor(token: string) {
  const res = await fetch(`${baseUrl}/sessions`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()) as { sessions: Array<{ id: string }> };
}

runIf("two-user isolation", () => {
  it("user B cannot see or stop user A's session", async () => {
    if (!baseUrl) throw new Error("REMOTE_E2E_BASE_URL required");
    const aTok = process.env.E2E_TOKEN_A!;
    const bTok = process.env.E2E_TOKEN_B!;
    const aRes = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aTok}` },
      body: JSON.stringify({ profile: "shell", target: "docker", startupArgs: ["-c", "sleep 60"] }),
    });
    const a = (await aRes.json()) as { session: { id: string } };
    const bList = await listFor(bTok);
    expect(bList.sessions.some((s) => s.id === a.session.id)).toBe(false);
    const bStop = await fetch(`${baseUrl}/sessions/${a.session.id}/stop`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bTok}` }, body: "{}",
    });
    expect(bStop.status).toBe(404);
    // cleanup as A
    await fetch(`${baseUrl}/sessions/${a.session.id}/stop`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${aTok}` }, body: "{}",
    });
  });
});
```

Add a `make e2e-isolation` target: starts the control-plane with `REMOTE_AUTH` set to the bearer adapter + a known secret, sets `E2E_TOKEN_A`/`E2E_TOKEN_B` (JWTs for `alice`/`bob` signed with that secret), `SESSION_BACKEND=docker`, runs this test. Mirror `e2e/run-docker.sh` (script `e2e/run-isolation.sh`).

- [ ] **Step 6: Run the isolation e2e**

Run: `make e2e-isolation`
Expected: PASS (B sees no session of A; B's stop → 404).

- [ ] **Step 7: Commit**

```bash
git add packages/remote-cli/src e2e/two-user-isolation.test.ts e2e/run-isolation.sh Makefile
git commit -m "feat(remote-cli): bearer token + two-user isolation e2e"
```

---

## Notes for the implementer
- `REMOTE_AUTH=off` is the default everywhere; all existing unit tests and the docker/k3s smokes must stay green without setting any auth env. Verify after each task with `npm test --workspaces`.
- Do not give the control-plane any namespace-create RBAC. The poc-k8s `POST /tenants` contract (and the RoleBinding it creates for the control-plane SA) is implemented in the poc-k8s repo, tracked by a sibling spec; here the `StubTenantProvisioner` stands in.
- Keep the `default` user → `sentropic-remote` mapping so a single-tenant deploy needs no poc-k8s tenant API.
