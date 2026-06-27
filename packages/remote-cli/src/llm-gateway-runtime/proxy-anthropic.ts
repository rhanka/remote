import type { Context } from "hono";
import { markAccountExhausted, selectFallbackAccount } from "./accounts.js";
import {
  lookupToken,
  rebindGatewaySession,
  type SessionEntry,
} from "./sticky.js";
import { handleMessagesViaOpenAI } from "./proxy-openai.js";
import { resolveModelRoute, type RoutingTarget } from "./model-catalog.js";
import { recordSessionRequest } from "./session-ledger.js";

const ANTHROPIC_BASE =
  process.env.ANTHROPIC_UPSTREAM_URL ?? "https://api.anthropic.com";

const PASSTHROUGH_REQUEST_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
  "content-type",
] as const;

const PASSTHROUGH_RESPONSE_HEADERS = [
  "content-type",
  "transfer-encoding",
  "retry-after",
] as const;

function gatewayTokenFromRequest(c: Context): string | null {
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer gw-")) return auth.slice("Bearer ".length);

  const apiKey = c.req.header("x-api-key") ?? "";
  if (apiKey.startsWith("gw-")) return apiKey;

  return null;
}

function usesOpenAIProvider(provider: string): boolean {
  return provider === "openai" || provider === "codex";
}

function isQuotaFallbackResponse(response: Response): boolean {
  return response.status === 429;
}

function quotaReason(response: Response): string {
  return `upstream ${response.status}`;
}

async function rebindAfterQuotaResponse(
  gatewayToken: string,
  session: SessionEntry,
  response: Response,
  route?: RoutingTarget,
): Promise<SessionEntry | undefined> {
  markAccountExhausted(session.accountId, quotaReason(response));
  const fallback = selectFallbackAccount(session.accountId);
  if (!fallback) return undefined;

  let rebound: SessionEntry | undefined;
  try {
    rebound = await rebindGatewaySession(gatewayToken, fallback, route);
  } catch (err) {
    console.warn(
      `[llm-gateway] quota fallback rebind failed for ${session.accountId}: ${String(err)}`,
    );
    return undefined;
  }
  if (!rebound) return undefined;

  await response.body?.cancel().catch(() => {});
  console.warn(
    `[llm-gateway] account ${session.accountId} returned ${response.status}; ` +
      `rebinding session to ${fallback.id} (${fallback.provider})`,
  );
  return rebound;
}

async function handleMessagesViaAnthropic(
  c: Context,
  session: Pick<SessionEntry, "token">,
  body: ArrayBuffer,
): Promise<Response> {
  const upstreamUrl = `${ANTHROPIC_BASE}/v1/messages`;

  const requestHeaders: Record<string, string> = {
    "anthropic-version": c.req.header("anthropic-version") ?? "2023-06-01",
  };
  for (const h of PASSTHROUGH_REQUEST_HEADERS) {
    const v = c.req.header(h);
    if (v !== undefined) requestHeaders[h] = v;
  }
  requestHeaders["x-api-key"] = session.token;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: requestHeaders,
      body,
      // @ts-expect-error Node 18+ fetch supports duplex for streaming
      duplex: "half",
      signal: c.req.raw.signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    throw err;
  }

  const responseHeaders: Record<string, string> = {};
  for (const h of PASSTHROUGH_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v !== null) responseHeaders[h] = v;
  }

  // Pipe stream directly — never buffer
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

async function dispatchToSessionAccount(
  c: Context,
  session: SessionEntry,
  body: ArrayBuffer,
): Promise<Response> {
  if (usesOpenAIProvider(session.provider)) {
    return handleMessagesViaOpenAI(
      c,
      {
        token: session.token,
        gatewayToken: session.gatewayToken,
        accountId: session.accountId,
        sessionId: session.sessionId,
      },
      body,
    );
  }
  return handleMessagesViaAnthropic(c, session, body);
}

function routeFromRequestBody(body: ArrayBuffer): RoutingTarget | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      model?: unknown;
    };
    return typeof parsed.model === "string"
      ? resolveModelRoute(parsed.model)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function handleMessages(c: Context): Promise<Response> {
  const gatewayToken = gatewayTokenFromRequest(c);
  if (!gatewayToken) return c.json({ error: "unauthorized" }, 403);

  let session = await lookupToken(gatewayToken);
  if (!session) return c.json({ error: "unauthorized" }, 403);

  const body = await c.req.raw.arrayBuffer();
  const route = routeFromRequestBody(body);
  recordSessionRequest(session.sessionId, route);
  const attempted = new Set<string>();

  for (;;) {
    attempted.add(session.accountId);
    const response = await dispatchToSessionAccount(c, session, body);
    if (!isQuotaFallbackResponse(response)) return response;

    const rebound = await rebindAfterQuotaResponse(
      gatewayToken,
      session,
      response,
      route,
    );
    if (!rebound || attempted.has(rebound.accountId)) return response;
    session = rebound;
  }
}
