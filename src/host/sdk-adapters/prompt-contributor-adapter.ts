/**
 * Host adapter: bind plugin prompt fragments, save-echoes, and per-turn
 * attachment producers to the SDK {@link PromptContributor} port.
 *
 * The legacy `Agent` folds three distinct plugin/host contributions into the
 * conversation. This adapter re-expresses each through the matching
 * {@link PromptContributor} method so an {@link AgentCore} run assembles the
 * same context:
 *
 * 1. **`systemPromptBlocks()`** — the plugin prompt block from
 *    `loader.getPromptBlockAsync()`. The legacy loop passes this as
 *    `resolveSystemPromptForModel({ sessionContext })`; AgentCore joins every
 *    contributor's `systemPromptBlocks()` text with `\n` and threads it into
 *    the SAME resolver call under the same `sessionContext` key. So one text
 *    block carrying the whole plugin block reproduces the legacy system prompt.
 *
 * 2. **`turnAttachments()`** — each per-turn producer's `toAttachment()`
 *    (memory short-term snapshot, tasks list, sub-agents fleet digest, …), in
 *    registry order, null-on-empty entries dropped. Prepended to the first
 *    user turn.
 *
 * 3. **`saveEchoes()`** — `saveEcho.consumeAll()` (the `<ma::agent::memory-saved …>`
 *    blocks buffered since the last turn). Drained onto each user message.
 *
 * ### The async prompt-block seam
 *
 * `getPromptBlockAsync()` is async (it awaits plugin prompt fragments with
 * per-fragment timeouts) and memoized. But `PromptContributor.systemPromptBlocks()`
 * is SYNCHRONOUS — AgentCore reads it inline while building the request. The
 * resolution is: this adapter is constructed via the async {@link create}
 * factory, which awaits the block ONCE up front and caches the resolved text.
 * `systemPromptBlocks()` then returns it synchronously. This matches the legacy
 * loop, which also awaits `getPromptBlockAsync()` once per run before assembling
 * the system prompt. Volatile fragment content (date, terminal size) is captured
 * once at run start in both paths.
 *
 * @module host/sdk-adapters/prompt-contributor-adapter
 */

import type { ContentBlock } from "../../llm/messages.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import type { PromptContributor } from "../../sdk/ports.ts"

/** A per-turn attachment producer (null-on-empty). Matches the legacy shape. */
export interface TurnAttachmentProducer {
  toAttachment(): ContentBlock | null
}

/** The save-echo collector: drains buffered memory-saved blocks. */
export interface SaveEchoCollector {
  consumeAll(): ContentBlock[]
}

/** Fixed collaborators for the adapter. All optional; each is null-on-absent. */
export interface PromptContributorAdapterDeps {
  /** Loader whose `getPromptBlockAsync()` yields the plugin system-prompt text. */
  loader?: PluginLoader | null
  /** Save-echo collector drained onto each user message. */
  saveEcho?: SaveEchoCollector | null
  /** Per-turn attachment producers, prepended to the first user turn in order. */
  turnAttachments?: readonly TurnAttachmentProducer[]
}

/**
 * A {@link PromptContributor} over a plugin loader's prompt block, a save-echo
 * collector, and per-turn attachment producers.
 *
 * Construct via {@link PromptContributorAdapter.create} so the async plugin
 * prompt block is resolved once up front and served synchronously thereafter.
 */
export class PromptContributorAdapter implements PromptContributor {
  private constructor(
    private readonly promptBlock: string | null,
    private readonly saveEcho: SaveEchoCollector | null,
    private readonly turnAttachmentProducers: readonly TurnAttachmentProducer[],
  ) {}

  /**
   * Build the adapter, awaiting the plugin prompt block once. Mirrors the
   * legacy `const pluginBlock = await loader.getPromptBlockAsync()` seam.
   */
  static async create(deps: PromptContributorAdapterDeps): Promise<PromptContributorAdapter> {
    const promptBlock = (await deps.loader?.getPromptBlockAsync()) ?? null
    return new PromptContributorAdapter(
      promptBlock,
      deps.saveEcho ?? null,
      deps.turnAttachments ?? [],
    )
  }

  /**
   * The plugin prompt block as a single text block, or none when empty.
   *
   * AgentCore joins each contributor's text blocks with `\n` into the
   * `sessionContext` of `resolveSystemPromptForModel` — the same key and
   * assembly the legacy loop uses — so one block carrying the whole plugin
   * text reproduces the legacy system prompt byte-for-byte. An empty or null
   * block contributes nothing (matches `sessionContext: undefined`).
   */
  systemPromptBlocks(): ContentBlock[] {
    if (this.promptBlock === null || this.promptBlock.length === 0) return []
    return [{ type: "text", text: this.promptBlock }]
  }

  /**
   * Per-turn attachment blocks, in producer order, null-on-empty dropped.
   * AgentCore prepends these to the FIRST user turn of the run (memory,
   * tasks, fleet digest, …), matching the legacy attachment order.
   */
  turnAttachments(): ContentBlock[] {
    const out: ContentBlock[] = []
    for (const p of this.turnAttachmentProducers) {
      const block = p.toAttachment()
      if (block) out.push(block)
    }
    return out
  }

  /**
   * Save-echo blocks buffered since the last turn (`<ma::agent::memory-saved …>`).
   * Drained onto each user message so the model learns the ids of memories it
   * just saved on its very next turn. Returns `[]` when no collector is wired.
   */
  saveEchoes(): ContentBlock[] {
    return this.saveEcho?.consumeAll() ?? []
  }
}
