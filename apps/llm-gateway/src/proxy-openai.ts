/**
 * Anthropic Messages API → OpenAI Chat Completions proxy.
 *
 * Activated when the account's provider is "openai" or "codex". Translates
 * requests and responses between the two formats so Claude Code (which speaks
 * Anthropic) can transparently use OpenAI/Codex models.
 *
 * Model mapping (overridable via OPENAI_MODEL_MAP env JSON):
 *   claude-opus-4-8  / claude-opus-4-7  → gpt-5.5
 *   claude-sonnet-4-6 / claude-sonnet-4-5 → gpt-5.3-spark
 *   claude-haiku-*                        → gpt-5.3-spark
 *
 * Thinking budget_tokens → reasoning_effort:
 *   ≥ 25 000 (xhigh) → "high"
 *   ≥  8 000 (high)  → "medium"
 *   < 8 000 / none   → "low"
 */

import type { Context } from "hono";

const OPENAI_BASE =
  process.env.OPENAI_UPSTREAM_URL ?? "https://api.openai.com";

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-8": "gpt-5.5",
  "claude-opus-4-7": "gpt-5.5",
  "claude-opus-4-6": "gpt-5.5",
  "claude-sonnet-4-6": "gpt-5.3-spark",
  "claude-sonnet-4-5": "gpt-5.3-spark",
  "claude-haiku-4-5-20251001": "gpt-5.3-spark",
};

let _modelMap: Record<string, string> | null = null;
function modelMap(): Record<string, string> {
  if (!_modelMap) {
    _modelMap = process.env.OPENAI_MODEL_MAP
      ? { ...DEFAULT_MODEL_MAP, ...(JSON.parse(process.env.OPENAI_MODEL_MAP) as Record<string, string>) }
      : DEFAULT_MODEL_MAP;
  }
  return _modelMap;
}

export function mapModel(anthropicModel: string): string {
  return modelMap()[anthropicModel] ?? "gpt-5.5";
}

/**
 * Anthropic thinking budget_tokens → OpenAI reasoning_effort.
 * Covers all 4 Claude effort tiers:
 *   xhigh (≥ 50 k) → "xhigh" (pass-through; drop to "high" if model rejects)
 *   high  (≥ 25 k) → "high"
 *   med   (≥  8 k) → "medium"
 *   low   (<  8 k) → "low"
 */
export function budgetToEffort(
  budgetTokens: number,
): "xhigh" | "high" | "medium" | "low" {
  if (budgetTokens >= 50_000) return "xhigh";
  if (budgetTokens >= 25_000) return "high";
  if (budgetTokens >= 8_000) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Anthropic request types (minimal, non-exhaustive)
// ---------------------------------------------------------------------------

type AntTextBlock = { type: "text"; text: string };
type AntToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type AntToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AntTextBlock[];
};
type AntThinkingBlock = { type: "thinking"; thinking: string; signature?: string };
type AntContentBlock = AntTextBlock | AntToolUseBlock | AntToolResultBlock | AntThinkingBlock | { type: string };

type AntMessage = { role: "user" | "assistant"; content: string | AntContentBlock[] };
type AntTool = { name: string; description?: string; input_schema: Record<string, unknown> };

type AntRequest = {
  model: string;
  messages: AntMessage[];
  system?: string;
  max_tokens: number;
  tools?: AntTool[];
  stream?: boolean;
  thinking?: { type: "enabled"; budget_tokens: number } | { type: "disabled" };
};

// ---------------------------------------------------------------------------
// Request translation: Anthropic → OpenAI
// ---------------------------------------------------------------------------

type OAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<{ type: "text"; text: string }> }
  | { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

function extractAssistantContent(
  content: string | AntContentBlock[],
): { text: string | null; toolCalls: OAIToolCall[] } {
  if (typeof content === "string") return { text: content || null, toolCalls: [] };
  const texts: string[] = [];
  const toolCalls: OAIToolCall[] = [];
  for (const item of content) {
    if (item.type === "text") {
      texts.push((item as AntTextBlock).text);
    } else if (item.type === "tool_use") {
      const tc = item as AntToolUseBlock;
      toolCalls.push({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      });
    }
    // thinking blocks: dropped (OpenAI reasons internally)
  }
  return { text: texts.join("") || null, toolCalls };
}

function toOAIMessages(messages: AntMessage[]): OAIMessage[] {
  const result: OAIMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const { text, toolCalls } = extractAssistantContent(msg.content);
      const entry: OAIMessage = { role: "assistant", content: text };
      if (toolCalls.length > 0) (entry as { tool_calls?: OAIToolCall[] }).tool_calls = toolCalls;
      result.push(entry);
    } else {
      // user: may contain tool_result blocks
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "tool_result") {
            const tr = item as AntToolResultBlock;
            const c =
              typeof tr.content === "string"
                ? tr.content
                : (tr.content as AntTextBlock[]).map((b) => b.text).join("");
            result.push({ role: "tool", tool_call_id: tr.tool_use_id, content: c });
          }
        }
        const textItems = (msg.content as AntContentBlock[]).filter(
          (c): c is AntTextBlock => c.type === "text",
        );
        if (textItems.length > 0) {
          result.push({
            role: "user",
            content: textItems.map((t) => ({ type: "text" as const, text: t.text })),
          });
        }
      } else {
        result.push({ role: "user", content: msg.content });
      }
    }
  }
  return result;
}

export function toOpenAIRequest(body: AntRequest): Record<string, unknown> {
  const messages: OAIMessage[] = [];
  if (body.system) messages.push({ role: "system", content: body.system });
  messages.push(...toOAIMessages(body.messages));

  const req: Record<string, unknown> = {
    model: mapModel(body.model),
    messages,
    max_completion_tokens: body.max_tokens,
  };

  if (body.stream) {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }

  if (body.thinking?.type === "enabled") {
    req.reasoning_effort = budgetToEffort(body.thinking.budget_tokens);
  }

  if (body.tools && body.tools.length > 0) {
    req.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        parameters: t.input_schema,
      },
    }));
  }

  return req;
}

// ---------------------------------------------------------------------------
// Non-streaming response translation: OpenAI → Anthropic
// ---------------------------------------------------------------------------

