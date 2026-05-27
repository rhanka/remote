# Design — Multi-tenant sessions (per-user namespace isolation)

Date: 2026-05-27
Status: accepted (brainstorm), pending spec review → implementation plan

## Context

The Sentropic Remote control-plane is single-tenant today: it serves one
namespace (`sentropic-remote`), has **no authentication**, and any caller can
create/list/stop **any** session. To serve real users we need a multi-user
architecture with proper isolation, without forcing users to refactor their
setup.

Three planes, owned by three repos:

- **Identity plane — `../sentropic`** (eventually): user management + login.
  Its OAuth is currently stubbed (`/auth/*` → 501). It is the future source of
  identity; `remote` integrates through a seam, not a hard dependency.
- **Infra plane — `../poc-k8s`**: the cluster authority. Already models
  *tenant = namespace* (`tenants/<name>/00-namespace.yaml` = Namespace +
  ResourceQuota + LimitRange + NetworkPolicy default-deny + allow-traefik),
  applied by `make apply-tenants`. It owns namespace/quota/netpol/RBAC
  lifecycle.
- **Session plane — `remote`** (this repo): authenticates each request to a
  `userId`, resolves the user's namespace, and provisions/lists/stops sessions
  and workspaces scoped to that namespace.

### Decisions (Q/R 2026-05-27)

1. **Isolation unit = one namespace per user.** A user is a tenant; their
   workspaces, sessions, and secrets live in `user-<id>`. Maps 1:1 onto
   poc-k8s's tenant model and sentropic's `userId`.
2. **poc-k8s owns namespace lifecycle, via a provisioning API/operator.** The
   remote control-plane holds **no** cluster namespace-create power; it calls
   poc-k8s to ensure a user's tenant exists.
3. **Pluggable `Authenticator` seam.** V1 adapter = signed bearer / generic
   OIDC; `SentropicOIDCAuthenticator` swaps in when sentropic is ready. Every
   op is scoped by `userId`.
4. **This spec's scope = the remote side + the interface contracts** it needs
   from poc-k8s and sentropic. The poc-k8s operator and the sentropic OIDC
   adapter are separate specs in their own repos.

## Scope

In scope (this spec → first implementation plan):

- `Authenticator` seam + auth middleware on `/sessions` and `/workspaces`.
- Per-user namespace resolution + scoping of every session/workspace operation.
- `K8sSessionProvisioner` made namespace-per-call (today: fixed namespace).
- A `TenantProvisioner` client that calls the poc-k8s provisioning API
  (with a dev/no-op stub).
- User-partitioned session/workspace stores + authorization.
- The **contracts** consumed from poc-k8s and sentropic (documented here).

Out of scope (separate specs / repos):

- The poc-k8s tenant-provisioning operator/API implementation.
- The sentropic OIDC issuer + `SentropicOIDCAuthenticator` production adapter.
- Cross-user collaboration / shared workspaces (future).
- Billing/quota policy beyond what poc-k8s's tenant template already enforces.

## Components (remote)

### 1. `Authenticator` seam
```ts
type AuthContext = { userId: string; claims: Record<string, unknown> };
interface Authenticator {
  authenticate(req: Request): Promise<AuthContext>; // throws/401 on failure
}
```
- Wired as Hono middleware on `/sessions/*` and `/workspaces/*`; sets
  `c.var.auth`. Health/OpenAPI stay public.
- **V1 adapter** `BearerAuthenticator`: verifies a signed token (shared secret
  or JWKS) and extracts `userId` from `sub`. Config via env
  (`REMOTE_AUTH_JWKS_URL` / `REMOTE_AUTH_SECRET`, `REMOTE_AUTH_ISSUER`).
- **Disabled mode** `REMOTE_AUTH=off` → a fixed `default` user, served from the
  existing `sentropic-remote` namespace. Preserves today's behavior so current
  setups keep working with zero changes.
- **Future** `SentropicOIDCAuthenticator`: validates sentropic-issued JWTs.

### 2. Namespace resolution
```ts
function tenantNamespace(userId: string): string; // e.g. `user-<sha8(userId)>`
```
- Deterministic, DNS-safe (`user-` + short hash; the raw userId may not be a
  valid label). The `default` user maps to `sentropic-remote`.

### 3. Namespace-aware provisioner
- `K8sSessionProvisioner` takes the target namespace **per call** (provision /
  destroy / inspect / workspace ops), instead of a single constructor
  namespace. The control-plane passes the authenticated user's namespace.
- `InMemoryProvisioner` and `DockerSessionProvisioner` ignore namespace (no-op
  for the docker/dev backends) but accept the parameter for interface parity.

