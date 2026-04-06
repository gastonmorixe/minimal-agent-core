/**
 * Client module: Messages API with streaming, pretty debug logging, and 401 retry.
 *
 * Updated to match CLI v2.1.91 traffic (captured 2026-04-04):
 *   - Block-based message content (text, thinking, tool_use, tool_result)
 *   - Adaptive thinking with redacted thinking + signatures
 *   - Effort parameter (output_config.effort)
 *   - Per-request-type beta flags
 *   - 64K max_tokens default (was 8192)
 *   - SSE parsing for signature_delta and input_json_delta
 */

import type { AuthResult } from "./auth.ts";
import {
  API_URL,
  SYSTEM_PROMPT,
  DEFAULT_MODEL,
  ANTHROPIC_VERSION,
  BETA_FLAGS,
  buildHeaders,
  buildSystemPrompt,
  type RequestType,
  type SystemBlock,
} from "./headers.ts";
import { buildMetadata, getSessionId } from "./metadata.ts";

// ---------------------------------------------------------------------------
// Content block types (matching v2.1.91 traffic)
// ---------------------------------------------------------------------------

/** Text content block */
export interface TextBlock {
  type: "text";
  text: string;
}

/** Thinking block (redacted in v2.1.91 — thinking is empty, signature is populated) */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

/** Tool use block emitted by the assistant */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: { type: string };
}

/** Tool result block sent by the user after executing a tool */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

/** Union of all content block types */
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// ---------------------------------------------------------------------------
// Message and options types
// ---------------------------------------------------------------------------

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface SendOptions {
  auth: AuthResult;
  messages: Message[];
  system?: SystemBlock[];
  model?: string;
  maxTokens?: number;
  stream?: boolean;
  requestType?: RequestType;
  /** Enable adaptive thinking (default: true for conversation requests) */
  thinking?: { type: "adaptive" } | false;
  /** Output configuration: effort level and/or structured output format */
  outputConfig?: {
    effort?: "high" | "medium" | "low";
    format?: { type: string; schema?: unknown };
  };
  /** Tool definitions to include in the request */
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  /** Temperature (default: not sent, API uses its default) */
  temperature?: number;
}

/**
 * Parsed response from streaming — contains all content blocks, not just text.
 */
export interface StreamedResponse {
  /** All content blocks in order */
  blocks: ContentBlock[];
  /** Concatenated text from text blocks only (convenience) */
  text: string;
  /** Stop reason from message_delta */
  stopReason: string | null;
}

/**
 * A single Server-Sent Event from the streaming Messages API.
 *
 * Event types observed in v2.1.91 capture:
 *   - message_start: message object with id, model, usage
 *   - content_block_start: new content block (text, thinking, tool_use)
 *   - content_block_delta: incremental data:
 *       text_delta: { type: "text_delta", text: "..." }
 *       signature_delta: { type: "signature_delta", signature: "..." }
 *       input_json_delta: { type: "input_json_delta", partial_json: "..." }
 *   - content_block_stop: end of a content block
 *   - message_delta: stop_reason, usage, context_management
 *   - message_stop: end of message
 *   - ping: keepalive
 */
interface StreamEvent {
  type: string;
  index?: number;
  delta?: {
    type: string;
    text?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
  };
  message?: { id: string; model: string; usage: unknown };
  content_block?: {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    caller?: { type: string };
  };
  usage?: unknown;
  context_management?: { applied_edits: unknown[] };
}

/**
 * Model information returned by GET /v1/models.
 * The API returns a list of models the authenticated user can access.
 */
export interface ModelInfo {
  id: string;
  display_name?: string;
  type: string;
  created_at?: string;
}

/**
 * Normalize a model string for API calls.
 *
 * The CLI uses client-side suffixes like [1m] to denote context window
 * variants. These must be stripped before sending to the API — the actual
 * activation is via the context-1m-2025-08-07 beta flag.
 *
 * See cc-03312026/src/utils/model/model.ts:normalizeModelStringForAPI()
 */
export function normalizeModelForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, "");
}

/**
 * Check if a model string requests 1M context (has [1m] suffix).
 */
export function has1mContext(model: string): boolean {
  return /\[1m\]/i.test(model);
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
};

