/**
 * Public types and constants for the editor controller: the
 * footer-layer surface, the parsed-key shape, terminal escape
 * sequences for bracketed paste and Kitty/xterm key-encoding modes,
 * and the `EditorControllerOptions` / `EditorKeyResult` /
 * `EditorKeyPayload` shapes consumed by callers.
 *
 * Split out of `src/editor-controller.ts` to keep that file under
 * the `max-lines` lint budget. All public names are re-exported
 * from `editor-controller.ts` for back-compat.
 *
 * @module editor/types
 */

import type { AbortBus } from "../abort-bus.ts"
import type { FsmOptions } from "../abort-quit-fsm.ts"
import type { InputCaptureStack } from "../input-capture-stack.ts"
import type { Hooks } from "../plugins/hooks/hooks.ts"

/**
 * Minimal compositor surface the editor controller depends on. Owns
 * a live area (multi-line in-place region above the prompt) plus an
 * optional scrollback writer used to commit submitted prompts to the
 * terminal's native scrollback before the live area is cleared.
 *
 * Defined in this module (not in `compositor.ts`) so test stubs and
 * the editor can interoperate without pulling the real compositor's
 * heavy dependencies.
 */
export interface CompositorLike {
  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void
  setLiveHeight(n: number): void
  liveHeight: number
  /**
   * Optional. When present, used by `EditorController.submit` to commit
   * the just-submitted prompt into the terminal's native scrollback (so
   * users can scroll up to re-read what they typed) before the live
   * area is cleared for the next turn. Compositors without scrollback
   * (e.g. test stubs) can omit it.
   */
  writeStream?(chunk: string): void
}

// ----------------------------- footer-layer surface -----------------------------
//
// See the long-form comment on `EditorController.footerLayers` below for
// the architecture rationale (Bug 2801: two producers stomping on one
// mutable field). The surface is small and documented public API:
//
//   - producers own a stable `FooterLayerId`;
//   - `setFooterLayer(id, lines, {priority})` registers / updates;
//   - `clearFooterLayer(id)` removes;
//   - render-time composition picks the highest-priority non-empty layer.

/**
 * A stable string id naming one producer's footer-band content. Two
 * producers MUST NOT share a layer id; collisions silently overwrite
 * (last-writer-wins within a single layer is fine, across layers it is
 * the exact bug we are avoiding).
 *
 * Use one of the exported `FOOTER_LAYER_*` constants when the layer is
 * a known canonical surface (e.g. the armed-quit overlay); use a
 * descriptive ad-hoc id for plugin-private overlays.
 */
export type FooterLayerId = string

/**
 * One layer's pinned content + z-index. Stored immutably on the
 * controller; consumers receive a fresh array on every read so they
 * cannot mutate live state.
 *
 * @internal Exported for type assertions in tests; the public mutation
 *   surface is {@link EditorController.setFooterLayer} /
 *   {@link EditorController.clearFooterLayer}.
 */
export interface FooterLayer {
  readonly id: FooterLayerId
  readonly priority: number
  readonly lines: readonly string[]
}

export interface SetFooterLayerOptions {
  /**
   * Higher priority wins composition. When omitted, the previous
   * priority is preserved (or 0 if this is the layer's first set).
   * Negative values are accepted but discouraged; reserve negatives
   * for layers that should sit BELOW the legacy default.
   */
  priority?: number
}

/**
 * The default / legacy layer id. Maps to whatever any caller pushes
 * through the back-compat {@link EditorController.setFooterLines}
 * setter. Lives at priority 0.
 */
export const FOOTER_LAYER_DEFAULT: FooterLayerId = "default"

/**
 * The armed-quit overlay layer id. Pinned by {@link EditorController}'s
 * abort-quit FSM effects; sits at {@link FOOTER_PRIORITY_ARMED}.
 */
export const FOOTER_LAYER_ARMED: FooterLayerId = "armed-quit"

/** Priority of {@link FOOTER_LAYER_ARMED}. */
export const FOOTER_PRIORITY_ARMED = 100

/**
 * Plugin-overlay layer id. Used by the host bridge for the
 * `editor.footer.set` plugin channel — overlays like the slash-menu
 * paint here so the quota-status FooterAggregator (which writes to
 * {@link FOOTER_LAYER_DEFAULT}) doesn't stomp them on its next refresh.
 *
 * Sits between DEFAULT (0) and ARMED (100) at {@link FOOTER_PRIORITY_OVERLAY}
 * (50). A plugin overlay visually obscures the quota row while open;
 * the armed-quit confirm modal is critical enough to obscure even the
 * overlay.
 */
export const FOOTER_LAYER_OVERLAY: FooterLayerId = "overlay"

/** Priority of {@link FOOTER_LAYER_OVERLAY}. */
export const FOOTER_PRIORITY_OVERLAY = 50