type OAIResponse = {
  id: string;
  choices: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export function toAnthropicResponse(
  openai: OAIResponse,
  originalModel: string,
): Record<string, unknown> {
  const choice = openai.choices[0];
  const message = choice?.message;
  const content: unknown[] = [];

  if (message?.content) {
    content.push({ type: "text", text: message.content });
  }

  for (const tc of message?.tool_calls ?? []) {
    let input: unknown = {};
    try { input = JSON.parse(tc.function.arguments); } catch { /* leave empty */ }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }

  const stopReason =
    choice?.finish_reason === "tool_calls" ? "tool_use"
    : choice?.finish_reason === "length" ? "max_tokens"
    : "end_turn";

  return {
    id: openai.id ?? `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    content,
    model: originalModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens ?? 0,
      output_tokens: openai.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming translation: OpenAI SSE → Anthropic SSE
// ---------------------------------------------------------------------------

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type OAIStreamChunk = {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export function translateOpenAIStreamToAnthropic(
  openaiStream: ReadableStream<Uint8Array>,
  originalModel: string,
  messageId: string,
  estimatedInputTokens: number,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (s: string) => controller.enqueue(enc.encode(s));

      // Anthropic content block state
      let nextBlockIdx = 0;
      let textBlockIdx = -1;
      let textBlockOpen = false;
      // OpenAI tool_call index → Anthropic block index
      const toolBlockMap = new Map<number, number>();
      let outputTokens = 0;
      let stopReason = "end_turn";

      emit(sseEvent("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: originalModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
        },
      }));
      emit(sseEvent("ping", { type: "ping" }));

      const reader = openaiStream.getReader();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (raw === "[DONE]") {
              // Close any open blocks
              if (textBlockOpen) {
                emit(sseEvent("content_block_stop", { type: "content_block_stop", index: textBlockIdx }));
              }
              for (const [, blockIdx] of toolBlockMap) {
                emit(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIdx }));
              }
              emit(sseEvent("message_delta", {
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: outputTokens },
              }));
              emit(sseEvent("message_stop", { type: "message_stop" }));
              controller.close();
              return;
            }

            let chunk: OAIStreamChunk;
            try { chunk = JSON.parse(raw) as OAIStreamChunk; } catch { continue; }

            // Trailing usage (stream_options: {include_usage: true})
            if (chunk.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              stopReason =
                choice.finish_reason === "tool_calls" ? "tool_use"
                : choice.finish_reason === "length" ? "max_tokens"
                : "end_turn";
            }

            const delta = choice.delta;
            if (!delta) continue;

            // Text content
            if (typeof delta.content === "string" && delta.content.length > 0) {
              if (!textBlockOpen) {
                textBlockIdx = nextBlockIdx++;
                textBlockOpen = true;
                emit(sseEvent("content_block_start", {
                  type: "content_block_start",
                  index: textBlockIdx,
                  content_block: { type: "text", text: "" },
                }));
              }
              emit(sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: textBlockIdx,
                delta: { type: "text_delta", text: delta.content },
              }));
            }

            // Tool calls
            for (const tc of delta.tool_calls ?? []) {
              // Close text block when tool calls start
              if (textBlockOpen) {
                emit(sseEvent("content_block_stop", { type: "content_block_stop", index: textBlockIdx }));
                textBlockOpen = false;
              }

              if (!toolBlockMap.has(tc.index)) {
                const blockIdx = nextBlockIdx++;
                toolBlockMap.set(tc.index, blockIdx);
                emit(sseEvent("content_block_start", {
                  type: "content_block_start",
                  index: blockIdx,
                  content_block: {
                    type: "tool_use",
                    id: tc.id ?? `toolu_${tc.index}`,
                    name: tc.function?.name ?? "",
                    input: {},
                  },
                }));
              }

              const blockIdx = toolBlockMap.get(tc.index)!;
              if (tc.function?.arguments) {
                emit(sseEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIdx,
                  delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                }));
              }
            }
          }
        }
        // Stream ended without [DONE] — close gracefully
        if (textBlockOpen) {
          emit(sseEvent("content_block_stop", { type: "content_block_stop", index: textBlockIdx }));
        }
        for (const [, blockIdx] of toolBlockMap) {
          emit(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIdx }));
        }
        emit(sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }));
        emit(sseEvent("message_stop", { type: "message_stop" }));
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleMessagesViaOpenAI(
  c: Context,
  session: { token: string },
): Promise<Response> {
  const rawBody = await c.req.arrayBuffer();
  let body: AntRequest;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody)) as AntRequest;
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  const originalModel = body.model;
  const openaiReq = toOpenAIRequest(body);
  const messageId = `msg_${Date.now().toString(36)}`;
  const estimatedInputTokens = Math.ceil(JSON.stringify(body.messages).length / 4);

  let upstream: Response;
  try {
    upstream = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(openaiReq),
      // @ts-expect-error Node 18+ supports duplex for streaming
      duplex: "half",
      signal: c.req.raw.signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") return new Response(null, { status: 499 });
    throw err;
  }

  if (!upstream.ok) {
    const errBody = await upstream.text();
    return new Response(errBody, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (body.stream && upstream.body) {
    const stream = translateOpenAIStreamToAnthropic(
      upstream.body,
      originalModel,
      messageId,
      estimatedInputTokens,
    );
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  const openaiResp = (await upstream.json()) as OAIResponse;
  return c.json(toAnthropicResponse(openaiResp, originalModel));
}