// ---------------------------------------------------------------------------
// Debug logging — pretty-printed to stderr
// ---------------------------------------------------------------------------

/**
 * Check debug mode at call time (not import time) so that --debug flag
 * in index.ts can set process.env.DEBUG before the first request.
 */
export function isDebug(): boolean {
  return !!process.env.DEBUG;
}

function debugHeader(label: string): void {
  if (!isDebug()) return;
  console.error(`\n${c.bold(c.cyan(`--- ${label} ---`))}`);
}

function debugKV(key: string, value: string): void {
  if (!isDebug()) return;
  console.error(`  ${c.dim(key + ":")} ${value}`);
}

/** Print request headers sorted alphabetically, with auth tokens redacted. */
function debugHeaders(headers: Record<string, string>): void {
  if (!isDebug()) return;
  console.error(`  ${c.bold("Headers:")}`);
  const sorted = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of sorted) {
    const display =
      k === "authorization" ? v.slice(0, 20) + "..." + c.dim("REDACTED") :
      k === "x-api-key" ? v.slice(0, 10) + "..." + c.dim("REDACTED") :
      v;
    console.error(`    ${c.yellow(k)}: ${display}`);
  }
}

/**
 * Pretty-print the request body, with special handling for:
 *   - messages: show count + role/content preview per message
 *   - system: label blocks as "billing" or "identity" based on content
 *   - metadata.user_id: parse the JSON string and show fields individually
 */
