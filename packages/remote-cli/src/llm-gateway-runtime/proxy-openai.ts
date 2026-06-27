/**
 * Anthropic Messages API → OpenAI Chat Completions proxy.
 *
 * Activated when the account's provider is "openai" or "codex". Translates
 * requests and responses between the two formats so Claude Code (which speaks
 * Anthropic) can transparently use OpenAI/Codex models.
 *
 * Model mapping (overridable via OPENAI_MODEL_MAP env JSON):
 *   claude-opus-4-8  / claude-opus-4-7  → gpt-5.5
 *   claude-sonnet-4-6 / claude-sonnet-4-5 → gpt-5.5
 *   claude-haiku-*                        → gpt-5.5
 *
 * Thinking budget_tokens → reasoning_effort:
 *   ≥ 25 000 (xhigh) → "high"
 *   ≥  8 000 (high)  → "medium"
 *   < 8 000 / none   → "low"
 */

import type { Context } from "hono";
import {
  CODEX_RESPONSES_URL,
  mapCodexReasoningEffort,
  prepareCodexResponsesRequest,
  type CodexResponsesRequestInput,
} from "@sentropic/llm-gateway";
import { refreshOAuthToken } from "./accounts.js";
import { updateSessionToken } from "./sticky.js";
import { routeModelOrThrow } from "./model-catalog.js";
import { recordSessionRequest } from "./session-ledger.js";

const OPENAI_BASE = process.env.OPENAI_UPSTREAM_URL ?? "https://api.openai.com";

const DEFAULT_CODEX_MAX_INPUT_CHARS = 200_000;
const CODEX_CONTEXT_TRUNCATION_NOTICE =
  "[llm-gateway: older Claude Code transcript omitted to fit the Codex upstream context window.]";

/** True if token is a ChatGPT Pro OAuth JWT (3-part base64url), not an sk-... API key. */
function isCodexOAuthToken(token: string): boolean {
  return !token.startsWith("sk-") && token.split(".").length === 3;
}

const TRANSIENT_UPSTREAM_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const UPSTREAM_RETRY_DELAYS_MS =
  process.env.NODE_ENV === "test" ? [0, 0] : [250, 1000];

function abortError(err: unknown): boolean {
  return (err as { name?: string }).name === "AbortError";
}

function upstreamErrorCause(
  err: unknown,
): { code?: string; hostname?: string } | undefined {
  const candidate = err as {
    code?: string;
    hostname?: string;
    cause?: { code?: string; hostname?: string };
  };
  if (candidate.code || candidate.hostname) return candidate;
  return candidate.cause;
}

function upstreamFetchErrorMessage(err: unknown): string {
  const cause = upstreamErrorCause(err);
  if (cause?.code && cause.hostname) return `${cause.code} ${cause.hostname}`;
  if (cause?.code) return cause.code;
  if (err instanceof Error && err.message) return err.message;
  return "unknown upstream fetch error";
}

function isTransientUpstreamError(err: unknown): boolean {
  const code = upstreamErrorCause(err)?.code;
  return !!code && TRANSIENT_UPSTREAM_ERROR_CODES.has(code);
}

function anthropicGatewayError(message: string): {
  type: "error";
  error: { type: "api_error"; message: string };
} {
  return { type: "error", error: { type: "api_error", message } };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchUpstreamWithRetry(
  fetcher: () => Promise<Response>,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetcher();
    } catch (err) {
      if (
        abortError(err) ||
        !isTransientUpstreamError(err) ||
        attempt >= UPSTREAM_RETRY_DELAYS_MS.length
      ) {
        throw err;
      }
      await sleep(UPSTREAM_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Model mapping
// ---------------------------------------------------------------------------

export function mapModel(anthropicModel: string): string {
  return routeModelOrThrow(anthropicModel).upstreamModel ?? anthropicModel;
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
type AntToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
type AntToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AntTextBlock[];
};
type AntThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};
type AntContentBlock =
  | AntTextBlock
  | AntToolUseBlock
  | AntToolResultBlock
  | AntThinkingBlock
  | { type: string };

type AntMessage = {
  role: "user" | "assistant";
  content: string | AntContentBlock[];
};
type AntTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

type AntRequest = {
  model: string;
  messages: AntMessage[];
  system?: string | AntContentBlock[];
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

function extractAssistantContent(content: string | AntContentBlock[]): {
  text: string | null;
  toolCalls: OAIToolCall[];
} {
  if (typeof content === "string")
    return { text: content || null, toolCalls: [] };
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
      if (toolCalls.length > 0)
        (entry as { tool_calls?: OAIToolCall[] }).tool_calls = toolCalls;
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
            result.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: c,
            });
          }
        }
        const textItems = (msg.content as AntContentBlock[]).filter(
          (c): c is AntTextBlock => c.type === "text",
        );
        if (textItems.length > 0) {
          result.push({
            role: "user",
            content: textItems.map((t) => ({
              type: "text" as const,
              text: t.text,
            })),
          });
        }
      } else {
        result.push({ role: "user", content: msg.content });
      }
    }
  }
  return result;
}