### 4. `TenantProvisioner` client (→ poc-k8s)
```ts
interface TenantProvisioner {
  ensureTenant(userId: string): Promise<{ namespace: string }>; // idempotent
  // (teardown is poc-k8s-driven; remote does not delete tenants)
}
```
- `PocK8sTenantProvisioner`: `POST {POC_K8S_TENANTS_URL}/tenants {userId}`.
- `StubTenantProvisioner` (dev/no-auth): returns the shared
  `sentropic-remote` namespace; assumes it already exists.
- Called lazily on the first session/workspace for a user (cached).

### 5. Authorization + partitioned stores
- `SessionStore` / workspace store keyed by `(userId, id)`; `list()` returns
  only the caller's resources. `get/stop/attach/refresh` 404 if the resource
  isn't owned by the caller (no existence leak).
- k8s queries are namespace-scoped, so cross-tenant reads are impossible at the
  cluster layer too.

## Interface contracts

### poc-k8s — tenant provisioning (consumed)
- `POST /tenants` `{ "userId": "<id>" }` → `200 { "namespace": "user-<…>",
  "status": "ready" }`. Idempotent (re-provisioning a live tenant is a no-op).
- Applies the existing tenant template for `user-<…>`: Namespace +
  ResourceQuota + LimitRange + NetworkPolicy default-deny + allow-traefik, and a
  RoleBinding granting the remote control-plane ServiceAccount
  `create/get/list/delete` on `pods, persistentvolumeclaims, secrets` **within
  that namespace only**.
- `DELETE /tenants/{userId}` → tears the tenant down (poc-k8s-owned; out of
  remote's flow).
- Auth between remote and poc-k8s: a service token (out of scope to design
  here; noted as a dependency).

### sentropic — identity (consumed)
- Bearer token (JWT) whose `sub` (or `userId` claim) is the stable user id;
  optional `roles`. `Authenticator` maps `sub → userId`.

## Data flow — create session
```
POST /sessions  (Authorization: Bearer <token>)
  → Authenticator.authenticate → { userId }
  → TenantProvisioner.ensureTenant(userId) → namespace
  → store.put({ ...descriptor, userId })
  → provisioner.provision(descriptor, { namespace, ...options })
  → pod/pvc/secret created in `user-<…>`
```
List/stop/attach/refresh and all workspace ops follow the same
authenticate → resolve-namespace → scope pattern.

## Security model
- **AuthN**: every `/sessions` + `/workspaces` route requires a valid token
  (401 otherwise). No anonymous access in multi-tenant mode.
- **AuthZ**: operations are filtered by `userId` → namespace; a user cannot
  see or act on another user's sessions/workspaces (store partition + 404 on
  non-owned ids, no existence leak).
- **k8s isolation** (poc-k8s-provided): per-user namespace + ResourceQuota
  (bounded blast radius) + NetworkPolicy default-deny (no cross-namespace
  traffic) + a least-privilege RoleBinding for remote's SA (no namespace
  create, scoped to the one namespace).
- **Secrets/PVCs**: already namespaced; per-user namespace makes them isolated.
- **Blast radius of a compromised control-plane**: limited to the namespaces it
  has RoleBindings in; it cannot create namespaces or escalate cluster-wide.

## Testing strategy
- **Unit (remote)**:
  - `Authenticator`: valid token → userId; expired/invalid/missing → 401;
    `REMOTE_AUTH=off` → `default` user.
  - `tenantNamespace`: deterministic, DNS-safe, `default → sentropic-remote`.
  - namespace-aware provisioner: provision/destroy target the passed namespace.
  - store partition: user A's `list` excludes B; B's `stop`/`get` on A's id → 404.
  - `TenantProvisioner` client against a mocked poc-k8s API (idempotent, cached).
- **e2e** (extends the docker/k3s session harness): two distinct users →
  each creates a session → assert **isolation** (user B's `ls` does not show
  A's session; B's `stop` of A's session is rejected/404).

## Migration / compatibility
- `REMOTE_AUTH=off` (default until rollout) preserves current single-namespace
  behavior: one `default` user, the existing `sentropic-remote` namespace, the
  `StubTenantProvisioner`. Existing CLI/operator-UI flows keep working unchanged.
- Enabling multi-tenant = set `REMOTE_AUTH` to a real adapter + point
  `TenantProvisioner` at poc-k8s. No user-facing CLI refactor required (the CLI
  gains an optional `remote config token <token>` / `REMOTE_TOKEN` env; absent
  in `off` mode).

## Sequencing (for the implementation plan)
1. `Authenticator` seam + middleware + `off`/bearer adapters + token plumbing
   in the CLI (`REMOTE_TOKEN`).
2. `tenantNamespace` + namespace-per-call provisioner refactor (no behavior
   change in `off` mode).
3. `TenantProvisioner` (stub + poc-k8s client) wired into create flow.
4. Store partitioning + authorization (404 on non-owned).
5. e2e two-user isolation test.

Each step is independently testable; `off` mode keeps everything green
throughout.
