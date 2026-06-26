/**
 * Prompt-fragment producer for the `agent-identity` plugin.
 *
 * Emits a SINGLE system-prompt line naming the agent, e.g.
 *
 *   You are working as Laura.
 *
 * or nothing at all when no name is configured (the default). The name is
 * resolved once at boot in `src/index.ts` (`resolveAgentName`) and published
 * as `MINIMAL_AGENT_AGENT_NAME`; the loader spreads `process.env` into this
 * fragment's `ctx.env`, so we just read the already-resolved value here. No
 * hashing or config parsing happens in the plugin: the host owns that so the
 * value is identical everywhere (system prompt, future intercom/fleet labels).
 *
 * CACHE NOTE: this fragment lands in the composed plugin block, which is the
 * agent's per-session `sessionContext` system block, AFTER the cross-session
 * `scope:"global"` cache breakpoint on the instructions block. So the name
 * rides in already-variable, already-uncached-across-sessions content and
 * costs zero shared-prefix cache. See this plugin's README for the full
 * rationale. The producer is pure + synchronous + deterministic, so the
 * composed system prompt stays byte-stable for the whole session (the loader
 * memoizes the block on first assembly).
 *
 * @module plugins/agent-identity/handlers/identity
 */

import type { PromptFragmentContext } from "@minimal-agent/plugin-api/types/plugin"

/** Env var the host publishes with the resolved, frozen session name. */
const NAME_ENV = "MINIMAL_AGENT_AGENT_NAME"

/**
 * Read the resolved name from the fragment env. Returns `""` (the
 * "contribute nothing" signal) when unset/blank, so an unnamed session's
 * system prompt is byte-identical to one built without this plugin.
 */
export default function identityFragment(ctx: PromptFragmentContext): string {
  const raw = ctx.env?.[NAME_ENV] ?? ""
  const name = raw.trim()
  if (!name) return ""
  return `You are working as ${name}. It is the name people use to refer to you in this session; answer to it naturally when addressed.`
}
