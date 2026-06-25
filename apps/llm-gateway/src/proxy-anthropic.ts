import type { Context } from "hono";
import { lookupToken } from "./sticky.js";
import { handleMessagesViaOpenAI } from "./proxy-openai.js";

const ANTHROPIC_BASE = process.env.ANTHROPIC_UPSTREAM_URL ?? "https://api.anthropic.com";

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

export async function handleMessages(c: Context): Promise<Response> {
  const auth = c.req.header("authorization") ?? "";
  const gatewayToken = auth.startsWith("Bearer gw-") ? auth.slice("Bearer ".length) : null;
  if (!gatewayToken) return c.json({ error: "unauthorized" }, 403);

  const session = await lookupToken(gatewayToken);
  if (!session) return c.json({ error: "unauthorized" }, 403);

  // Route to OpenAI/Codex path when the bound account is an OpenAI provider
  if (session.provider === "openai" || session.provider === "codex") {
    return handleMessagesViaOpenAI(c, {
      token: session.token,
      gatewayToken: session.gatewayToken,
      accountId: session.accountId,
    });
  }

  const upstreamUrl = `${ANTHROPIC_BASE}/v1/messages`;
  const body = await c.req.raw.arrayBuffer();

  const requestHeaders: Record<string, string> = {
    "x-api-key": session.token,
    "anthropic-version": c.req.header("anthropic-version") ?? "2023-06-01",
  };
  for (const h of PASSTHROUGH_REQUEST_HEADERS) {
    const v = c.req.header(h);
    if (v !== undefined) requestHeaders[h] = v;
  }

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