function systemToText(system: AntRequest["system"]): string | undefined {
  if (typeof system === "string") return system || undefined;
  if (!Array.isArray(system)) return undefined;

  const parts: string[] = [];
  for (const block of system) {
    if (block.type === "text") {
      parts.push((block as AntTextBlock).text);
    }
  }
  return parts.join("\n\n") || undefined;
}

// ---------------------------------------------------------------------------
// Request translation: Anthropic → OpenAI Responses API (Codex OAuth path)
// ---------------------------------------------------------------------------

function toCodexInput(messages: AntMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const texts: string[] = [];
      const toolCalls: AntToolUseBlock[] = [];
      if (typeof msg.content === "string") {
        if (msg.content) texts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") texts.push((block as AntTextBlock).text);
          else if (block.type === "tool_use")
            toolCalls.push(block as AntToolUseBlock);
          // thinking blocks: skip
        }
      }
      const text = texts.join("");
      if (text || toolCalls.length === 0) {
        items.push({ type: "message", role: "assistant", content: text });
      }
      for (const tc of toolCalls) {
        items.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        });
      }
    } else {
      const texts: string[] = [];
      const toolResults: AntToolResultBlock[] = [];
      if (typeof msg.content === "string") {
        if (msg.content) texts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") texts.push((block as AntTextBlock).text);
          else if (block.type === "tool_result")
            toolResults.push(block as AntToolResultBlock);
        }
      }
      for (const tr of toolResults) {
        const output =
          typeof tr.content === "string"
            ? tr.content
            : (tr.content as AntTextBlock[]).map((b) => b.text).join("");
        items.push({
          type: "function_call_output",
          call_id: tr.tool_use_id,
          output,
        });
      }
      const text = texts.join("");
      if (text) items.push({ type: "message", role: "user", content: text });
    }
  }
  return items;
}

function codexEffort(budgetTokens: number): string {
  return mapCodexReasoningEffort(budgetToEffort(budgetTokens)) ?? "low";
}

export function toCodexRequest(body: AntRequest): Record<string, unknown> {
  const req: Record<string, unknown> = {
    model: mapModel(body.model),
    input: toCodexInput(body.messages),
    store: false,
    stream: true,
  };

  const instructions = systemToText(body.system);
  if (instructions) req.instructions = instructions;

  if (body.thinking?.type === "enabled") {
    req.reasoning = { effort: codexEffort(body.thinking.budget_tokens) };
  }

  if (body.tools && body.tools.length > 0) {
    req.tools = body.tools.map((t) => ({
      type: "function",
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: t.input_schema,
      strict: false,
    }));
  }

  return req;
}

function codexMaxInputChars(): number {
  const configured = Number.parseInt(
    process.env.CODEX_MAX_INPUT_CHARS ?? "",
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CODEX_MAX_INPUT_CHARS;
}

function anthropicInputChars(body: AntRequest): number {
  return JSON.stringify({ system: body.system, messages: body.messages })
    .length;
}

function trimTextTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= CODEX_CONTEXT_TRUNCATION_NOTICE.length + 8) {
    return CODEX_CONTEXT_TRUNCATION_NOTICE.slice(0, Math.max(0, budget));
  }
  const prefix = `${CODEX_CONTEXT_TRUNCATION_NOTICE}\n\n`;
  return prefix + text.slice(-(budget - prefix.length));
}

