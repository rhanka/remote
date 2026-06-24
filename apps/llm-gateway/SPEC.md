# llm-gateway — Architectural Specification

_Committed 2026-06-24. This is the raw demand + first architectural iteration._

---

## Context & motivation

Claude Code exhausts its Anthropic quota. The gateway must transparently fall back
to Codex (OpenAI) so work continues without reconfiguring every tool.

More broadly, `remote` orchestrates AI coding sessions for developers. It should:
- abstract the "which LLM provider is available right now" question away from CLIs
- let solo devs pool their own keys (multi-account, multi-provider)
- let teams share a gateway without exposing raw API keys to members
- eventually delegate all of this to the sentropic.sent-tech.ca control plane

---

## Three operating modes

### Mode 1 — Solo dev (local headless)

**Target**: one developer, one machine (or one k8s cluster they own).

- No auth, no enrollment UI
- Accounts configured via local config file or env vars
- Cross-provider fallback: `claude-code ↔ codex` (detect 429/quota → switch)
- Trace requests locally (`.claude/llm-mesh.log`, `.codex/llm-mesh.log`)
- CLI config: `remote llm-mesh start` → local proxy at `http://localhost:3002`
- `remote llm-mesh stop|status|logs`
- CLIs configured via `ANTHROPIC_BASE_URL=http://localhost:3002`
- Model map: `claude-opus-4-8/4-7 → gpt-5.5`, `claude-sonnet-4-6/4-5 → gpt-5.3-spark`
- Thinking budget → reasoning_effort: `xhigh (≥50k) → xhigh`, `high (≥25k) → high`,
  `med (≥8k) → medium`, `low (<8k) → low`

**Enrollment** (solo): plain local config file, CLI asks for keys on first run.
```
~/.config/sentropic/llm-mesh.json
{
  "accounts": [
    { "id": "claude-1", "provider": "anthropic", "label": "My Claude Max", "token": "sk-ant-..." },
    { "id": "codex-1", "provider": "openai",     "label": "My Codex",     "token": "sk-..." }
  ]
}
```

**Cross-provider routing**: `selectAccountWithFallback()` (already in remote-cli's
`account-pool.ts`) — picks primary, detects 429/overloaded, switches to fallback.
Provider pairs: `anthropic ↔ openai` (mirror logic in gateway, not just in CLI).

### Mode 2 — Team (shared gateway)

**Target**: a team of developers sharing costs/quotas.

- Auth: each team member authenticates with sentropic OIDC (or standalone JWT)
- Enrollment: each user **enrolls their OWN keys** — never shares raw credentials
  with teammates. The gateway stores `encrypt(token, per-user-key)`.
- Per-account usage tracking (tokens/requests/cost per enrolled account)
- Per-provider policy: e.g. "sonnet ok, opus not" / "gpt-5.3-spark ok, gpt-5.5 not"
- Multi-team: namespace isolation, one gateway serves N teams
- Sticky bindings: per-session account affinity (ConfigMap in k8s, or DB row)
- `remote` starts/manages the team gateway (k8s Deployment) or points to an external one

**Privacy invariants** (load-bearing):
- Raw tokens NEVER transit between team members
- Gateway reads its own encrypted store; member A cannot read member B's tokens
- Audit log: who requested what model at what time (no content)

### Mode 3 — Sentropic platform

**Target**: `sentropic.sent-tech.ca` integration.

- `remote` config: `llm_mesh_url = "https://llm.sent-tech.ca"` + JWT
- Workspace → account mapping: gateway receives `workspaceId`, maps to tenant pool
- No local gateway process; all requests proxied to sentropic's mesh
- `remote` surfaces usage metrics from the sentropic dashboard

---

## remote's role

`remote` is the launcher/manager for the gateway:

| Situation        | What remote does                                       |
|------------------|--------------------------------------------------------|
| Solo dev (local) | `remote llm-mesh start` → spawns local gateway process |
| Solo dev (k8s)   | deploys gateway as a sidecar pod in the cluster        |
| Team             | points to a shared team gateway; handles OIDC flow     |
| sentropic cloud  | no-op (cloud gateway handles everything)               |

CLIs (Claude Code, Codex) are auto-configured by `remote` to use the local/remote URL.

---

## MVP (immediate need — tonight)

**Goal**: Claude Code running on this machine uses the llm-gateway in mode 1,
so when Anthropic quota is exhausted, requests fall through to Codex.

**Minimum viable steps**:
1. `apps/llm-gateway` supports `provider: "openai"` accounts in `GATEWAY_ACCOUNTS`  ✓ (proxy-openai.ts + routing in proxy-anthropic.ts)
2. Model mapping + reasoning_effort translation  ✓ (proxy-openai.ts)
3. Run gateway locally: `GATEWAY_ACCOUNTS='[{"id":"c1","provider":"openai","label":"Codex","token":"<sk->"}]' node apps/llm-gateway/dist/index.js`
4. Obtain a `gw-xxx` token via `POST /v1/session { "sessionId": "local-dev" }`
5. Set `ANTHROPIC_BASE_URL=http://localhost:3001` + `ANTHROPIC_API_KEY=gw-xxx` in Claude Code

**What's missing for the full solo-dev UX**:
- `remote llm-mesh start` command (starts gateway, writes creds, configures CLIs)
- Auto-read local account config (instead of GATEWAY_ACCOUNTS env var)
- Quota detection + live cross-provider fallback (not just static routing)
- `remote llm-mesh status/logs`

---

## Format translation

See `apps/llm-gateway/src/proxy-openai.ts` for the implementation.

### Model mapping (overridable via `OPENAI_MODEL_MAP` env JSON)

| Anthropic            | OpenAI         | Notes              |
|----------------------|----------------|--------------------|
| claude-opus-4-8      | gpt-5.5        | most capable       |
| claude-opus-4-7      | gpt-5.5        |                    |
| claude-sonnet-4-6    | gpt-5.3-spark  | balanced           |
| claude-sonnet-4-5    | gpt-5.3-spark  |                    |
| claude-haiku-4-5-*   | gpt-5.3-spark  | fast/cheap         |

### thinking.budget_tokens → reasoning_effort

| budget_tokens | reasoning_effort | Claude tier |
|---------------|-----------------|-------------|
| ≥ 50 000      | xhigh           | xhigh       |
| ≥ 25 000      | high            | high        |
| ≥  8 000      | medium          | medium      |
| < 8 000       | low             | low         |

---

## Open questions / next iterations

1. **Cross-provider fallback in the gateway**: detect 429 from Anthropic → retry
   with OpenAI account (currently the CLI's `account-pool.ts` does this, but it
   lives in the wrong layer for a shared gateway).

2. **Token encryption for team mode**: envelope encryption per enrolled user.

3. **`remote llm-mesh start`**: which process manager? systemd user unit, or just
   a background process managed by remote's PID file?

4. **gpt-5.5 support for `reasoning_effort: "xhigh"`**: unconfirmed — may need
   to downgrade to "high" on error. The proxy passes it through; let the model reject
   and we'll catch and retry.

5. **Codex tool filtering**: codex config already disables `web_search` and
   `image_generation` when proxying through Claude (`web_search = "disabled"`).
   The inverse (Claude Code → Codex proxy) doesn't need filtering since Claude Code
   only sends standard Anthropic tools.

6. **Streaming**: `translateOpenAIStreamToAnthropic()` handles SSE. Needs
   end-to-end test (manually verified via curl; no automated test yet).
