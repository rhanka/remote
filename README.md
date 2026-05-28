# Sentropic Remote

Kubernetes-native orchestration for delegated CLI sessions.

Repository: `rhanka/remote` (codename was `remote-controle` during scaffold).

## Stack

- Backend: TypeScript control plane.
- Frontend: Svelte 5 operator UI.
- UI design system: `@sent-tech/components-svelte`.
- Workspace: npm monorepo.
- First runtime target: k3s, then Scaleway Kapsule, then GKE.

## Docs

- Initial brief: `docs/brief-as-is.md`
- Traceability: `docs/traceability/2026-05-09-intention-spec-decisions.md`
- Naming and packaging: `docs/decisions/2026-05-10-naming-and-packaging.md`
- MVP spec: `docs/superpowers/specs/2026-05-09-remote-controle-mvp-design.md`
- Protocol/events spec: `docs/superpowers/specs/2026-05-11-remote-protocol-events-design.md`
- Plan 0 scaffold: `docs/superpowers/plans/2026-05-09-remote-controle-plan-0-scaffold.md`
- Multi-tenant sessions spec: `docs/superpowers/specs/2026-05-27-multi-tenant-sessions-design.md`
- Multi-tenant sessions plan: `docs/superpowers/plans/2026-05-27-multi-tenant-sessions.md`
- Enabling multi-tenant auth (operator guide): `docs/multi-tenant-auth.md`

## Commands

```bash
corepack npm install
corepack npm run verify
```

This is an npm workspaces monorepo (`package-lock.json`); do not use pnpm/yarn/bun.
