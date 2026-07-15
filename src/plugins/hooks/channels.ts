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
      "Chain hook fired just before a queued user prompt is handed to the model. " +
      "Payload `{text: string}` is the raw buffer text (what the user typed). " +
      "Listeners may return `{payload: {text}}` to rewrite the model-facing " +
      "content (e.g. expand `@Michelle` into a peer XML tag) without changing " +
      "scrollback commit lines, or `{halt: true}` to veto the turn. The host " +
      "emits this from the REPL queue-drain path after shifting an item and " +
      "before `agent.run(text)`.",
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
    description: "Chain hook — listeners may rewrite tool input, swap the tool, or veto.",
  },
  {
    name: "tool.didInvoke",
    shape: "chain",
    permission: "hooks:tool.didInvoke",
    description:
      "Chain hook fired AFTER a tool returns (success or failure), BEFORE the " +
      "agent renders the result and pushes it to the model. Payload is a " +
      "ToolDidInvokePayload (see plugins/hooks/tool-lifecycle.ts) carrying the " +
      "tool name/input/cwd/ok/filePath plus two accumulators: `findings` " +
      "(structured results the AGENT renders into its own gutter/palette " +
      "chrome) and `notes` (model-facing one-liners the agent wraps in a " +
      "`<ma::agent::diagnostics>` annotation). Listeners push into the " +
      "accumulators and `return {payload}`; the agent reads the union back. " +
      "The diagnostics plugin (LSP/linter/formatter feedback) is the first " +
      "consumer, but the shape is tool-agnostic. Observation-only listeners " +
      "just watch.",
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

  // -- Editor surface (history plugin, May 2026) -----------------------------
  {
    name: "editor.key",
    shape: "broadcast-sync",
    permission: "hooks:editor.key",
    description:
      "Sync broadcast fired BEFORE the editor applies a parsed key (arrow keys, " +
      "Ctrl+R, etc.). Payload carries `{key, buffer, cursor, result}` where " +
      "`result` is a mutable holder. Listeners may set `result.halt = true` to " +
      "consume the keystroke (suppress default handling) and optionally " +
      "`result.buffer`/`result.cursor` to replace editor state. Synchronous by " +
      "necessity — the editor's keystroke pump must not yield to async work " +
      "between bytes.",
  },
  {
    name: "editor.buffer.set",
    shape: "broadcast-sync",
    permission: "hooks:editor.buffer.set",
    description:
      "Plugin → host signal to replace the editor buffer. Payload `{text, " +
      "cursor?}`. The host listens on this channel and calls " +
      "EditorController.setBuffer(text) on the next repaint.",
  },
  {
    name: "editor.buffer.changed",
    shape: "broadcast-async",
    permission: "hooks:editor.buffer.changed",
    description:
      "Fires after the editor buffer text changes. Payload `{text, cursor: " +
      "{row, col}}`. Dedup'd: only emits when the new text differs from the " +
      "last-emitted text. Use for overlays / autocomplete that need to " +
      "re-render their UI on each edit (slash-menu, @-mentions, file picker, " +
      "etc.). Async to avoid back-pressure on the keystroke pump.",
  },
  {
    name: "editor.footer.set",
    shape: "broadcast-sync",
    permission: "hooks:editor.footer.set",
    description:
      "Plugin → host signal to paint a footer below the editor. Payload " +
      "`{lines: string[]}`. Empty array clears the footer. The host listens " +
      "and calls EditorController.setFooterLines() on the next repaint. " +
      "Mirrors the editor.buffer.set pattern. Used by overlays (slash-menu) " +
      "that want to draw without grabbing the EditorController directly.",
  },
  {
    name: "editor.buffer.styles",
    shape: "broadcast-sync",
    permission: "hooks:editor.buffer.styles",
    description:
      "Plugin → host signal to style ranges of the editor buffer (e.g. " +
      "at-mentions). Payload `{spans: Array<{start:number, end:number, " +
      "style: string}>}` where start/end are code-point offsets into the " +
      "full buffer string (join lines with `\\n`), and `style` is an SGR " +
      "open sequence (or a named token later). Empty spans clears. The host " +
      "listens and calls EditorController.setBufferStyles() on the next " +
      "repaint. Styles paint live input and are also baked into submit " +
      "commitLines so scrollback keeps the highlight.",
  },
  {
    name: "editor.overlay.open",
    shape: "broadcast-sync",
    permission: "hooks:editor.overlay.open",
    description:
      "Plugin → host signal to open a MODAL overlay that OWNS the input line. " +
      "Payload `{owner: string}` — a stable id for the opening overlay (its " +
      "plugin id). While owned, the host: (a) hides the prompt row + cursor so " +
      "the user can't type into a phantom buffer underneath the overlay, " +
      "(b) blocks `submit()` so the typed `/cmd` line can never leak to " +
      "scrollback, and (c) routes EVERY key — including printable characters " +
      "and Backspace — through the `editor.key` hook (printables arrive as " +
      'single-char `key` values, Backspace as `"Backspace"`) so the owner ' +
      "drives its own text input via an internal draft instead of the shared " +
      "prompt buffer. Used by interactive command TUIs (/config, /usage). " +
      "Distinct from `editor.footer.set`, which only paints and leaves the " +
      "prompt live underneath. The owner MUST emit `editor.overlay.close` when " +
      "it dismisses, or pass an empty `{lines:[]}` footer is NOT enough.",
  },
  {
    name: "editor.overlay.close",
    shape: "broadcast-sync",
    permission: "hooks:editor.overlay.close",
    description:
      "Plugin → host signal to release a modal overlay opened with " +
      "`editor.overlay.open`. Payload `{owner: string}` (same id). The host " +
      "restores the prompt row + cursor and resumes normal key handling. " +
      "Idempotent + owner-checked: a close from a non-owner is ignored, so a " +
      "stale handler can't tear down a different overlay.",
  },
  {
    name: "prompt.submitted",
    shape: "broadcast-async",
    permission: "hooks:prompt.submitted",
    description:
      "Emitted after the user submits a non-empty prompt (queued for the agent). " +
      "Payload `{text, cwd, sid, exit, queuePos}`. `exit ∈ {submitted, canceled}`.",
  },
  {
    name: "command.run",
    shape: "broadcast-async",
    permission: "hooks:command.run",
    description:
      "Plugin → host request to dispatch a registered slash command by line, " +
      'e.g. `{line: "/config"}`. The host runs it through the SAME registry ' +
      "path as a typed `/cmd` submit (`dispatchCommand` → act on the " +
      "CommandResult), WITHOUT routing through the editor buffer / submit. " +
      "This is what the slash-menu uses when the user picks a command row: one " +
      "Enter dispatches the command (opening its TUI) instead of the fragile " +
      "'rewrite the buffer then fake a submit' path, which raced the async " +
      "editor.buffer.changed re-open. Unknown / non-command lines are ignored. " +
      "For skills (model-routed) the menu still rewrites the buffer + submits; " +
      "only registered commands use this channel.",
  },
  {
    name: "prompt.inject",
    shape: "broadcast-async",
    permission: "hooks:prompt.inject",
    description:
      "Plugin → host request to enqueue a prompt as if the user had submitted it. " +
      "Payload `{text, source?}`. The REPL listens and routes the text through the " +
      "same queue/persist/wake/fan-out path as a real submit, so an injected prompt " +
      "fires BETWEEN turns (never mid-response) and survives crash/resume like any " +
      "queued submit. Blank text is ignored. Used by the `schedule` plugin's " +
      "heartbeat to run a scheduled prompt; reusable by any out-of-band injector " +
      "(CI push, channels, a watcher). `source` is a free-form origin tag for " +
      'diagnostics (e.g. `"cron:a1b2c3d4"`).',
  },
  {
    name: "notification.emit",
    shape: "broadcast-async",
    permission: "hooks:notification.emit",
    description:
      "Plugin → host request to surface an async, between-turns notification to " +
      "the USER (a framed scrollback toast), NOT to the model. Rides the same " +
      "fire-and-forget EventBus as `prompt.inject`. Payload " +
      "`{source?, block?, text?}`: `block` is a CommandNoticeBlock (icon/title/" +
      "info/color/body[]/footer) the plugin styles and the HOST frames with its " +
      "own tool-transcript chrome (so plugins never hand-draw ╭│╰ borders or " +
      "write to a process stream); `text` is the plain, ANSI-free line the host " +
      "persists to the session JSONL as a note record (audit/record, survives " +
      "resume, never folded into model context); `source` is a free-form origin " +
      'tag (e.g. `"intercom"`) for routing + future sinks. The intercom ' +
      "arrival toast is the first consumer. Replaces the anti-pattern of a " +
      "plugin writing its own frame to ctx.stderr.",
  },

  // -- Sub-agent lifecycle (delegation plugins) ------------------------------
  // Generic delegation signals. The agent core never emits or consumes these;
  // a delegation plugin (e.g. `sub-agents`) emits them around spawning a
  // background worker, and any plugin may listen. Report-back to the PARENT
  // rides the existing `prompt.inject` channel, not a new one.
  {
    name: "subagent.willSpawn",
    shape: "chain",
    permission: "hooks:subagent.willSpawn",
    description:
      "Chain hook fired BEFORE a delegation plugin spawns a worker. Payload carries " +
      "the proposed spawn `{task, agent?, model, isolation, depth, leadSid, ...}`. " +
      "Listeners may rewrite it (e.g. clamp model/effort) or `{halt:true, reason}` to " +
      "veto — the guardrail seam for depth/nesting caps, concurrency limits, budget, " +
      "and spawnable-type allowlists. Observation-only listeners just watch.",
  },
  {
    name: "subagent.didSpawn",
    shape: "broadcast-async",
    permission: "hooks:subagent.didSpawn",
    description:
      "Emitted after a worker process is launched. Payload `{id, sid, label, type, " +
      "model, pid, leadSid}`. For dashboards / presence / task-linkage reactions.",
  },
  {
    name: "subagent.didReport",
    shape: "broadcast-async",
    permission: "hooks:subagent.didReport",
    description:
      "Emitted when a worker produces a result or progress checkpoint. Payload " +
      "`{id, sid, status, resultShort?, tokens?}`. The supervisor typically follows " +
      "this with a `prompt.inject` so the lead folds the result in between turns.",
  },
  {
    name: "subagent.didExit",
    shape: "broadcast-async",
    permission: "hooks:subagent.didExit",
    description:
      "Emitted when a worker process terminates (clean, error, stopped, or timed " +
      "out). Payload `{id, sid, exit, status}`. Distinct from didReport: a worker can " +
      "report then exit, or exit without reporting (crash).",
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