function debugBody(body: Record<string, unknown>): void {
  if (!isDebug()) return;
  console.error(`  ${c.bold("Body:")}`);
  for (const [k, v] of Object.entries(body)) {
    if (k === "messages") {
      const msgs = v as Message[];
      console.error(`    ${c.yellow("messages")}: ${c.dim(`[${msgs.length} message(s)]`)}`);
      for (const msg of msgs) {
        const preview = typeof msg.content === "string"
          ? msg.content.slice(0, 80) + (msg.content.length > 80 ? "..." : "")
          : "[complex]";
        console.error(`      ${c.green(msg.role)}: ${c.dim(preview)}`);
      }
    } else if (k === "system") {
      const sys = v as Array<{ type: string; text: string; cache_control?: unknown }>;
      console.error(`    ${c.yellow("system")}: ${c.dim(`[${sys.length} block(s)]`)}`);
      for (let i = 0; i < sys.length; i++) {
        const block = sys[i];
        // Label blocks by their role (see SYSTEM_PROMPT docs in headers.ts)
        const label =
          block.text.startsWith("x-anthropic-billing-header") ? "billing" :
          block.text.startsWith("You are Claude") ? "identity" :
          `block ${i}`;
        const cc = block.cache_control ? ` ${c.dim("[cached]")}` : "";
        const preview = block.text.slice(0, 80) + (block.text.length > 80 ? "..." : "");
        console.error(`      ${c.magenta(label)}${cc}: ${c.dim(preview)}`);
      }
    } else if (k === "metadata") {
      const meta = v as { user_id: string };
      console.error(`    ${c.yellow("metadata.user_id")}:`);
      try {
        const parsed = JSON.parse(meta.user_id);
        for (const [mk, mv] of Object.entries(parsed)) {
          console.error(`      ${c.magenta(mk)}: ${String(mv)}`);
        }
      } catch {
        console.error(`      ${meta.user_id}`);
      }
    } else {
      console.error(`    ${c.yellow(k)}: ${JSON.stringify(v)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Rate limit header parsing
// ---------------------------------------------------------------------------

/**
 * Convert a raw ratelimit header value to a human-readable annotation.
 *
 * The Anthropic API returns unified rate limit headers with this naming pattern:
 *   anthropic-ratelimit-unified[-<window>]-<field>
 *
 * Windows: "5h" (5-hour rolling), "7d" (7-day rolling), or none (aggregate).
 * Fields: reset (unix timestamp), utilization (0.0-1.0), status (allowed/rejected),
 *   fallback-percentage, overage-status, overage-disabled-reason,
 *   representative-claim (which window is billing-relevant).
 */
function humanizeRatelimitValue(key: string, value: string): string {
  if (key.endsWith("-reset")) {
    const resetAt = Number(value) * 1000; // API sends seconds, we need ms
    const now = Date.now();
    const diffMs = resetAt - now;
    if (diffMs <= 0) return "now";
    const mins = Math.floor(diffMs / 60_000);
    const hrs = Math.floor(mins / 60);
    if (hrs > 0) return `in ${hrs}h ${mins % 60}m`;
    return `in ${mins}m`;
  }
  if (key.endsWith("-utilization")) {
    return `${(Number(value) * 100).toFixed(1)}%`;
  }
  if (key.endsWith("-fallback-percentage")) {
    return `${(Number(value) * 100).toFixed(0)}%`;
  }
  if (key.endsWith("-status")) {
    if (value === "allowed") return c.green("allowed");
    if (value === "rejected") return c.red("rejected");
    return value;
  }
  if (key.endsWith("-disabled-reason")) {
    // These reasons come from `P04()` (L468510-468524) which checks
    // cachedExtraUsageDisabledReason.
    const map: Record<string, string> = {
      out_of_credits: "no credits remaining",
      overage_not_provisioned: "overage not set up",
      org_level_disabled: "disabled by org admin",
    };
    return map[value] ?? value;
  }
  return "";
}

/**
 * Print a summary of rate limit status after the per-header listing.
 * Extracts the 5h and 7d windows and shows utilization, status, and reset time.
 */
function formatRatelimitSummary(rl: Map<string, string>): void {
  const windows = new Map<string, { util?: number; status?: string; reset?: number }>();
  for (const [k, v] of rl) {
    const match = k.match(/^anthropic-ratelimit-unified-([\w]+)-(\w+)$/);
    if (!match) continue;
    const window = match[1];
    const field = match[2];
    if (!windows.has(window)) windows.set(window, {});
    const w = windows.get(window)!;
    if (field === "utilization") w.util = Number(v);
    if (field === "status") w.status = v;
    if (field === "reset") w.reset = Number(v) * 1000;
  }

  const ovStatus = rl.get("anthropic-ratelimit-unified-overage-status");
  const ovReason = rl.get("anthropic-ratelimit-unified-overage-disabled-reason");
  const rep = rl.get("anthropic-ratelimit-unified-representative-claim");

  console.error(`\n  ${c.bold("Rate limit summary:")}`);
  for (const [window, info] of [...windows.entries()].sort()) {
    // Skip non-window entries (overage, fallback, representative-claim are handled separately)
    if (window === "overage" || window === "fallback" || window === "representative") continue;
    if (!info.util && !info.status && !info.reset) continue;
    const label =
      window === "5h" ? "5-hour" :
      window === "7d" ? "7-day" :
      window.startsWith("7d_") ? `7-day (${window.slice(3)})` :
      window;
    const pct = info.util != null ? `${(info.util * 100).toFixed(1)}% used` : "?";
    const statusColor = info.status === "allowed" ? c.green(info.status!) : c.red(info.status!);
    let resetStr = "";
    if (info.reset) {
      const diffMs = info.reset - Date.now();
      if (diffMs > 0) {
        const hrs = Math.floor(diffMs / 3_600_000);
        const mins = Math.floor((diffMs % 3_600_000) / 60_000);
        resetStr = `, resets in ${hrs}h ${mins}m`;
      }
    }
    console.error(`    ${c.cyan(label)}: ${pct} — ${statusColor}${resetStr}`);
  }
  if (ovStatus) {
    const ovColor = ovStatus === "allowed" ? c.green("enabled") : c.red("disabled");
    const reason = ovReason ? ` (${humanizeRatelimitValue("x-disabled-reason", ovReason) || ovReason})` : "";
    console.error(`    ${c.cyan("overage")}: ${ovColor}${reason}`);
  }
  if (rep) {
    console.error(`    ${c.cyan("billing window")}: ${rep.replace("_", " ")}`);
  }
}

/**
 * Pretty-print all response headers, with human annotations for ratelimit
 * headers and a summary block at the end.
 */
function debugResponse(status: number, headers: Headers): void {
  if (!isDebug()) return;
  debugHeader(`Response ${status >= 400 ? c.red(String(status)) : c.green(String(status))}`);
  const entries: [string, string][] = [];
  const ratelimitEntries = new Map<string, string>();
  headers.forEach((v, k) => entries.push([k, v]));
  entries.sort(([a], [b]) => a.localeCompare(b));

  for (const [k, v] of entries) {
    const human = k.startsWith("anthropic-ratelimit-")
      ? humanizeRatelimitValue(k, v)
      : "";
    const annotation = human ? ` ${c.dim(`(${human})`)}` : "";
    console.error(`    ${c.yellow(k)}: ${v}${annotation}`);
    if (k.startsWith("anthropic-ratelimit-")) {
      ratelimitEntries.set(k, v);
    }
  }

  if (ratelimitEntries.size > 0) {
    formatRatelimitSummary(ratelimitEntries);
  }
}

// ---------------------------------------------------------------------------
// Streaming response parser
// ---------------------------------------------------------------------------

/**
 * Parse a Server-Sent Events stream into typed event objects.
 *
 * The Anthropic streaming API uses standard SSE format:
 *   event: <type>\n
 *   data: <json>\n\n
 *
 * We only look at `data:` lines since the event type is also in the JSON.
 * The stream ends with `data: [DONE]` (not standard SSE, but conventional).
 *
 * Uses a line-buffered approach: we accumulate bytes until we see newlines,
 * then process complete lines. This handles partial chunks from the network
 * correctly (a single SSE event may arrive across multiple TCP segments).
 */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete last line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as StreamEvent;
          } catch {
            // skip malformed events — shouldn't happen but defensive
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// sendMessage — streaming, returns async iterable of text chunks
// ---------------------------------------------------------------------------

/**
 * Send a message to the Messages API and yield streamed content events.
 *
 * Updated for v2.1.91:
 *   - Per-request-type beta flags via requestType option
 *   - Adaptive thinking via thinking option (default: {type:"adaptive"})
 *   - Effort parameter via outputConfig.effort (default: "high")
 *   - Parses all SSE delta types: text_delta, signature_delta, input_json_delta
 *   - Returns StreamedResponse with all content blocks
 *
 * The generator yields text chunks for backward compatibility. The full
 * structured response (including thinking and tool_use blocks) is available
 * via the return value.
 */
export async function* sendMessage(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  const {
    auth,
    messages,
    system = SYSTEM_PROMPT,
    model: rawModel = DEFAULT_MODEL,
    maxTokens = 64000,
    stream = true,
    requestType = "conversation",
    thinking = { type: "adaptive" as const },
    outputConfig = { effort: "high" as const },
    tools,
    temperature,
  } = opts;

  // Strip client-side [1m] suffix — API activation is via beta flag
  const model = normalizeModelForAPI(rawModel);

  const sessionId = getSessionId();
  // Pass rawModel so buildBetaFlags sees [1m] and adds context-1m flag
  const headers = buildHeaders(auth, sessionId, requestType, rawModel);
  const metadata = buildMetadata(auth);

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    stream,
    system,
    messages,
    metadata,
  };

  // Thinking: only for models that support it (not haiku)
  // v2.1.91 capture: opus sends thinking:{type:"adaptive"}, haiku does not
  const isHaiku = model.includes("haiku");
  if (thinking && !isHaiku) {
    body.thinking = thinking;
  }

  // Output config: effort and/or structured format
  // v2.1.91: effort only sent for models that support it (not haiku)
  if (outputConfig && !isHaiku) {
    body.output_config = outputConfig;
  } else if (outputConfig?.format) {
    // Structured output format can be sent even for haiku (used in title gen)
    body.output_config = { format: outputConfig.format };
  }

  // Tools: include if provided
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  // Temperature: only sent explicitly when set (title gen uses 1)
  if (temperature != null) {
    body.temperature = temperature;
  }

  debugHeader(`POST ${API_URL}`);
  debugKV("model", model);
  debugKV("stream", String(stream));
  debugKV("max_tokens", String(maxTokens));
  debugKV("request_type", requestType);
  if (thinking) debugKV("thinking", JSON.stringify(thinking));
  if (outputConfig) debugKV("output_config", JSON.stringify(outputConfig));
  debugHeaders(headers);
  debugBody(body as Record<string, unknown>);

  const doFetch = async (token: string) => {
    const h = { ...headers };
    if (h.authorization) h.authorization = `Bearer ${token}`;
    else if (h["x-api-key"]) h["x-api-key"] = token;

    return fetch(API_URL, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
  };

  let response = await doFetch(auth.token);

  debugResponse(response.status, response.headers);

  // 401 retry with token refresh — mirrors onAuth401 pattern (L751090-751112)
  if (response.status === 401 && auth.refresh) {
    debugHeader(c.yellow("401 — refreshing token..."));
    try {
      const refreshed = await auth.refresh();
      response = await doFetch(refreshed.token);
      if (response.status === 401) {
        throw new Error("401 after token refresh. Re-login required.");
      }
      auth.token = refreshed.token;
    } catch (e) {
      throw new Error(
        `Token refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (!response.ok) {
    const errorBody = await response.text();
    if (isDebug()) {
      debugHeader(c.red(`Error ${response.status}`));
      console.error(`  ${errorBody.slice(0, 500)}`);
    }
    throw new Error(`API ${response.status}: ${errorBody}`);
  }

  // Non-streaming path (used in tests)
  if (!stream) {
    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content.find((c) => c.type === "text")?.text ?? "";
    yield text;
    return { blocks: data.content as ContentBlock[], text, stopReason: "end_turn" };
  }

  // Streaming path — parse SSE and collect all content blocks
  if (!response.body) throw new Error("No response body for stream");

  const blocks: ContentBlock[] = [];
  let currentBlock: Partial<ContentBlock> | null = null;
  let currentIndex = -1;
  let fullText = "";
  let stopReason: string | null = null;

  // Accumulators for the current block being streamed
  let thinkingSig = "";
  let toolJsonParts = "";

  for await (const event of parseSSE(response.body)) {
    switch (event.type) {
      case "content_block_start": {
        currentIndex = event.index ?? -1;
        const cb = event.content_block;
        if (!cb) break;

        if (cb.type === "thinking") {
          currentBlock = { type: "thinking", thinking: cb.thinking ?? "", signature: cb.signature ?? "" };
          thinkingSig = cb.signature ?? "";
        } else if (cb.type === "tool_use") {
          currentBlock = {
            type: "tool_use",
            id: cb.id ?? "",
            name: cb.name ?? "",
            input: cb.input ?? {},
            caller: cb.caller,
          };
          toolJsonParts = "";
        } else if (cb.type === "text") {
          currentBlock = { type: "text", text: cb.text ?? "" };
        }
        break;
      }

      case "content_block_delta": {
        const d = event.delta;
        if (!d) break;

        if (d.type === "text_delta" && d.text) {
          if (currentBlock?.type === "text") {
            (currentBlock as TextBlock).text += d.text;
          }
          fullText += d.text;
          yield d.text;
        } else if (d.type === "signature_delta" && d.signature) {
          thinkingSig += d.signature;
          if (currentBlock?.type === "thinking") {
            (currentBlock as ThinkingBlock).signature = thinkingSig;
          }
        } else if (d.type === "input_json_delta" && d.partial_json != null) {
          toolJsonParts += d.partial_json;
        }
        break;
      }

      case "content_block_stop": {
        if (currentBlock) {
          // Finalize tool_use: parse accumulated JSON into input
          if (currentBlock.type === "tool_use" && toolJsonParts) {
            try {
              (currentBlock as ToolUseBlock).input = JSON.parse(toolJsonParts);
            } catch {
              // partial JSON — keep what we have
              (currentBlock as ToolUseBlock).input = { _raw: toolJsonParts };
            }
          }
          blocks.push(currentBlock as ContentBlock);
        }
        currentBlock = null;
        toolJsonParts = "";
        thinkingSig = "";
        break;
      }

      case "message_delta": {
        if (event.delta?.stop_reason) {
          stopReason = event.delta.stop_reason;
        }
        break;
      }
    }
  }

  return { blocks, text: fullText, stopReason };
}

// ---------------------------------------------------------------------------
// listModels — fetch available models for this user
// ---------------------------------------------------------------------------

/**
 * List models available to the authenticated user.
 *
 * Uses GET /v1/models?beta=true, matching the SDK's `list()` method at L5066-5086.
 * Returns model objects with id, display_name, type, and created_at.
 */
const MODELS_URL = "https://api.anthropic.com/v1/models?beta=true";

export async function listModels(auth: AuthResult): Promise<ModelInfo[]> {
  const sessionId = getSessionId();
  const headers = buildHeaders(auth, sessionId);

  debugHeader(`GET ${MODELS_URL}`);

  const response = await fetch(MODELS_URL, {
    method: "GET",
    headers,
  });

  debugResponse(response.status, response.headers);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Models API ${response.status}: ${errorBody}`);
  }

  const data = (await response.json()) as { data: ModelInfo[] };
  const models = data.data;

  // Synthesize 1M context variants for models that support it.
  // The CLI uses a client-side [1m] suffix convention — these aren't separate
  // API model IDs. The actual 1M activation happens via the context-1m-2025-08-07
  // beta flag. See cc-03312026/src/utils/context.ts:modelSupports1M().
  const supports1M = (id: string) =>
    id.includes("claude-sonnet-4") || id.includes("opus-4-6");

  const variants: ModelInfo[] = [];
  for (const m of models) {
    if (supports1M(m.id)) {
      variants.push({
        ...m,
        id: `${m.id}[1m]`,
        display_name: m.display_name
          ? `${m.display_name} (1M context)`
          : `${m.id} (1M context)`,
      });
    }
  }

  return [...models, ...variants];
}

// ---------------------------------------------------------------------------
// sendMessageSync — convenience, collects full response
// ---------------------------------------------------------------------------

/** Convenience wrapper that collects the full streamed response text. */
export async function sendMessageSync(
  opts: SendOptions,
): Promise<string> {
  let result = "";
  const gen = sendMessage(opts);
  while (true) {
    const { done, value } = await gen.next();
    if (done) break;
    result += value;
  }
  return result;
}

/**
 * Convenience wrapper that returns the full StreamedResponse with all content blocks.
 */
export async function sendMessageFull(
  opts: SendOptions,
): Promise<StreamedResponse> {
  const gen = sendMessage(opts);
  let lastReturn: StreamedResponse | undefined;
  while (true) {
    const { done, value } = await gen.next();
    if (done) {
      lastReturn = value as unknown as StreamedResponse;
      break;
    }
  }
  return lastReturn ?? { blocks: [], text: "", stopReason: null };
}

// ---------------------------------------------------------------------------
// Quota check — cheap haiku request to verify account has quota
// ---------------------------------------------------------------------------

/**
 * Send a minimal quota check request matching v2.1.91 behavior.
 *
 * Observed in capture (fetch-002):
 *   model: claude-haiku-4-5-20251001
 *   max_tokens: 1
 *   messages: [{role:"user", content:"quota"}]
 *   No system prompt, no tools, no thinking, no output_config
 *   Beta flags: quota set (5 flags, no claude-code-20250219)
 *
 * Returns true if the account has quota, false otherwise.
 */
export async function checkQuota(auth: AuthResult): Promise<boolean> {
  const sessionId = getSessionId();
  const headers = buildHeaders(auth, sessionId, "quota");
  const metadata = buildMetadata(auth);

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1,
    messages: [{ role: "user", content: "quota" }],
    metadata,
  };

  debugHeader("POST (quota check)");
  debugKV("model", body.model);

  const doFetch = async (token: string) => {
    const h = { ...headers };
    if (h.authorization) h.authorization = `Bearer ${token}`;
    else if (h["x-api-key"]) h["x-api-key"] = token;

    return fetch(API_URL, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
  };

  try {
    let response = await doFetch(auth.token);

    // 401 retry
    if (response.status === 401 && auth.refresh) {
      const refreshed = await auth.refresh();
      response = await doFetch(refreshed.token);
      auth.token = refreshed.token;
    }

    debugResponse(response.status, response.headers);

    if (!response.ok) {
      const errorBody = await response.text();
      if (isDebug()) {
        debugHeader(c.red(`Quota check failed: ${response.status}`));
        console.error(`  ${errorBody.slice(0, 200)}`);
      }
      return false;
    }

    return true;
  } catch (e) {
    if (isDebug()) {
      console.error(`  quota check error: ${e instanceof Error ? e.message : String(e)}`);
    }
    return false;
  }
}
