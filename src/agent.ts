/**
 * Agent module: conversational state + tool execution loop + REPL.
 *
 * The {@link Agent} class owns the append-only conversation history and
 * provides two send methods:
 *
 * - {@link Agent.send} — single round-trip text reply (no tools)
 * - {@link Agent.run} — full agentic loop: send → tool_use → execute → tool_result → repeat
 *
 * Both yield text chunks via async generator and return a {@link StreamedResponse}
 * with the structured content blocks (thinking, tool_use, text). Thinking blocks
 * are preserved verbatim in history (with their signatures) so subsequent
 * requests can include them — required for the `redact-thinking-2026-02-12` beta.
 *
 * **Conversation history shape** (v2.1.91 block-based content):
 * ```
 * [
 *   { role: "user",      content: [{type:"text", text:"..."}] },
 *   { role: "assistant", content: [{type:"thinking",...}, {type:"tool_use",...}] },
 *   { role: "user",      content: [{type:"tool_result", tool_use_id:"...", content:"..."}] },
 *   { role: "assistant", content: [{type:"text", text:"..."}] },
 * ]
 * ```
 *
 * @module agent
 */

import type { AuthResult } from "./auth.ts";
import {
  sendMessage,
  type Message,
  type ContentBlock,
  type TextBlock,
  type ThinkingBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type StreamedResponse,
  type SendOptions,
} from "./client.ts";
import { TOOL_DEFINITIONS, executeTool } from "./tools.ts";
import { Formatter } from "./formatter.ts";

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
};

// ---------------------------------------------------------------------------
// Agent class
// ---------------------------------------------------------------------------

/**
 * Conversational agent with append-only history and an agentic tool loop.
 *
 * The agent maintains its own message list and re-sends the full history
 * on every API call (no truncation, no compression — that's a server-side
 * concern enabled by the `context-management-2025-06-27` beta).
 *
 * Both {@link send} and {@link run} preserve all content block types in
 * history (thinking blocks, tool calls, tool results) so the model has
 * full context for follow-up turns.
 *
 * @example
 * ```ts
 * const agent = new Agent({ auth, model: "claude-sonnet-4-6" });
 *
 * // Simple text reply:
 * for await (const chunk of agent.send("hello")) {
 *   process.stdout.write(chunk);
 * }
 *
 * // Full agentic with tools:
 * for await (const chunk of agent.run("read package.json")) {
 *   process.stdout.write(chunk);
 * }
 * ```
 */
export class Agent {
  /**
   * Append-only conversation history.
   *
   * Read-only by convention — never mutate from outside the class. Use
   * {@link history} to get a defensive copy. Each message has block-based
   * content matching the v2.1.91 wire format.
   */
  readonly messages: Message[] = [];
  /** Auth credentials used for every API call. Refresh closure stays attached. */
  private auth: AuthResult;
  /** Model ID for all requests in this agent's lifetime. */
  private model: string;
  /**
   * Hard limit on tool execution rounds within a single `run()` call.
   * Prevents infinite loops if the model keeps calling tools forever.
   * Set generously (50) since real agentic sessions can hit 30+ rounds.
   */
  private maxToolRounds = 50;

  /**
   * @param opts.auth - Authenticated credentials from {@link getAuth}
   * @param opts.model - Model ID (default: `claude-sonnet-4-6`)
   */
  constructor(opts: { auth: AuthResult; model?: string }) {
    this.auth = opts.auth;
    this.model = opts.model ?? "claude-sonnet-4-6";
  }

