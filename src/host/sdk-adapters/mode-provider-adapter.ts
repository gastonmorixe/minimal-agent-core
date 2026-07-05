/**
 * Host adapter: bind the {@link ModeManager} to the SDK {@link ModeProvider}
 * port.
 *
 * {@link AgentCore} reads the {@link ModeProvider} at two seams:
 *   - `consumePendingAttachment()` — emits a `<ma::agent::mode-change …>` text
 *     block onto the next user turn when the active mode changed since the last
 *     time it was advertised to the model. This is how a mode toggle reaches
 *     the model without invalidating the cached system-prompt prefix.
 *   - `activeModeId()` / `promptPrefix()` / `filterTools()` — read-only mode
 *     queries a host may use (the `--json` path uses `consumePendingAttachment`
 *     primarily; the others round out the port).
 *
 * ### Where the real mode gating lives
 *
 * Tool-level mode enforcement (refusing a disallowed tool with a teaching
 * error) and the per-tool_result `<ma::agent::mode-active …>` stamp happen
 * inside `executeToolRound`, which receives the raw {@link ModeManager} through
 * the {@link ToolExecutorAdapter}. This adapter is only the AgentCore-facing
 * mode surface (the mode-change signal + queries). `filterTools` is a
 * deprecated no-op pass-through on the manager, so this adapter's
 * `filterTools` returns its input unchanged too — matching the legacy loop,
 * which advertises all tools and gates at dispatch.
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
   * Pass-through. The request body advertises every tool regardless of mode;
   * disallowed calls are refused at DISPATCH time inside `executeToolRound`.
   * `ModeManager.filterTools` is a deprecated no-op, so this returns its input
   * unchanged, keeping the tool schema array byte-stable across mode toggles
   * (the cached prefix must not depend on mode). Matches the legacy loop.
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