function trimContentTail(
  content: string | AntContentBlock[],
  budget: number,
): string | AntContentBlock[] {
  if (typeof content === "string") return trimTextTail(content, budget);

  const kept: AntContentBlock[] = [];
  let remaining = budget;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i]!;
    const size = JSON.stringify(block).length;
    if (size <= remaining) {
      kept.unshift(block);
      remaining -= size;
      continue;
    }
    if (
      block.type === "text" &&
      remaining > CODEX_CONTEXT_TRUNCATION_NOTICE.length + 32
    ) {
      kept.unshift({
        ...block,
        text: trimTextTail((block as AntTextBlock).text, remaining),
      } as AntTextBlock);
    }
    break;
  }
  return kept.length > 0
    ? kept
    : [{ type: "text", text: CODEX_CONTEXT_TRUNCATION_NOTICE }];
}

function stripLeadingOrphanToolResults(messages: AntMessage[]): AntMessage[] {
  if (messages.length === 0) return messages;
  const first = messages[0]!;
  if (first.role !== "user" || !Array.isArray(first.content)) return messages;

  const filtered = first.content.filter(
    (block) => block.type !== "tool_result",
  );
  if (filtered.length === first.content.length) return messages;
  if (filtered.length === 0) return messages.slice(1);
  return [{ ...first, content: filtered }, ...messages.slice(1)];
}

export function trimCodexBodyForContext(
  body: AntRequest,
  maxChars = codexMaxInputChars(),
): {
  body: AntRequest;
  trimmed: boolean;
  beforeChars: number;
  afterChars: number;
} {
  const beforeChars = anthropicInputChars(body);
  if (beforeChars <= maxChars) {
    return { body, trimmed: false, beforeChars, afterChars: beforeChars };
  }

  const notice: AntMessage = {
    role: "user",
    content: CODEX_CONTEXT_TRUNCATION_NOTICE,
  };
  const systemChars = JSON.stringify(body.system ?? "").length;
  const noticeChars = JSON.stringify(notice).length;
  let remaining = Math.max(1024, maxChars - systemChars - noticeChars);
  const kept: AntMessage[] = [];

  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const message = body.messages[i]!;
    const messageChars = JSON.stringify(message).length;
    if (messageChars <= remaining) {
      kept.unshift(message);
      remaining -= messageChars;
      continue;
    }
    if (kept.length === 0 && remaining > 1024) {
      kept.unshift({
        ...message,
        content: trimContentTail(message.content, remaining),
      });
    }
    break;
  }

  const trimmedMessages = stripLeadingOrphanToolResults(kept);
  const trimmedBody: AntRequest = {
    ...body,
    messages: [notice, ...trimmedMessages],
  };
  const afterChars = anthropicInputChars(trimmedBody);
  return { body: trimmedBody, trimmed: true, beforeChars, afterChars };
}

// ---------------------------------------------------------------------------
// Request translation: Anthropic → OpenAI Chat Completions (standard sk- key)
// ---------------------------------------------------------------------------

export function toOpenAIRequest(body: AntRequest): Record<string, unknown> {
  const messages: OAIMessage[] = [];
  const system = systemToText(body.system);
  if (system) messages.push({ role: "system", content: system });
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
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      /* leave empty */
    }
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input,
    });
  }

  const stopReason =
    choice?.finish_reason === "tool_calls"
      ? "tool_use"
      : choice?.finish_reason === "length"
        ? "max_tokens"
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

