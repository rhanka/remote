# Naming and packaging decision

Date: 2026-05-10

Status: accepted for the current planning branch

## Decision

The suite is named **Sentropic Remote** for product and documentation purposes.

The target npm package family is:

```text
@sentropic/remote-*
```

The existing GitHub repository may remain `rhanka/remote-controle` as the historical codename until a separate repository rename decision is made.

The current scaffold package manifests may remain temporarily under `@remote-controle/*`. They are private scaffold names and should be renamed only when the team is ready to publish or test publishing under the `@sentropic` npm scope.

## Rationale

`remote` is short, readable, and broad enough for the intended product: delegated control of remote CLI, code, ops, browser, approval, and 2FA sessions.

Under the `@sentropic` scope, `remote` is specific enough without adding awkward vocabulary such as `teleop` or overly narrow names such as `cliops`.

Keeping `remote-controle` as the repository codename avoids unnecessary churn while the scaffold branch is still being reviewed.

## Target package names

Initial package targets:

```text
@sentropic/remote-protocol
@sentropic/remote-control-plane
@sentropic/remote-session-agent
@sentropic/remote-k8s
@sentropic/remote-terminal
@sentropic/remote-browser
@sentropic/remote-approval
@sentropic/remote-secrets
@sentropic/remote-ui
```

The final names can still be refined before publication, but they should keep the common `@sentropic/remote-` prefix.

## Follow-up

- Confirm npm publishing access for `@sentropic`.
- Decide whether to rename the GitHub repository to `sentropic-remote`.
- Rename package manifests and workspace imports from `@remote-controle/*` to the final `@sentropic/remote-*` family in a dedicated change.
- Keep implementation plans explicit about whether they target temporary scaffold names or final publication names.