export interface EditorControllerOptions {
  prompt: string
  continuationPrompt: string
  compositor: CompositorLike
  stdin?: NodeJS.ReadStream
  output?: Pick<NodeJS.WriteStream, "write">
  /**
   * Maximum live-area height in physical rows (status row + editor rows
   * combined). When the buffer exceeds the editor's share of this budget
   * (`maxLiveHeight - statusRows`), the editor scrolls a window onto the
   * buffer so the cursor's logical line stays visible.
   *
   * Pass a number for a static cap, or a function for a dynamic cap that
   * tracks the terminal's current row count.
   *
   * Defaults to `Infinity` (no cap) for backwards-compatible tests.
   */
  maxLiveHeight?: number | (() => number)
  /**
   * When `true`, invisible characters (spaces as `·`, tabs as `→`,
   * line-ends as `↵`) are shown as faint glyphs in the editor.
   * Toggle at runtime via {@link EditorController.setShowHidden}.
   *
   * Enabled automatically by `MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1` or
   * `--show-hidden-chars` CLI flag, or by a manifest mode with
   * `editorShowHidden: true`.
   */
  showHidden?: boolean
  /**
   * Bare-Esc disambiguation window in milliseconds. Esc is the lead byte
   * of every CSI escape sequence (`\x1b[A`, `\x1b[200~`, etc.), so when
   * we see a lone `\x1b` in `pending` we cannot tell yet whether it's
   * "user pressed Esc and stopped" or "more bytes are en route across a
   * second stdin chunk". We arm a short timer; if no follow-up bytes
   * arrive before it fires, we treat the byte as a true bare Esc and
   * route it to {@link AbortBus.requestAbort}.
   *
   * 20ms is short enough to feel instant and long enough to swallow the
   * cross-chunk gap on typical terminals. Override via test harness.
   *
   * Default: 20.
   */
  bareEscapeMs?: number
  /**
   * Debounce window (ms) for the `"input"` event. The event fires this
   * long after the most recent buffer-text change. Default: 120ms - short
   * enough to feel live, long enough to coalesce a fast typist's stream
   * into a single notification per pause. Set to 0 in tests to fire
   * synchronously.
   */
  inputDebounceMs?: number
  /**
   * Coalescing window (ms) for resize-driven repaints. A terminal-edge
   * DRAG fires one SIGWINCH per column step; each repaint of a near-
   * viewport-tall live area can leave a reflow residue in scrollback
   * (the terminal scrolls the live area's top rows above the viewport
   * before we can erase them - see compositor `notifyResize` doc). Without
   * coalescing, a single drag stacks dozens of duplicate live areas into
   * permanent scrollback.
   *
   * With this set, {@link EditorController.notifyResize} debounces: it
   * arms a trailing timer and repaints ONCE, `resizeDebounceMs` after the
   * LAST resize event, so a continuous drag collapses to a single repaint
   * at the final geometry. The compositor still emits nothing on each
   * intermediate SIGWINCH (its HARD RULE), so no per-step bytes are sent.
   *
   * Default: 150ms - long enough to fully swallow a drag's SIGWINCH burst
   * (measured: a 120→48 drag leaks 25 duplicate live areas at 0ms, 10 at
   * 80ms, and 0 at \>=150ms), short enough that a deliberate single resize
   * still feels instant. Set to 0 to repaint synchronously on every resize
   * (legacy behavior; used by tests that assert a repaint-per-resize).
   */
  resizeDebounceMs?: number
  /**
   * Inject the {@link AbortBus} singleton (or a fresh one for tests). When
   * a turn is in flight (`abortBus.isTurnInFlight()`) and the user presses
   * bare Esc or Ctrl+C, this controller calls
   * `abortBus.requestAbort({kind:"user-key", key:"Esc"|"Ctrl+C"})`. The
   * abort-quit FSM also decides whether to arm the quit-confirm window
   * (Ctrl+C arms it, Esc does not - see {@link FsmState}).
   *
   * Defaults to the singleton from `./abort-bus.ts`.
   */
  abortBus?: AbortBus
  /**
   * Options forwarded to the abort-quit FSM. Currently just
   * `armedDurationMs` (default 10s). Override in tests to shorten the
   * confirmation window.
   */
  quitFsm?: FsmOptions
  /**
   * Custom clock for the abort-quit FSM + escape hatch. Default
   * `Date.now`. Injecting a fake clock lets tests drive the countdown
   * without real timers.
   */
  nowFn?: () => number
  /**
   * Override the recurring armed-state tick interval. Default 250ms (4
   * paints/sec while armed). Tests can set this very small or 0 to
   * disable the timer (and drive ticks manually).
   */
  armedTickMs?: number
  /**
   * Optional {@link Hooks} facade. When provided, the editor emits the
   * `editor.key` broadcast-sync channel BEFORE applying selected
   * navigation/control keys (currently: ArrowUp, ArrowDown, Ctrl+R).
   * Listeners may set `result.halt = true` to consume the keystroke and
   * optionally `result.buffer` / `result.cursor` to replace editor state.
   *
   * When omitted (tests / no-plugin runs), the editor skips the emit
   * entirely — no behavioral change.
   */
  hooks?: Hooks
  /**
   * Inject the {@link InputCaptureStack} singleton (or a fresh one for
   * tests). The stack sits in FRONT of the `editor.key` hook chain in
   * the ESC dispatch pipeline: top-of-stack gets first crack, then the
   * chain, then the abort-quit FSM.
   *
   * Push onto this stack when an overlay opens that owns "ESC means
   * me, not abort" — the reflection cooldown, future confirm modals,
   * or any plugin that needs strict LIFO precedence over peer overlays.
   *
   * Defaults to the singleton from `./input-capture-stack.ts`.
   */
  inputCaptureStack?: InputCaptureStack
}

