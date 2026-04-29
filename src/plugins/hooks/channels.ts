/**
 * Central channel registry.
 *
 * One source of truth for every named channel: shape, permission, doc.
 * The {@link Hooks} facade reads this to route emits/listens; the
 * loader reads it to gate plugin permissions.
 *
 * Adding a channel: append to {@link CHANNELS} below. Keep names
 * dot-separated and stable — once published, treat as a wire format.
 *
 * Payload typings live alongside as a {@link ChannelPayloads} map.
 *
 * @module plugins/hooks/channels
 */

import type { ChannelSpec } from "./types.ts"

/**
 * Catalog of every channel the agent core declares. Plugins may
 * register additional channels by calling `hooks.declare(...)` at
 * activation; those are not listed here.
 */
export const CHANNELS = [
  // -- Agent lifecycle --------------------------------------------------------
  {
    name: "agent.willStart",
    shape: "broadcast-async",
    permission: "hooks:agent.willStart",
    description: "Emitted before plugins activate and the REPL boots.",
  },
  {
    name: "agent.didStart",
    shape: "broadcast-async",
    permission: "hooks:agent.didStart",
    description: "Emitted after plugins activated and bus is live.",
  },
  {
    name: "agent.willStop",
    shape: "broadcast-async",
    permission: "hooks:agent.willStop",
    description: "Emitted at the start of shutdown, before plugin teardown.",
  },
  {
    name: "agent.didStop",
    shape: "broadcast-async",
    permission: "hooks:agent.didStop",
    description: "Emitted after teardown completes; process is about to exit.",
  },

  // -- Turn lifecycle ---------------------------------------------------------
  {
    name: "turn.willStart",
    shape: "chain",
    permission: "hooks:turn.willStart",
    description:
      "Chain hook — listeners may rewrite the user input or veto the turn.",
  },
  {
    name: "turn.didStart",
    shape: "broadcast-async",
    permission: "hooks:turn.didStart",
    description: "Emitted after the turn input is finalized, before the model call.",
  },
  {
    name: "turn.didEnd",
    shape: "broadcast-async",
    permission: "hooks:turn.didEnd",
    description: "Emitted after the model finishes responding.",
  },
  {
    name: "turn.aborted",
    shape: "broadcast-async",
    permission: "hooks:turn.aborted",
    description: "Emitted when a turn is canceled (Ctrl+C, timeout, etc.).",
  },

  // -- Message / wire ---------------------------------------------------------
  {
    name: "message.willSend",
    shape: "chain",
    permission: "hooks:message.willSend",
    description: "Chain hook — listeners may mutate outgoing messages or system prompt.",
  },
  {
    name: "message.didSend",
    shape: "broadcast-async",
    permission: "hooks:message.didSend",
    description: "Emitted after the wire request is dispatched.",
  },
  {
    name: "message.tokens",
    shape: "stream",
    permission: "hooks:message.tokens",
    description: "Live multicast of model output tokens for the current turn.",
  },

  // -- Tool lifecycle ---------------------------------------------------------
  {
    name: "tool.willInvoke",
    shape: "chain",
    permission: "hooks:tool.willInvoke",
    description:
      "Chain hook — listeners may rewrite tool input, swap the tool, or veto.",
  },
  {
    name: "tool.didInvoke",
    shape: "broadcast-async",
    permission: "hooks:tool.didInvoke",
    description: "Emitted after a tool returns (success or failure).",
  },

  // -- REPL lifecycle ---------------------------------------------------------
  {
    name: "repl.didEnterIdle",
    shape: "broadcast-sync",
    permission: "hooks:repl.didEnterIdle",
    description: "Emitted when the prompt becomes idle and ready for input.",
  },
  {
    name: "repl.modeWillChange",
    shape: "chain",
    permission: "hooks:repl.modeWillChange",
    description: "Chain hook — listeners may veto a mode switch.",
  },
  {
    name: "repl.modeDidChange",
    shape: "broadcast-async",
    permission: "hooks:repl.modeDidChange",
    description: "Emitted after the active mode changes.",
  },
] as const satisfies readonly ChannelSpec[]

export type ChannelName = (typeof CHANNELS)[number]["name"]

/** Quick-lookup map; built once at module load. */
export const CHANNEL_BY_NAME: ReadonlyMap<string, ChannelSpec> = new Map(
  CHANNELS.map((c) => [c.name, c]),
)

/** True if `permission` matches `required`, including `*` suffix wildcards. */
export function permissionMatches(granted: string, required: string): boolean {
  if (granted === required) return true
  if (granted.endsWith("*")) {
    const prefix = granted.slice(0, -1)
    return required.startsWith(prefix)
  }
  return false
}

/** True if any granted permission satisfies `required`. */
export function hasPermission(granted: readonly string[], required: string): boolean {
  for (const g of granted) if (permissionMatches(g, required)) return true
  return false
}
