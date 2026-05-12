# Sentropic Remote

Kubernetes-native orchestration for delegated CLI sessions.

Repository codename: `remote-controle`.

## Stack

- Backend: TypeScript control plane.
- Frontend: Svelte 5 operator UI.
- UI design system: `@sent-tech/components-svelte`.
- Workspace: pnpm monorepo.
- First runtime target: k3s, then Scaleway Kapsule, then GKE.

## Docs

- Initial brief: `docs/brief-as-is.md`
- Traceability: `docs/traceability/2026-05-09-intention-spec-decisions.md`
- Naming and packaging: `docs/decisions/2026-05-10-naming-and-packaging.md`
- MVP spec: `docs/superpowers/specs/2026-05-09-remote-controle-mvp-design.md`
- Plan 0 scaffold: `docs/superpowers/plans/2026-05-09-remote-controle-plan-0-scaffold.md`

## Commands

```bash
corepack enable pnpm
corepack pnpm install
corepack pnpm verify
```