/**
 * Mutable holder injected into the `editor.key` payload. Listeners write
 * back into this object to influence the editor's response to the key.
 *
 * Convention: leave fields untouched when you want pass-through; set
 * `halt: true` to suppress default handling; set `buffer` / `cursor` to
 * replace editor state in addition to (or instead of) halting.
 */
export interface EditorKeyResult {
  halt?: boolean
  buffer?: string
  cursor?: { row: number; col: number }
}

/**
 * Payload shape for the `editor.key` channel. See
 * `plugins/hooks/channels.ts` for the channel description.
 *
 * `cursor.visualRow` / `cursor.rowsInLogicalLine` are the renderer's
 * wrap-aware coordinates of the cursor's CURRENT logical line — the
 * history plugin uses them to decide whether ↑/↓ should steal the key
 * (only when cursor is on the first/last visual row of the buffer).
 */
export interface EditorKeyPayload {
  /** Canonical key name. Currently emitted: "ArrowUp", "ArrowDown", "Ctrl+R". */
  key: string
  /** Current full buffer text (with `\n` line separators). */
  buffer: string
  /** Logical cursor position + wrap-aware visual context. */
  cursor: {
    row: number
    col: number
    /** 0-based wrap chunk within the current logical line. */
    visualRow: number
    /** Total wrap rows the current logical line occupies. */
    rowsInLogicalLine: number
    /** Total logical lines in the buffer. */
    totalLines: number
  }
  /**
   * Mutable holder. Listeners write to `result.halt` / `result.buffer`
   * / `result.cursor` to influence the editor's response. Initialized
   * to `{}` by the editor before each emit.
   */
  result: EditorKeyResult
}

export type ParsedKey = {
  code: number
  modifiers: number
  eventType: number
  text: string | null
}

/**
 * Context the editor hands to a {@link QueueKeyHandler} on every
 * queue-navigation-eligible keystroke. Lets the host decide whether to
 * claim the key without the host having to track editor buffer state.
 */
export interface QueueKeyContext {
  /** Current full editor buffer text (with `\n` line separators). */
  buffer: string
  /**
   * True when the cursor sits on the FIRST visual row of the buffer
   * (logical row 0 AND visual wrap-chunk 0). The host uses this to gate
   * "↑ at the top opens queue navigation" so an ↑ that should move the
   * cursor up within a multi-line draft is left to the editor.
   */
  atTop: boolean
}

/**
 * Result a {@link QueueKeyHandler} returns for a single keystroke.
 *
 * `handled === false` is pure pass-through: the editor runs its normal
 * default for the key (insert the char, submit, cursor-up, abort, …) as
 * if no handler were wired. `handled === true` consumes the key; when
 * `buffer` is also set the editor replaces its buffer with that text and
 * parks the cursor at the end (same semantics as `setBuffer`).
 */
export interface QueueKeyResult {
  handled: boolean
  buffer?: string
}

/**
 * Host hook for the submit-queue navigation UI (dequeue / remove /
 * dequeue-all driven from the prompt). Wired via
 * `EditorController.setQueueKeyHandler`. Invoked synchronously BEFORE
 * the editor's default handling for the keys it cares about: `ArrowUp`,
 * `ArrowDown`, `Enter`, `Escape`, and single printable characters
 * (`d` / `x` / `k`, plus any other printable while the nav overlay is
 * open, which it swallows to stay modal).
 *
 * The handler is the single source of truth for "is the nav overlay
 * open" — the editor never tracks that state. When the overlay is
 * closed the handler returns `{handled:false}` for everything except an
 * `ArrowUp` that should open it (or single-item dequeue). Cheap to call
 * on every eligible keystroke: one boolean check in the common path.
 */
export type QueueKeyHandler = (key: string, ctx: QueueKeyContext) => QueueKeyResult

export const BRACKETED_PASTE_START = "\x1b[200~"
export const BRACKETED_PASTE_END = "\x1b[201~"
export const KITTY_KEYBOARD_ENABLE = "\x1b[>31u"
export const KITTY_KEYBOARD_DISABLE = "\x1b[<u"
export const XTERM_FORMAT_OTHER_KEYS_ENABLE = "\x1b[>4;1f"
export const XTERM_FORMAT_OTHER_KEYS_DISABLE = "\x1b[>4f"
export const XTERM_MODIFY_OTHER_KEYS_ENABLE = "\x1b[>4;2m"
export const XTERM_MODIFY_OTHER_KEYS_DISABLE = "\x1b[>4m"
