/**
 * Agent module: interactive REPL with tool execution loop.
 *
 * Updated for v2.1.91:
 *   - Block-based message content (text, thinking, tool_use, tool_result)
 *   - Thinking blocks included in conversation history (with signatures)
 *   - Full tool execution loop: tool_use -> execute -> tool_result -> repeat
 *   - Tools: Bash, Read, Write, Edit, Glob, Grep
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

export class Agent {
  /** Append-only conversation history. Content is block-based. */
  readonly messages: Message[] = [];
  private auth: AuthResult;
  private model: string;
  /** Maximum tool execution rounds before stopping (safety limit) */
  private maxToolRounds = 50;

  constructor(opts: { auth: AuthResult; model?: string }) {
    this.auth = opts.auth;
    this.model = opts.model ?? "claude-sonnet-4-6";
  }

  /**
   * Send a user message with full agentic tool loop.
   *
   * Runs the send -> [tool_use -> execute -> tool_result] -> ... -> text loop
   * until the model responds with end_turn (no more tool calls) or the
   * safety limit is hit.
   *
   * Yields text chunks as they arrive for display. Tool execution output
   * is reported to stderr.
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
   * Send a user message without tools (simple text-only).
   * For backward compatibility and non-agentic use cases.
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

  /** Return a copy of the conversation history. */
  history(): Message[] {
    return [...this.messages];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format tool input for display (compact) */
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
 * Run an interactive read-eval-print loop with tool execution.
 *
 * If `formatterCmd` is provided, each user turn pipes the streamed text
 * through that external process for realtime formatting (e.g. mdstream, bat).
 * The formatter is spawned fresh per turn so markdown context is reset.
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