  /**
   * Send a user message and run the full agentic tool loop.
   *
   * Runs `send → execute_tools → send_results → ...` until the model returns
   * a response with no `tool_use` blocks (i.e. it's done) or the
   * {@link maxToolRounds} safety limit is hit.
   *
   * **What gets yielded**: only text chunks from the assistant's text blocks.
   * Tool calls and their outputs are NOT yielded — they're logged to stderr
   * with formatted previews so you can see what's happening without
   * polluting stdout.
   *
   * **What goes into history**: every assistant response (including thinking
   * and tool_use blocks) and every tool_result message is appended.
   *
   * @param userText - The user's message content
   * @param opts - Optional overrides for the underlying send (max_tokens, etc.)
   * @yields Text chunks from `text_delta` SSE events as they arrive
   * @returns The final {@link StreamedResponse} from the last API call
   *
   * @example
   * ```ts
   * const gen = agent.run("count the .ts files in src/");
   * while (true) {
   *   const { done, value } = await gen.next();
   *   if (done) {
   *     console.log("\nstop reason:", value.stopReason);
   *     break;
   *   }
   *   process.stdout.write(value);
   * }
   * ```
   */
  async *run(
    userText: string,
    opts?: Partial<SendOptions>,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    // Initial user message
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: userText }],
    });

    let rounds = 0;
    let lastResponse: StreamedResponse = { blocks: [], text: "", stopReason: null };

    while (rounds < this.maxToolRounds) {
      rounds++;

      // Send messages to API
      const gen = sendMessage({
        auth: this.auth,
        messages: [...this.messages],
        model: this.model,
        tools: TOOL_DEFINITIONS,
        ...opts,
      });

      let response: StreamedResponse | undefined;
      while (true) {
        const { done, value } = await gen.next();
        if (done) {
          response = value as unknown as StreamedResponse;
          break;
        }
        yield value;
      }

      lastResponse = response ?? { blocks: [], text: "", stopReason: null };

      // Append assistant response to history
      if (lastResponse.blocks.length > 0) {
        this.messages.push({ role: "assistant", content: lastResponse.blocks });
      }

      // Check for tool use blocks
      const toolBlocks = lastResponse.blocks.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      if (toolBlocks.length === 0) {
        // No tool calls — model is done
        break;
      }

      // Execute tools and collect results
      const toolResults: ToolResultBlock[] = [];
      for (const tool of toolBlocks) {
        console.error(`\n${c.cyan(">")} ${c.bold(tool.name)} ${c.dim(formatToolInput(tool))}`);
        const result = executeTool(tool.name, tool.input);

        // Show truncated output
        const preview = result.content.slice(0, 200);
        const truncated = result.content.length > 200 ? "..." : "";
        if (result.is_error) {
          console.error(`${c.red("  error:")} ${preview}${truncated}`);
        } else {
          console.error(`${c.dim("  " + preview.replace(/\n/g, "\n  "))}${truncated}`);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: result.content,
          is_error: result.is_error,
        });
      }

      // Send tool results back
      this.messages.push({ role: "user", content: toolResults });
    }

    if (rounds >= this.maxToolRounds) {
      console.error(c.yellow(`\n  [safety limit: stopped after ${this.maxToolRounds} tool rounds]`));
    }

    return lastResponse;
  }

  /**
   * Send a user message without enabling tools — single round-trip.
   *
   * Use this when you want a plain text reply without the agentic loop.
   * The model will not be told about any tools, so it cannot call them.
   * For agentic behavior, use {@link run} instead.
   *
   * @param userText - The user's message content
   * @param opts - Optional overrides for the underlying send
   * @yields Text chunks from `text_delta` SSE events as they arrive
   * @returns The {@link StreamedResponse} containing all content blocks
   */
  async *send(
    userText: string,
    opts?: Partial<SendOptions>,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: userText }],
    });

    const gen = sendMessage({
      auth: this.auth,
      messages: [...this.messages],
      model: this.model,
      ...opts,
    });

    let response: StreamedResponse | undefined;
    while (true) {
      const { done, value } = await gen.next();
      if (done) {
        response = value as unknown as StreamedResponse;
        break;
      }
      yield value;
    }

    const result = response ?? { blocks: [], text: "", stopReason: null };

    if (result.blocks.length > 0) {
      this.messages.push({ role: "assistant", content: result.blocks });
    }

    return result;
  }

  /**
   * Return a defensive copy of the conversation history.
   *
   * The internal {@link messages} array is read-only by convention but
   * not enforced; this method exists so external code can safely iterate
   * without risking mutation.
   */
  history(): Message[] {
    return [...this.messages];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a `tool_use` block's input for compact stderr display.
 *
 * Picks the most informative field per tool (command for Bash, file_path
 * for file tools, pattern for search tools) and truncates to ~80 chars.
 * Falls back to JSON-stringified input for unknown tools.
 */
function formatToolInput(tool: ToolUseBlock): string {
  const input = tool.input;
  if (tool.name === "Bash" && input.command) {
    return `$ ${String(input.command).slice(0, 80)}`;
  }
  if (tool.name === "Read" && input.file_path) {
    return String(input.file_path);
  }
  if (tool.name === "Write" && input.file_path) {
    return String(input.file_path);
  }
  if (tool.name === "Edit" && input.file_path) {
    return String(input.file_path);
  }
  if (tool.name === "Glob" && input.pattern) {
    return String(input.pattern);
  }
  if (tool.name === "Grep" && input.pattern) {
    return `/${input.pattern}/` + (input.path ? ` in ${input.path}` : "");
  }
  return JSON.stringify(input).slice(0, 80);
}

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

/**
 * Run an interactive read-eval-print loop with full tool execution.
 *
 * Reads lines from stdin, sends each non-empty line to the agent via
 * {@link Agent.run}, and prints streamed text chunks to stdout. Tool
 * calls and outputs are logged to stderr. Exit with Ctrl+D (EOF) or Ctrl+C.
 *
 * **Formatter integration**: if `opts.formatterCmd` is provided, each user
 * turn pipes the streamed text through that external process (see
 * {@link Formatter}). A fresh formatter is spawned per turn so the
 * markdown rendering state resets between user messages — this avoids
 * the formatter getting confused by stale state from previous turns.
 *
 * @param agent - Initialized agent instance
 * @param opts.formatterCmd - Optional formatter argv (e.g. `["mdstream"]`)
 *
 * @example
 * ```ts
 * await runRepl(agent);
 * await runRepl(agent, { formatterCmd: ["mdstream"] });
 * await runRepl(agent, { formatterCmd: ["bat", "--language=md", "--paging=never"] });
 * ```
 */
export async function runRepl(
  agent: Agent,
  opts?: { formatterCmd?: string[] },
): Promise<void> {
  process.stdout.write("\nminimal-agent ready. Type a message (Ctrl+D to quit).\n\n");

  const rl = require("node:readline").createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  for await (const line of rl) {
    const trimmed = (line as string).trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    process.stdout.write("\n");

    // Set up a fresh formatter per turn (markdown context resets each turn)
    let formatter: Formatter | null = null;
    if (opts?.formatterCmd) {
      formatter = new Formatter(opts.formatterCmd);
      formatter.start();
    }

    try {
      const gen = agent.run(trimmed);
      while (true) {
        const { done, value } = await gen.next();
        if (done) break;
        if (formatter) {
          formatter.write(value);
        } else {
          process.stdout.write(value);
        }
      }
    } finally {
      if (formatter) await formatter.end();
    }

    process.stdout.write("\n\n");
    rl.prompt();
  }

  process.stdout.write("\nBye.\n");
}
