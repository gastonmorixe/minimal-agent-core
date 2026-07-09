/**
 * Host adapter: bind the {@link ModeManager} to the SDK {@link ModeProvider}
 * port.
 *
 * {@link AgentCore} reads the {@link ModeProvider} at two seams:
 *   - `consumePendingAttachment()` — emits a `<ma::agent::mode-change …>` text
 *     block onto the next user turn when the active mode changed since the last
 *     time it was advertised to the model. This is how a mode toggle reaches
 *     the model without invalidating the cached system-prompt prefix.
 *   - `activeModeId()` / `promptPrefix()` — read-only mode queries a host may
 *     use.
 *
 * ### Where tool filtering lives
 *
 * - **Advertisement** (request body): {@link AgentCoreConfig.toolFilter} /
 *   `toolFilterFromNamePolicy` — not this adapter. Modes deliberately do
 *   *not* strip tools from the request (prompt-cache stability).
 * - **Dispatch** (refuse a tool_use): `executeToolRound` via the raw
 *   {@link ModeManager} on {@link ToolExecutorAdapter}.
 *
 * `filterTools` remains a deprecated pass-through for residual callers of the
 * ModeProvider port; do not put CLI allow-lists here.
 *
 * @module host/sdk-adapters/mode-provider-adapter
 */

import type { ContentBlock } from "../../llm/messages.ts"
import type { ModeManager } from "../../modes/modes.ts"
import type { ModeProvider, ToolDefinition } from "../../sdk/ports.ts"

/**
 * A {@link ModeProvider} over a {@link ModeManager}.
 *
 * Thin by design: each method delegates to the corresponding manager method.
 * The consequential seam is {@link consumePendingAttachment}, which AgentCore
 * calls at the start of the run and after each tool round to surface a
 * mode-change signal to the model.
 */
export class ModeProviderAdapter implements ModeProvider {
  constructor(private readonly manager: ModeManager) {}

  /** The active mode id, or `null` for the default (no-mode) state. */
  activeModeId(): string | null {
    return this.manager.activeId()
  }

  /** The REPL prompt prefix for the active mode (host cosmetic; delegated). */
  promptPrefix(baseArrow: string): string {
    return this.manager.promptPrefix(baseArrow)
  }

  /**
   * Pass-through. Mode gating is dispatch-time only.
   *
   * @deprecated Use {@link AgentCoreConfig.toolFilter} for advertisement-time
   * filtering.
   */
  filterTools(tools: ToolDefinition[]): ToolDefinition[] {
    return tools
  }

  /**
   * The `<ma::agent::mode-change …>` block to prepend to the next user turn,
   * or `null` when the active mode has not changed since it was last
   * advertised. Delegates straight to the manager, which updates its
   * last-advertised bookkeeping and fires delivery listeners as a side effect.
   */
  consumePendingAttachment(): ContentBlock | null {
    return this.manager.consumePendingAttachment()
  }
}
