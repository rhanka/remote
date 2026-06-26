# Spec Study — llm-gateway capitalization, account traceability, model routing

Statut : STUDY — 2026-06-26.

## Intent

`sentropic/llm-gateway` must become the durable LLM gateway product. `remote`
must remain a CLI activator/manager: start the gateway, enroll local secrets,
request a gateway session token, inject endpoint env into CLIs, and show
diagnostics. It must not remain the owner of provider routing, model routing,
account policy, or traceability.

The target shape is compatible with gateway products that expose a model
catalog and route models by policy, such as the Agent Gateway model surface.

## Current state

- `@sentropic/llm-gateway@0.2.0` is published and is now a remote dependency.
  It owns the reusable gateway/router/flow contracts and Codex transport
  helpers (`CODEX_RESPONSES_URL`, Codex request preparation, reasoning effort
  normalization).
- `remote llm-mesh` no longer launches `apps/llm-gateway/dist/index.js`.
  The live local gateway process is built as
  `packages/remote-cli/dist/llm-gateway-runtime/index.js`.
- The embedded remote runtime still owns the Claude-Code compatibility adapter
  that is not yet present as a drop-in package binary: `/v1/session`,
  deterministic `gw-v1-*` local tokens, sticky `sessionId -> accountId`,
  Anthropic `/v1/messages` compatibility over Codex OAuth, and emergency
  context trimming for 100% Claude Code sessions.
- `packages/remote-cli/src/llm-mesh.ts` owns local process management and a
  separate `~/.sentropic/llm-mesh.json` account file.
- `packages/remote-cli/src/account-pool.ts` owns another account pool with
  descriptors, separate token store, sticky bindings, quota state, and a local
  session log.
- This split works for emergency local activation, but it is not the right
  long-term boundary: account policy and traceability are duplicated or hidden
  behind `remote`.

## Product boundary

### llm-gateway / llm-mesh should own

- Account descriptor store and secret store abstraction.
- Provider transports: Anthropic API key, Claude Code OAuth transport when
  correctly implemented, Codex OAuth, OpenAI API key, later Gemini/Mistral.
- Session ledger: `gatewaySessionId`, client session id, workspace/profile,
  selected account, selected model, route reason, timestamps, health/failure
  events. No content and no raw tokens.
- Sticky binding policy and explicit rebind operations.
- Load balancing policy: round-robin, weighted, least-recently-used,
  quota-aware, health-aware, manual account override.
- Model catalog and routing table, exposed through `/v1/models` and used by
  `/v1/messages`.
- Audit API and local JSONL/DB sink for solo mode.

### remote should own

- Local activation: start/stop/status/logs for a headless gateway.
- Config plumbing: gateway URL, session id, token acquisition, env injection.
- CLI UX: `remote llm-mesh enable`, `remote resume --replace`, diagnostics.
- Secret enrollment helper for solo mode, but writing into gateway-owned stores.
- Displaying gateway-provided trace/account data, not recomputing it.

## Required invariants

- One gateway token maps to one gateway session identity.
- A session is sticky to its selected account unless an explicit rebind command
  is issued.
- Every session/account/model decision is observable by descriptor:
  account id, provider, label, model id, policy, reason, createdAt, lastUsedAt.
- Diagnostics never print raw provider tokens or gateway tokens.
- Load balancing is a policy at session acquisition by default. Per-request
  balancing is opt-in and only valid for stateless routes.
- Fallback that changes provider/account mid-conversation must be explicit or
  clearly recorded as a policy decision; silent intra-session fallback breaks
  auditability.

## Model routing

Claude Code can already pass non-Claude model strings through the gateway in
bare mode. Verified locally:

- `claude --bare --model gpt-5.5 -p ...` succeeds through the gateway.
- `claude --bare --model gpt-5.3-codex-spark -p ...` succeeds through the
  gateway.

This means the UI/CLI path can expose explicit gateway model ids. The gateway
still needs a real model catalog because the current OpenAI/Codex proxy maps
unknown model names to `gpt-5.5`.

Proposed model descriptor:

```json
{
  "id": "gpt-5.3-codex-spark",
  "provider": "codex",
  "upstreamModel": "gpt-5.3-codex-spark",
  "accountPool": "codex",
  "inputProtocol": "anthropic.messages",
  "outputProtocol": "anthropic.messages",
  "capabilities": ["streaming", "tools", "reasoning_effort"],
  "defaultPolicy": "round-robin"
}
```

`claude-opus-4-8` and `claude-sonnet-4-6` can remain compatibility aliases, but
they should be aliases in the model catalog, not hard-coded fake mappings.

Example target behavior:

- `claude --model claude-opus-4-8` -> Claude account pool when a real Claude
  upstream transport is available.
- `claude --model gpt-5.5` -> Codex/OpenAI account pool.
- `claude --model gpt-5.3-codex-spark` -> Codex account pool, Spark upstream.
- Later: `gemini-3.5-*` -> Gemini account pool, `mistral-*` -> Mistral pool.

## Concrete next slice

0. Publish the remaining embedded compatibility adapter upstream, or replace it
   with a package-provided runner that includes `/v1/session` and the Claude Code
   compatibility surface. Only then delete the legacy `apps/llm-gateway`
   workspace and image targets.
1. Move/merge `remote account` and `remote llm-mesh` account concepts into a
   gateway-owned account/session library, leaving `remote` as CLI front-end.
2. Add a gateway session ledger and expose:
   - `GET /v1/sessions`
   - `GET /v1/sessions/:id`
   - `GET /v1/accounts` descriptors only
   - `GET /v1/models`
3. Replace hard-coded model mapping with a model catalog:
   - aliases for Claude compatibility names;
   - explicit GPT/Codex model ids;
   - provider/account-pool route selection.
4. Add `remote llm-mesh status --sessions --models` that reads gateway APIs and
   shows session -> account -> model trace.
5. Keep `remote` runtime activation tests that prove stale parent env cannot
   leak into new Claude sessions.

## Open decisions

- Whether the first durable store is a local JSONL/JSON store or SQLite.
- Whether team mode uses gateway DB encryption immediately or keeps local solo
  mode first.
- Whether per-request fallback is ever allowed for interactive coding sessions,
  or only explicit session rebind.
- Exact Claude Code OAuth transport contract before re-enabling Claude OAuth as
  a gateway upstream account.
