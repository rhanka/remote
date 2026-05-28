# Enabling multi-tenant authentication

Since v0.4.0 the control-plane is multi-tenant: each request authenticates to a
`userId`, resolves a per-user Kubernetes namespace, and every session/workspace
operation is scoped to that user. This is **opt-in** — the default
(`REMOTE_AUTH=off`) keeps the original single-namespace behavior with no token
and no config. See the design in
[`docs/superpowers/specs/2026-05-27-multi-tenant-sessions-design.md`](superpowers/specs/2026-05-27-multi-tenant-sessions-design.md).

## Modes at a glance

| `REMOTE_AUTH` | User identity | Namespace | Token required |
|---|---|---|---|
| `off` (default) | fixed `default` user | `sentropic-remote` | none |
| bearer (any other value) | JWT `sub` → `userId` | `user-<sha8(userId)>` | yes |

`default` always maps to the shared `sentropic-remote` namespace, so a
single-tenant deploy needs no tenant API.

## Control-plane env

| Variable | Purpose |
|---|---|
| `REMOTE_AUTH` | `off` disables auth (default). Any other value enables the bearer `Authenticator`. |
| `REMOTE_AUTH_SECRET` | HS256 shared secret to verify user JWTs (symmetric mode). |
| `REMOTE_AUTH_JWKS_URL` | JWKS endpoint to verify user JWTs (asymmetric / OIDC mode). |
| `REMOTE_AUTH_ISSUER` | Expected `iss` claim (optional). |
| `REMOTE_AUTH_USER_CLAIM` | Claim holding the user id (default `sub`). |
| `REMOTE_SESSION_TOKEN_SECRET` | HS256 secret the control-plane uses to **mint** per-session service tokens for session-agent callbacks. Falls back to `REMOTE_AUTH_SECRET`. **Required when using JWKS user auth** (the control-plane cannot mint asymmetric tokens). |
| `POC_K8S_TENANTS_URL` | If set, calls `POST {url}/tenants` to provision per-user namespaces (`PocK8sTenantProvisioner`). If unset, the `StubTenantProvisioner` is used and assumes namespaces already exist. |

### Session-agent service token (automatic)

When auth is enabled, the control-plane mints a short-lived JWT
(`sub: userId`, `sid: sessionId`, `aud: remote-session-agent`, 24h TTL) per
session and injects it into the session container as `REMOTE_TOKEN`. The
session-agent sends it as `Authorization: Bearer` on its callbacks (workspace
fetch/export, `cli-session`). The token is bound to its one session and scoped
to its owner — it cannot act on another session or another user.

> If `REMOTE_AUTH` is enabled but no session secret is resolvable, the
> control-plane logs a warning and the agent's callbacks will be rejected (401).
> Set `REMOTE_SESSION_TOKEN_SECRET` to avoid this — especially under JWKS.

## CLI

```sh
remote config token <jwt>     # persist a bearer token
REMOTE_TOKEN=<jwt> remote ls   # env wins over the stored token
```

The CLI sends `Authorization: Bearer` on every control-plane call when a token
is configured; in `off` mode no token is needed.

## Dependencies & caveats

- **poc-k8s tenant operator** (`POST /tenants`) is a sibling spec in the
  `poc-k8s` repo; until it exists, use `StubTenantProvisioner` (shared
  namespace) — real per-user namespace creation needs that operator and a
  least-privilege RoleBinding for the control-plane ServiceAccount.
- **sentropic OIDC**: a future `SentropicOIDCAuthenticator` will validate
  sentropic-issued JWTs; today use a generic signed bearer / OIDC IdP.
- **Token exposure**: `REMOTE_TOKEN` is currently injected as a plain container
  env var (pod env / docker `-e`), a wider surface than the auth bundle (mounted
  as a read-only Secret). Hardening this to a Secret/volume is tracked for a
  non-POC rollout.