function closeStreamWithGatewayError(
  controller: ReadableStreamDefaultController<Uint8Array>,
  enc: TextEncoder,
  message: string,
): void {
  try {
    controller.enqueue(
      enc.encode(sseEvent("error", anthropicGatewayError(message))),
    );
  } catch {
    // The downstream client may already be gone.
  }
  try {
    controller.close();
  } catch {
    // The stream may already be closed or errored.
  }
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

      emit(
        sseEvent("message_start", {
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
        }),
      );
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
                emit(
                  sseEvent("content_block_stop", {
                    type: "content_block_stop",
                    index: textBlockIdx,
                  }),
                );
              }
              for (const [, blockIdx] of toolBlockMap) {
                emit(
                  sseEvent("content_block_stop", {
                    type: "content_block_stop",
                    index: blockIdx,
                  }),
                );
              }
              emit(
                sseEvent("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: stopReason, stop_sequence: null },
                  usage: { output_tokens: outputTokens },
                }),
              );
              emit(sseEvent("message_stop", { type: "message_stop" }));
              controller.close();
              return;
            }

            let chunk: OAIStreamChunk;
            try {
              chunk = JSON.parse(raw) as OAIStreamChunk;
            } catch {
              continue;
            }

            // Trailing usage (stream_options: {include_usage: true})
            if (chunk.usage?.completion_tokens)
              outputTokens = chunk.usage.completion_tokens;

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              stopReason =
                choice.finish_reason === "tool_calls"
                  ? "tool_use"
                  : choice.finish_reason === "length"
                    ? "max_tokens"
                    : "end_turn";
            }

            const delta = choice.delta;
            if (!delta) continue;

            // Text content
            if (typeof delta.content === "string" && delta.content.length > 0) {
              if (!textBlockOpen) {
                textBlockIdx = nextBlockIdx++;
                textBlockOpen = true;
                emit(
                  sseEvent("content_block_start", {
                    type: "content_block_start",
                    index: textBlockIdx,
                    content_block: { type: "text", text: "" },
                  }),
                );
              }
              emit(
                sseEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: textBlockIdx,
                  delta: { type: "text_delta", text: delta.content },
                }),
              );
            }

            // Tool calls
            for (const tc of delta.tool_calls ?? []) {
              // Close text block when tool calls start
              if (textBlockOpen) {
                emit(
                  sseEvent("content_block_stop", {
                    type: "content_block_stop",
                    index: textBlockIdx,
                  }),
                );
                textBlockOpen = false;
              }

              if (!toolBlockMap.has(tc.index)) {
                const blockIdx = nextBlockIdx++;
                toolBlockMap.set(tc.index, blockIdx);
                emit(
                  sseEvent("content_block_start", {
                    type: "content_block_start",
                    index: blockIdx,
                    content_block: {
                      type: "tool_use",
                      id: tc.id ?? `toolu_${tc.index}`,
                      name: tc.function?.name ?? "",
                      input: {},
                    },
                  }),
                );
              }

              const blockIdx = toolBlockMap.get(tc.index)!;
              if (tc.function?.arguments) {
                emit(
                  sseEvent("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIdx,
                    delta: {
                      type: "input_json_delta",
                      partial_json: tc.function.arguments,
                    },
                  }),
                );
              }
            }
          }
        }
        // Stream ended without [DONE] — close gracefully
        if (textBlockOpen) {
          emit(
            sseEvent("content_block_stop", {
              type: "content_block_stop",
              index: textBlockIdx,
            }),
          );
        }
        for (const [, blockIdx] of toolBlockMap) {
          emit(
            sseEvent("content_block_stop", {
              type: "content_block_stop",
              index: blockIdx,
            }),
          );
        }
        emit(
          sseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
          }),
        );
        emit(sseEvent("message_stop", { type: "message_stop" }));
        controller.close();
      } catch (err) {
        closeStreamWithGatewayError(
          controller,
          enc,
          `Upstream stream failed: ${upstreamFetchErrorMessage(err)}`,
        );
      } finally {
        reader.releaseLock();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Streaming translation: Codex Responses API SSE → Anthropic SSE
// ---------------------------------------------------------------------------

export function translateCodexStreamToAnthropic(
  codexStream: ReadableStream<Uint8Array>,
  originalModel: string,
  messageId: string,
  estimatedInputTokens: number,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (s: string) => controller.enqueue(enc.encode(s));

      let nextBlockIdx = 0;
      // output_index → {type, idx}
      const blockMap = new Map<
        number,
        { type: "text" | "tool"; idx: number }
      >();
      let textBlockOpen = false;
      let outputTokens = 0;
      let stopReason = "end_turn";

      emit(
        sseEvent("message_start", {
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
        }),
      );
      emit(sseEvent("ping", { type: "ping" }));

      const reader = codexStream.getReader();
      let buf = "";
      let currentEvent = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
              continue;
            }
            if (!line.startsWith("data: ")) {
              if (line === "") currentEvent = "";
              continue;
            }
            const raw = line.slice(6).trim();
            if (raw === "[DONE]") continue;

            let data: Record<string, unknown>;
            try {
              data = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              continue;
            }

            const evType = (data.type as string | undefined) ?? currentEvent;
            const outputIndex = (data.output_index as number | undefined) ?? 0;

            switch (evType) {
              case "response.output_item.added": {
                const item = data.item as Record<string, unknown> | undefined;
                if (!item) break;
                if (item.type === "function_call") {
                  const blockIdx = nextBlockIdx++;
                  blockMap.set(outputIndex, { type: "tool", idx: blockIdx });
                  emit(
                    sseEvent("content_block_start", {
                      type: "content_block_start",
                      index: blockIdx,
                      content_block: {
                        type: "tool_use",
                        id:
                          (item.call_id as string | undefined) ??
                          `toolu_${outputIndex}`,
                        name: (item.name as string | undefined) ?? "",
                        input: {},
                      },
                    }),
                  );
                }
                break;
              }

              case "response.output_text.delta": {
                const delta = data.delta as string | undefined;
                if (!delta) break;
                if (!blockMap.has(outputIndex)) {
                  const blockIdx = nextBlockIdx++;
                  blockMap.set(outputIndex, { type: "text", idx: blockIdx });
                  textBlockOpen = true;
                  emit(
                    sseEvent("content_block_start", {
                      type: "content_block_start",
                      index: blockIdx,
                      content_block: { type: "text", text: "" },
                    }),
                  );
                }
                const tBlock = blockMap.get(outputIndex)!;
                emit(
                  sseEvent("content_block_delta", {
                    type: "content_block_delta",
                    index: tBlock.idx,
                    delta: { type: "text_delta", text: delta },
                  }),
                );
                break;
              }

              case "response.function_call_arguments.delta": {
                const delta = data.delta as string | undefined;
                if (!delta) break;
                const fBlock = blockMap.get(outputIndex);
                if (fBlock?.type === "tool") {
                  emit(
                    sseEvent("content_block_delta", {
                      type: "content_block_delta",
                      index: fBlock.idx,
                      delta: { type: "input_json_delta", partial_json: delta },
                    }),
                  );
                }
                break;
              }

              case "response.output_item.done": {
                const block = blockMap.get(outputIndex);
                if (block) {
                  emit(
                    sseEvent("content_block_stop", {
                      type: "content_block_stop",
                      index: block.idx,
                    }),
                  );
                  if (block.type === "text") textBlockOpen = false;
                }
                const item = data.item as Record<string, unknown> | undefined;
                if (item?.type === "function_call") stopReason = "tool_use";
                break;
              }

              case "response.completed": {
                const response = data.response as
                  | Record<string, unknown>
                  | undefined;
                const usage = response?.usage as
                  | Record<string, unknown>
                  | undefined;
                if (typeof usage?.output_tokens === "number")
                  outputTokens = usage.output_tokens;
                // Close any unclosed blocks (shouldn't happen but be safe)
                for (const [, block] of blockMap) {
                  if (block.type === "text" && textBlockOpen) {
                    emit(
                      sseEvent("content_block_stop", {
                        type: "content_block_stop",
                        index: block.idx,
                      }),
                    );
                    textBlockOpen = false;
                  }
                }
                emit(
                  sseEvent("message_delta", {
                    type: "message_delta",
                    delta: { stop_reason: stopReason, stop_sequence: null },
                    usage: { output_tokens: outputTokens },
                  }),
                );
                emit(sseEvent("message_stop", { type: "message_stop" }));
                controller.close();
                return;
              }

              case "response.failed": {
                emit(
                  sseEvent("error", {
                    type: "error",
                    error: {
                      type: "api_error",
                      message: codexFailureMessage(data),
                    },
                  }),
                );
                controller.close();
                return;
              }
            }
          }
        }
        // Stream ended without response.completed — close gracefully
        if (textBlockOpen) {
          for (const [, block] of blockMap) {
            if (block.type === "text") {
              emit(
                sseEvent("content_block_stop", {
                  type: "content_block_stop",
                  index: block.idx,
                }),
              );
            }
          }
        }
        for (const [, block] of blockMap) {
          if (block.type === "tool") {
            emit(
              sseEvent("content_block_stop", {
                type: "content_block_stop",
                index: block.idx,
              }),
            );
          }
        }
        emit(
          sseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
          }),
        );
        emit(sseEvent("message_stop", { type: "message_stop" }));
        controller.close();
      } catch (err) {
        closeStreamWithGatewayError(
          controller,
          enc,
          `Upstream stream failed: ${upstreamFetchErrorMessage(err)}`,
        );
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function codexFailureMessage(data: Record<string, unknown>): string {
  const response = data.response as Record<string, unknown> | undefined;
  const error =
    (data.error as Record<string, unknown> | undefined) ??
    (response?.error as Record<string, unknown> | undefined);
  const message = error?.message ?? error?.code ?? response?.status;
  return typeof message === "string" && message
    ? message
    : "Codex upstream response failed";
}

export async function codexStreamToAnthropicResponse(
  codexStream: ReadableStream<Uint8Array>,
  originalModel: string,
  messageId: string,
  estimatedInputTokens: number,
): Promise<Record<string, unknown>> {
  type Block =
    | { type: "text"; idx: number; text: string }
    | { type: "tool"; idx: number; id: string; name: string; args: string };

  const reader = codexStream.getReader();
  const blockMap = new Map<number, Block>();
  let nextBlockIdx = 0;
  let outputTokens = 0;
  let buf = "";
  let currentEvent = "";

  const ensureTextBlock = (
    outputIndex: number,
  ): Extract<Block, { type: "text" }> => {
    const existing = blockMap.get(outputIndex);
    if (existing?.type === "text") return existing;
    const block: Extract<Block, { type: "text" }> = {
      type: "text",
      idx: nextBlockIdx++,
      text: "",
    };
    blockMap.set(outputIndex, block);
    return block;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith("data: ")) {
          if (line === "") currentEvent = "";
          continue;
        }

        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }

        const evType = (data.type as string | undefined) ?? currentEvent;
        const outputIndex = (data.output_index as number | undefined) ?? 0;

        switch (evType) {
          case "response.output_item.added": {
            const item = data.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
              blockMap.set(outputIndex, {
                type: "tool",
                idx: nextBlockIdx++,
                id:
                  (item.call_id as string | undefined) ??
                  `toolu_${outputIndex}`,
                name: (item.name as string | undefined) ?? "",
                args: "",
              });
            }
            break;
          }

          case "response.output_text.delta": {
            const delta = data.delta as string | undefined;
            if (delta) ensureTextBlock(outputIndex).text += delta;
            break;
          }

          case "response.output_text.done": {
            const text = data.text as string | undefined;
            if (text !== undefined) ensureTextBlock(outputIndex).text = text;
            break;
          }

          case "response.function_call_arguments.delta": {
            const delta = data.delta as string | undefined;
            const block = blockMap.get(outputIndex);
            if (delta && block?.type === "tool") block.args += delta;
            break;
          }

          case "response.output_item.done": {
            const item = data.item as Record<string, unknown> | undefined;
            const block = blockMap.get(outputIndex);
            if (item?.type === "function_call" && block?.type === "tool") {
              if (typeof item.call_id === "string") block.id = item.call_id;
              if (typeof item.name === "string") block.name = item.name;
              if (typeof item.arguments === "string")
                block.args = item.arguments;
            }
            break;
          }

          case "response.completed": {
            const response = data.response as
              | Record<string, unknown>
              | undefined;
            const usage = response?.usage as
              | Record<string, unknown>
              | undefined;
            if (typeof usage?.output_tokens === "number")
              outputTokens = usage.output_tokens;
            break;
          }

          case "response.failed":
            throw new Error(codexFailureMessage(data));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const content = [...blockMap.values()]
    .sort((a, b) => a.idx - b.idx)
    .map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      let input: unknown = {};
      try {
        input = block.args ? JSON.parse(block.args) : {};
      } catch {
        input = {};
      }
      return { type: "tool_use", id: block.id, name: block.name, input };
    });

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    content,
    model: originalModel,
    stop_reason: content.some((block) => block.type === "tool_use")
      ? "tool_use"
      : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: estimatedInputTokens, output_tokens: outputTokens },
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleMessagesViaOpenAI(
  c: Context,
  session: {
    token: string;
    gatewayToken?: string;
    accountId?: string;
    sessionId?: string;
  },
  requestBody?: ArrayBuffer,
): Promise<Response> {
  const rawBody = requestBody ?? (await c.req.arrayBuffer());
  let body: AntRequest;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody)) as AntRequest;
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  const originalModel = body.model;
  let route;
  try {
    route = routeModelOrThrow(originalModel);
  } catch (err) {
    return c.json(
      anthropicGatewayError(err instanceof Error ? err.message : String(err)),
      400,
    );
  }
  recordSessionRequest(session.sessionId, route);

  const isCodex = isCodexOAuthToken(session.token);
  const codexContext = isCodex ? trimCodexBodyForContext(body) : null;
  const upstreamBody = codexContext?.body ?? body;
  if (codexContext?.trimmed) {
    console.warn(
      `[llm-gateway] Codex context trimmed for ${originalModel}: ` +
        `${codexContext.beforeChars} -> ${codexContext.afterChars} chars`,
    );
  }
  const upstreamReq = isCodex
    ? toCodexRequest(upstreamBody)
    : toOpenAIRequest(upstreamBody);
  const messageId = `msg_${Date.now().toString(36)}`;
  const estimatedInputTokens = Math.ceil(
    JSON.stringify(upstreamBody.messages).length / 4,
  );

  const doFetch = (token: string) => {
    if (isCodex) {
      const codexRequest = prepareCodexResponsesRequest(
        upstreamReq as CodexResponsesRequestInput,
      );
      return fetch(codexRequest.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          originator: "opencode",
          "User-Agent": "opencode/0.1.0",
          session_id: `codex_${Date.now().toString(36)}`,
        },
        body: JSON.stringify(codexRequest.body),
        // @ts-expect-error Node 18+ supports duplex for streaming
        duplex: "half",
        signal: c.req.raw.signal,
      });
    }
    return fetch(`${OPENAI_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(upstreamReq),
      // @ts-expect-error Node 18+ supports duplex for streaming
      duplex: "half",
      signal: c.req.raw.signal,
    });
  };

  let upstream: Response;
  try {
    upstream = await fetchUpstreamWithRetry(() => doFetch(session.token));
  } catch (err) {
    if (abortError(err)) return new Response(null, { status: 499 });
    return c.json(
      anthropicGatewayError(
        `Upstream fetch failed: ${upstreamFetchErrorMessage(err)}`,
      ),
      502,
    );
  }

  // 401 → attempt OAuth token refresh + retry once
  if (upstream.status === 401 && session.accountId) {
    await upstream.body?.cancel().catch(() => {});
    const newToken = await refreshOAuthToken(session.accountId);
    if (newToken) {
      if (session.gatewayToken)
        updateSessionToken(session.gatewayToken, newToken);
      try {
        upstream = await fetchUpstreamWithRetry(() => doFetch(newToken));
      } catch (err) {
        if (abortError(err)) return new Response(null, { status: 499 });
        return c.json(
          anthropicGatewayError(
            `Upstream fetch failed: ${upstreamFetchErrorMessage(err)}`,
          ),
          502,
        );
      }
    }
  }

  if (!upstream.ok) {
    const errBody = await upstream.text();
    return new Response(errBody, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  }

  if (body.stream && isCodex && upstream.body) {
    const stream = translateCodexStreamToAnthropic(
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

  // Codex OAuth Responses API streams even for requests where the Anthropic
  // client expects a non-streaming JSON message. In that case collect the SSE
  // upstream and return a normal Anthropic Messages JSON response.
  if (isCodex && upstream.body) {
    try {
      return c.json(
        await codexStreamToAnthropicResponse(
          upstream.body,
          originalModel,
          messageId,
          estimatedInputTokens,
        ),
      );
    } catch (err) {
      return c.json(
        anthropicGatewayError(err instanceof Error ? err.message : String(err)),
        502,
      );
    }
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
