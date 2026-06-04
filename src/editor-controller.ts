/**
 * Persistent multiline editor driven by raw stdin and rendered through a
 * {@link Compositor}'s live area.
 *
 * Unlike {@link RawInput}, which mounts and unmounts on every read, an
 * `EditorController` is started once and stays alive for the entire REPL
 * session. Submits emit events; the buffer is cleared in place; raw mode
 * and bracketed paste stay enabled the whole time. This is what keeps the
 * "❯ " prompt visible while the agent is working.
 *
 * @module editor-controller
 */

import { EventEmitter } from "node:events"

import { type AbortBus, abortBus } from "./abort-bus.ts"
import {
  EscapeHatch,
  type FsmEffect,
  type FsmOptions,
  type FsmState,
  step as fsmStep,
  initialState as initialFsmState,
  type QuitReason,
} from "./abort-quit-fsm.ts"
import { formatArmedFooter } from "./armed-footer.ts"
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  type CompositorLike,
  type EditorControllerOptions,
  type EditorKeyPayload,
  type EditorKeyResult,
  FOOTER_LAYER_ARMED,
  FOOTER_LAYER_DEFAULT,
  FOOTER_LAYER_OVERLAY,
  FOOTER_PRIORITY_ARMED,
  FOOTER_PRIORITY_OVERLAY,
  type FooterLayer,
  type FooterLayerId,
  KITTY_KEYBOARD_DISABLE,
  KITTY_KEYBOARD_ENABLE,
  type ParsedKey,
  type QueueKeyContext,
  type QueueKeyHandler,
  type QueueKeyResult,
  type SetFooterLayerOptions,
  XTERM_FORMAT_OTHER_KEYS_DISABLE,
  XTERM_FORMAT_OTHER_KEYS_ENABLE,
  XTERM_MODIFY_OTHER_KEYS_DISABLE,
  XTERM_MODIFY_OTHER_KEYS_ENABLE,
} from "./editor/types.ts"
import { EditorBuffer } from "./editor-buffer.ts"
import { computeCursorVisualPos, EditorRenderer, findColAtVisualPos } from "./editor-renderer.ts"
import { type InputCaptureStack, inputCaptureStack } from "./input-capture-stack.ts"
import type { Hooks } from "./plugins/hooks/hooks.ts"
import { displayWidth, truncateDisplayWidth } from "./term-width.ts"

// Public surface lives in `src/editor/types.ts` and is re-exported here
// so external consumers (commands, tests, plugins) keep their existing
// `import { ... } from "./editor-controller.ts"` paths.
export type {
  CompositorLike,
  EditorControllerOptions,
  EditorKeyPayload,
  EditorKeyResult,
  FooterLayer,
  FooterLayerId,
  QueueKeyContext,
  QueueKeyHandler,
  QueueKeyResult,
  SetFooterLayerOptions,
}
export {
  FOOTER_LAYER_ARMED,
  FOOTER_LAYER_DEFAULT,
  FOOTER_LAYER_OVERLAY,
  FOOTER_PRIORITY_ARMED,
  FOOTER_PRIORITY_OVERLAY,
}

/**
 * Active controllers with raw mode currently engaged. Process-level cleanup
 * hooks below restore terminal state if we're killed by a signal.
 */
const activeControllers = new Set<EditorController>()
let cleanupHooksInstalled = false
function installCleanupHooksOnce(): void {
  if (cleanupHooksInstalled) return
  cleanupHooksInstalled = true
  const restoreAll = () => {
    for (const c of activeControllers) {
      try {
        c.emergencyRestore()
      } catch {
        // best-effort
      }
    }
  }
  process.on("exit", restoreAll)
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      restoreAll()
      process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1))
    })
  }
}

export class EditorController extends EventEmitter {
  private readonly buf = new EditorBuffer()
  private readonly renderer: EditorRenderer
  private readonly compositor: CompositorLike
  private readonly stdin: NodeJS.ReadStream
  private readonly output: Pick<NodeJS.WriteStream, "write">
  private readonly maxLiveHeight: () => number
  private viewportTop = 0
  private pending = ""
  private bracketedPaste = false
  /**
   * Coalescing window (ms) for resize-driven repaints; see
   * {@link EditorControllerOptions.resizeDebounceMs}. 0 = synchronous.
   */
  private readonly resizeDebounceMs: number
  /** Trailing-edge timer that fires the single coalesced resize repaint. */
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Optional synchronous transform applied to bracketed-paste text before it
   * is inserted. Returns a replacement string (e.g. a media token for a dropped
   * image) to insert instead, or `null` to insert the paste literally. Set by
   * the host via {@link setPasteInterceptor}; unset by default (no behavior
   * change). Must not throw : a throw is caught and the paste inserts literally.
   */
  private pasteInterceptor?: (pasted: string) => string | null
  /**
   * Optional Ctrl+V handler. Returns the text to insert (clipboard text, or a
   * media token for a clipboard image), or `null` for "nothing to paste".
   * Wired by the host via {@link setClipboardPasteHandler}. The returned text
   * is run through {@link insertPasted}, so a returned drop-path still gets the
   * normal {@link pasteInterceptor} media treatment. Must not throw : a throw
   * is caught and the keystroke becomes a no-op (no literal `\x16` inserted).
   */
  private clipboardPaste?: () => string | null
  private started = false
  private cycleForward: (() => void) | null = null
  private cycleBackward: (() => void) | null = null
  /**
   * Alt+M interrupt-and-apply-mode handler. Wired by the REPL.
   *
   * Fires only when the host opts in by calling
   * {@link setModeInterruptHandler}. The keypress is otherwise dropped
   * (no literal `m` inserted, no surprises) : the wiring is per-host,
   * not always-on.
   */
  private modeInterrupt: (() => void) | null = null
  /**
   * Submit-queue navigation hook. Wired by the REPL via
   * {@link setQueueKeyHandler}. Consulted BEFORE default handling for
   * ArrowUp / ArrowDown / Enter / Escape / printable keys so the host
   * can run the dequeue / remove / dequeue-all overlay. Null (the
   * default, and in tests / no-queue runs) means "no queue nav" and the
   * editor behaves exactly as before. See {@link tryQueueNav}.
   */
  private queueKeyHandler: QueueKeyHandler | null = null
  /**
   * Optional builder that returns the prompt prefix to bake into
   * {@link submit}'s `commitLines` AT submit-time. When set, replaces
   * the renderer's cached `this.prompt` for the commit-render call
   * (the live prompt continues to use the cached value).
   *
   * Why: a mode toggle can race with Enter (Shift+Tab arrives, the
   * subscriber repaints, BUT a stale repaint via resize / debounce
   * could leave the cached prefix one tick behind). The mode-change
   * attachment that ships with the turn always reflects the active
   * mode at consume-time, so the scrollback prefix should match. The
   * cleanest fix is to query the freshest prefix at commit-time.
   *
   * Pass `null` to detach. When unset, the cached
   * `this.renderer.prompt` is used (current behavior, byte-stable).
   */
  private commitPromptBuilder: (() => string) | null = null
  private showHiddenChars = false
  /**
   * Sticky "preferred visual column" for wrap-aware up/down navigation.
   * Set on the FIRST up/down keystroke after any other move so a long
   * column of `j`/`k` (or arrow keys) walks straight up/down even past
   * short rows. Implicitly reset by {@link moveUpVisual}/{@link moveDownVisual}
   * when they detect the cursor has moved away from where the previous
   * vertical move parked it - see {@link lastVerticalEndRow}.
   *
   * Why no explicit "reset on every non-vertical action": doing so
   * would require touching ~30 keystroke handler sites (left/right,
   * line start/end, word jumps, every edit, paste, submit, abort,
   * etc.). The endpoint-match probe achieves the same semantics with
   * zero instrumentation cost - any action that mutates `buf.row`
   * or `buf.col` away from the last vertical-move endpoint invalidates
   * the sticky column on the next up/down keystroke.
   */
  private desiredVisualCol: number | null = null
  /**
   * Buffer (row, col) where the previous successful vertical move left
   * the cursor. {@link moveUpVisual}/{@link moveDownVisual} compare these
   * to the cursor's current position on entry - a mismatch means some
   * non-vertical action ran in between and the sticky column is stale.
   *
   * `null` means "no vertical move has happened yet this session" (or
   * a vertical move returned false because cursor couldn't move) -
   * treated as a mismatch, forcing a fresh sample.
   */
  private lastVerticalEndRow: number | null = null
  private lastVerticalEndCol: number | null = null
  private readonly bareEscapeMs: number
  private readonly abortBus: AbortBus
  /**
   * Optional hooks facade. Non-null when constructed with `hooks` opt.
   * Only consulted before applying intercept-eligible keys (currently
   * ArrowUp, ArrowDown, Ctrl+R). Null means "skip the emit, run default".
   */
  private readonly hooks: Hooks | null
  /**
   * LIFO transient capture stack consulted BEFORE {@link hooks} on the
   * ESC dispatch path. See {@link InputCaptureStack} for the design;
   * see {@link fireBareEscape} / {@link consumeEscape} for the order.
   */
  private readonly inputCaptureStack: InputCaptureStack
  private bareEscapeTimer: ReturnType<typeof setTimeout> | null = null
  // ── abort/quit FSM ──────────────────────────────────────────────────────
  //
  // Owns the Ctrl+C / Esc → abort / quit-confirm state machine. Kept inside
  // the editor (rather than the REPL) because every input byte for the
  // FSM passes through here AND so does the footer rendering, so the two
  // halves don't need to round-trip events.
  //
  // See {@link applyEffects} for the effect → IO mapping. The host
  // subscribes to the `"quit"` event (replaces the old `"cancel"` event).
  private fsmState: FsmState = initialFsmState()
  private readonly fsmOptions: FsmOptions
  private readonly nowFn: () => number
  private readonly escapeHatch = new EscapeHatch()
  private readonly armedTickMs: number
  private armedTicker: ReturnType<typeof setInterval> | null = null
  private armedExpireTimer: ReturnType<typeof setTimeout> | null = null
  /** Cached armed-source so re-paints (every 250ms) reuse it. */
  private armedSource: "idle-confirm" | "post-abort" | null = null
  /** Cached armed expiresAt so the tick painter can format the countdown. */
  private armedExpiresAt = 0
  // ── input-event broadcasting ────────────────────────────────────────────
  // Coalesced "buffer text changed" notification. Listeners (e.g. the
  // auto-ASK heuristic) subscribe via `editor.on("input", ...)`. Fires
  // only when the buffer's text differs from the last emitted snapshot
  // (cursor-only moves do NOT fire), with a `inputDebounceMs` debounce
  // so a fast typist gets one event per pause, not one per keystroke.
  // Producer-side debouncing keeps the keystroke path free of listener
  // work - the timer callback is the only thing that runs on the event
  // loop after typing stops, and listeners run inside that callback (so
  // a slow listener delays only the NEXT debounce window, not the next
  // keystroke).
  private inputDebounce: ReturnType<typeof setTimeout> | null = null
  private lastEmittedInputText: string | null = null
  /**
   * Last buffer text we broadcast on `editor.buffer.changed`. Separate
   * from {@link lastEmittedInputText} because the `"input"` EventEmitter
   * channel is debounced (~120 ms by default) and the
   * `editor.buffer.changed` plugin channel is not — overlays like the
   * slash menu need per-edit precision.
   */
  private lastEmittedBufferText: string | null = null
  private inputSeq = 0
  private readonly inputDebounceMs: number
  private onDataBound = (chunk: string | Buffer): void => {
    this.onData(chunk)
  }

  constructor(opts: EditorControllerOptions) {
    super()
    this.renderer = new EditorRenderer({
      prompt: opts.prompt,
      continuationPrompt: opts.continuationPrompt,
      showHidden: opts.showHidden ?? false,
    })
    this.showHiddenChars = opts.showHidden ?? false
    this.compositor = opts.compositor
    this.stdin = opts.stdin ?? process.stdin
    this.output = opts.output ?? process.stdout
    const cap = opts.maxLiveHeight ?? Number.POSITIVE_INFINITY
    this.maxLiveHeight = typeof cap === "function" ? cap : () => cap
    this.bareEscapeMs = opts.bareEscapeMs ?? 20
    this.inputDebounceMs = opts.inputDebounceMs ?? 120
    this.resizeDebounceMs = opts.resizeDebounceMs ?? 150
    this.abortBus = opts.abortBus ?? abortBus
    this.fsmOptions = opts.quitFsm ?? {}
    this.nowFn = opts.nowFn ?? (() => Date.now())
    this.armedTickMs = opts.armedTickMs ?? 250
    this.hooks = opts.hooks ?? null
    this.inputCaptureStack = opts.inputCaptureStack ?? inputCaptureStack
  }

  /**
   * Build the `editor.key` payload, fire the broadcast-sync emit, and
   * apply any state mutations listeners wrote into `result`. Returns
   * `true` if a listener set `result.halt` (caller skips default
   * handling); `false` if pass-through (caller runs default).
   *
   * Cheap when no listeners are registered — `Hooks.emitSync` short-
   * circuits on a Map lookup + empty-array check (~ microseconds). Safe
   * to call from the keystroke pump on every eligible key.
   *
   * @param key Canonical key name ("ArrowUp", "ArrowDown", "Ctrl+R", …).
   * @internal
   */
  private dispatchKeyHook(key: string): boolean {
    if (!this.hooks) return false
    const cols = (this.output as { columns?: number }).columns
    const line = this.buf.lines[this.buf.row] ?? ""
    const promptW = this.renderer.promptDisplayWidthForRow(this.buf.row)
    let visualRow = 0
    let rowsInLogicalLine = 1
    if (cols && cols > 0) {
      const cur = computeCursorVisualPos(line, this.buf.col, promptW, cols)
      visualRow = cur.visualRow
      rowsInLogicalLine = cur.rowsInLine
    }
    const payload: EditorKeyPayload = {
      key,
      buffer: this.buf.toString(),
      cursor: {
        row: this.buf.row,
        col: this.buf.col,
        visualRow,
        rowsInLogicalLine,
        totalLines: this.buf.lines.length,
      },
      result: {},
    }
    try {
      this.hooks.emitSync("editor.key", payload)
    } catch (e) {
      // emitSync absorbs listener errors itself; an exception here means
      // the bus itself threw (e.g. shape mismatch). Best-effort log
      // and fall through to default handling.
      process.stderr.write(
        `[editor-controller] editor.key emit threw: ${e instanceof Error ? e.message : String(e)}\n`,
      )
      return false
    }
    if (payload.result.buffer !== undefined) {
      this.setBuffer(payload.result.buffer)
      // setBuffer already calls repaint(); cursor placement below may
      // override the default end-of-buffer cursor that setBuffer parks at.
    }
    if (payload.result.cursor) {
      this.buf.row = payload.result.cursor.row
      this.buf.col = payload.result.cursor.col
      if (this.started) this.repaint()
    }
    return payload.result.halt === true
  }

  // ── abort/quit FSM helpers ──────────────────────────────────────────────

  /** For tests / diagnostics. */
  fsmStateForTest(): FsmState {
    return this.fsmState
  }

  /**
   * The {@link InputCaptureStack} this controller routes ESC through
   * before the hook chain and the abort-quit FSM. Exposed so agent-
   * side / host-side overlays (reflection cooldown, future confirm
   * modals) can `push` onto it without taking a separate import on
   * the singleton — useful for tests that inject a fresh stack.
   */
  captureStack(): InputCaptureStack {
    return this.inputCaptureStack
  }

  /**
   * Drive the abort-quit FSM with an input and apply the resulting
   * effects to the editor / abortBus / footer. Returns the effects so
   * tests can assert on them without scraping side-effects.
   */
  private feedFsm(input: Parameters<typeof fsmStep>[1]): FsmEffect[] {
    const r = fsmStep(this.fsmState, input, this.fsmOptions)
    this.fsmState = r.state
    if (r.effects.length > 0) this.applyEffects(r.effects)
    return r.effects
  }

  private applyEffects(effects: FsmEffect[]): void {
    for (const e of effects) {
      switch (e.kind) {
        case "abort-turn": {
          // Forward to the abort bus. The bus is idempotent - if no turn
          // is in flight, this is a no-op.
          if (this.abortBus.isTurnInFlight()) {
            this.abortBus.requestAbort({ kind: "user-key", key: "Ctrl+C" })
          }
          break
        }
        case "show-armed": {
          this.armedSource = e.source
          this.armedExpiresAt = e.expiresAt
          this.repaintArmedFooter()
          this.startArmedTimers(e.expiresAt)
          break
        }
        case "hide-armed": {
          this.armedSource = null
          this.armedExpiresAt = 0
          this.stopArmedTimers()
          // Drop ONLY the armed-quit layer. Any base content (quota row,
          // last-warning, etc.) on lower-priority layers re-emerges via
          // composition. Pre-Bug-2801 this called `setFooterLines([])`
          // which blew away the aggregator's content.
          this.clearFooterLayer(FOOTER_LAYER_ARMED)
          break
        }
        case "quit": {
          this.stopArmedTimers()
          // Same single-layer scope as `hide-armed`. The editor is
          // about to tear down and the host prints the goodbye banner;
          // clearing base content here would just be busywork.
          this.clearFooterLayer(FOOTER_LAYER_ARMED)
          // Emit AFTER footer cleanup so the REPL teardown path sees a
          // clean editor state.
          this.emit("quit", e.reason)
          // For back-compat with consumers (draft-store cleanup, REPL
          // exit loop) that listen on the legacy "cancel" event.
          this.emit("cancel", e.reason)
          break
        }
      }
    }
  }

  private startArmedTimers(expiresAt: number): void {
    this.stopArmedTimers()
    if (this.armedTickMs > 0) {
      this.armedTicker = setInterval(() => {
        // Repaint the countdown. The natural-expiry tick is delivered
        // via `armedExpireTimer` below, so this just refreshes the
        // visible "Xs" digit.
        this.repaintArmedFooter()
      }, this.armedTickMs)
      ;(this.armedTicker as { unref?: () => void }).unref?.()
    }
    const remainingMs = Math.max(0, expiresAt - this.nowFn())
    this.armedExpireTimer = setTimeout(() => {
      this.armedExpireTimer = null
      // Feed the FSM a `tick` at expiresAt. The FSM transitions
      // armed → idle and emits hide-armed (which `applyEffects` will
      // route back to `setFooterLines([])` and stop the painter).
      this.feedFsm({ kind: "tick", at: this.nowFn() })
    }, remainingMs)
    ;(this.armedExpireTimer as { unref?: () => void }).unref?.()
  }

  private stopArmedTimers(): void {
    if (this.armedTicker !== null) {
      clearInterval(this.armedTicker)
      this.armedTicker = null
    }
    if (this.armedExpireTimer !== null) {
      clearTimeout(this.armedExpireTimer)
      this.armedExpireTimer = null
    }
  }

  private repaintArmedFooter(): void {
    if (this.armedSource === null) return
    const line = formatArmedFooter({
      source: this.armedSource,
      expiresAt: this.armedExpiresAt,
      now: this.nowFn(),
    })
    // Paint into our OWN layer (priority 100). When the countdown
    // expires (`line === null`) the layer is cleared, revealing any
    // base content below. Composition is decided in `composeFooter`.
    if (line === null) {
      this.clearFooterLayer(FOOTER_LAYER_ARMED)
    } else {
      this.setFooterLayer(FOOTER_LAYER_ARMED, [line], { priority: FOOTER_PRIORITY_ARMED })
    }
  }

  /**
   * Signal that an agent turn has started. The REPL calls this right
   * before dispatching the user's prompt to the agent. The FSM
   * transitions idle/armed → working; effects (hide-armed if armed)
   * are applied.
   */
  notifyTurnStart(): void {
    this.feedFsm({ kind: "turn-start", at: this.nowFn() })
  }

  /**
   * Signal that an agent turn has ended (success / error / aborted).
   * The FSM transitions working → idle; if a Ctrl+C-driven abort had
   * already pushed us into `armed:post-abort`, we stay armed.
   */
  notifyTurnEnd(): void {
    this.feedFsm({ kind: "turn-end", at: this.nowFn() })
  }

  /**
   * Schedule a coalesced `"input"` emission. Safe to call on every
   * {@link repaint} - when the buffer text hasn't changed since the last
   * emission the timer callback skips the emit.
   *
   * Listeners receive `{text, seq}`. `seq` is monotonic so listeners can
   * discard stale snapshots cheaply.
   *
   * @internal
   */
  private scheduleInputEmit(): void {
    if (this.inputDebounce) clearTimeout(this.inputDebounce)
    if (this.inputDebounceMs <= 0) {
      // Synchronous mode - used by tests that don't want to drive timers.
      this.fireInputEvent()
      return
    }
    this.inputDebounce = setTimeout(() => {
      this.inputDebounce = null
      this.fireInputEvent()
    }, this.inputDebounceMs)
  }

  private fireInputEvent(): void {
    const text = this.buf.toString()
    if (text === this.lastEmittedInputText) return
    this.lastEmittedInputText = text
    this.inputSeq += 1
    // Emitter is synchronous BUT we never call it on the keystroke path -
    // the only callers are the debounce timer above and the synchronous
    // shortcut for tests. A slow listener here delays the NEXT debounce
    // window, never the next keystroke.
    this.emit("input", { text, seq: this.inputSeq })
  }

  /**
   * Broadcast `editor.buffer.changed` on the plugin bus when text changed
   * since the last emit. Plugin handlers run on the next microtask
   * (broadcast-async), so this is safe to call from the keystroke pump.
   *
   * Dedup is essential: every `repaint()` call lands here, including ones
   * triggered by cursor-only navigation, status-row updates, and
   * `setFooterLines` — but only ones where the buffer text actually
   * changed should wake the overlay's re-render path. Without dedup, a
   * spinner tick would cause N plugin invocations per second.
   *
   * @internal
   */
  private fireBufferChangedHook(): void {
    if (!this.hooks) return
    const text = this.buf.toString()
    if (text === this.lastEmittedBufferText) return
    this.lastEmittedBufferText = text
    try {
      this.hooks.emitAsync("editor.buffer.changed", {
        text,
        cursor: { row: this.buf.row, col: this.buf.col },
      })
    } catch (e) {
      // broadcast-async should never throw, but defend against bus
      // declaration mismatches and similar host-side failures so the
      // keystroke pump cannot be wedged by a misconfigured bus.
      process.stderr.write(
        `[editor-controller] editor.buffer.changed emit threw: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      )
    }
  }

  /** Current monotonic input sequence (mostly for tests). */
  inputSequence(): number {
    return this.inputSeq
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.stdin.setEncoding("utf8")
    this.stdin.resume()
    this.stdin.setRawMode(true)
    this.output.write(
      "\x1b[?2004h" +
        KITTY_KEYBOARD_ENABLE +
        XTERM_FORMAT_OTHER_KEYS_ENABLE +
        XTERM_MODIFY_OTHER_KEYS_ENABLE,
    )
    this.stdin.on("data", this.onDataBound)
    installCleanupHooksOnce()
    activeControllers.add(this)
    this.repaint()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.inputDebounce) {
      clearTimeout(this.inputDebounce)
      this.inputDebounce = null
    }
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer)
      this.resizeDebounceTimer = null
    }
    // Tear down the abort-quit FSM's recurring painter + expiry timer.
    this.stopArmedTimers()
    this.stdin.off("data", this.onDataBound)
    this.bracketedPaste = false
    this.output.write(
      XTERM_MODIFY_OTHER_KEYS_DISABLE +
        XTERM_FORMAT_OTHER_KEYS_DISABLE +
        KITTY_KEYBOARD_DISABLE +
        "\x1b[?2004l",
    )
    this.stdin.setRawMode(false)
    this.stdin.pause()
    activeControllers.delete(this)
  }

  /**
   * Last-ditch terminal restore for signal/exit handlers. Idempotent and
   * swallows errors; do not call from normal control flow - use {@link stop}.
   * @internal
   */
  emergencyRestore(): void {
    if (!activeControllers.has(this)) return
    activeControllers.delete(this)
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer)
      this.resizeDebounceTimer = null
    }
    try {
      this.output.write(
        XTERM_MODIFY_OTHER_KEYS_DISABLE +
          XTERM_FORMAT_OTHER_KEYS_DISABLE +
          KITTY_KEYBOARD_DISABLE +
          "\x1b[?2004l",
      )
    } catch {
      // ignore
    }
    try {
      if (this.stdin.isTTY) this.stdin.setRawMode(false)
    } catch {
      // ignore
    }
  }

  /** For diagnostics/tests. */
  buffer(): EditorBuffer {
    return this.buf
  }

  /**
   * Wire mode-cycling shortcuts.
   *
   * - `forward` is invoked on Shift+Tab (legacy `ESC[Z` and CSI-u tab+shift).
   * - `backward` is invoked on Ctrl+Shift+Tab (CSI-u tab with ctrl+shift).
   *
   * Pass `null` to detach. Mirrors {@link RawInput.setModeCycleHandlers} so
   * the live-area REPL can offer the same Shift+Tab UX as the legacy REPL.
   */
  setModeCycleHandlers(forward: (() => void) | null, backward: (() => void) | null): void {
    this.cycleForward = forward
    this.cycleBackward = backward
  }

  /**
   * Wire the Alt+M interrupt-and-apply-mode shortcut.
   *
   * Alt+M arrives as `ESC m` in raw terminal mode (no kitty protocol
   * needed). When wired:
   *
   *   - If the REPL/agent is mid-turn AND a mode toggle is pending
   *     delivery, the handler aborts the in-flight request and
   *     immediately starts a new user turn carrying only the
   *     `<ma::agent::mode-change>` attachment. The model gets the new mode
   *     without a user round-trip.
   *   - If nothing is pending, the handler is a no-op (the caller
   *     decides whether to flash the live area or just ignore).
   *
   * Pass `null` to detach. The raw `m` byte is consumed either way
   * when this handler is wired : no literal `m` is inserted into the
   * buffer.
   */
  setModeInterruptHandler(handler: (() => void) | null): void {
    this.modeInterrupt = handler
  }

  /**
   * Wire the submit-queue navigation hook (see {@link queueKeyHandler}).
   * The REPL passes a handler that owns the dequeue / remove /
   * dequeue-all overlay; the editor consults it before its default
   * handling of ArrowUp / ArrowDown / Enter / Escape / printable keys.
   *
   * Pass `null` to detach (queue nav off, default key handling restored).
   */
  setQueueKeyHandler(handler: QueueKeyHandler | null): void {
    this.queueKeyHandler = handler
  }

  /**
   * Offer a single canonical key to the {@link queueKeyHandler}. Returns
   * `true` when the host claimed it (caller skips its default handling).
   * When the host returns a replacement `buffer`, it is applied via
   * {@link setBuffer} (cursor parks at end). Safe to call on every
   * eligible keystroke: a no-op (returns false) when no handler is wired.
   */
  private tryQueueNav(key: string): boolean {
    if (!this.queueKeyHandler) return false
    const ctx: QueueKeyContext = { buffer: this.buf.toString(), atTop: this.cursorAtTop() }
    let r: QueueKeyResult
    try {
      r = this.queueKeyHandler(key, ctx)
    } catch (e) {
      process.stderr.write(
        `[editor-controller] queueKeyHandler threw on key "${key}": ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      )
      return false
    }
    if (!r.handled) return false
    if (r.buffer !== undefined) this.setBuffer(r.buffer)
    return true
  }

  /**
   * True when the cursor is on the FIRST visual row of the buffer
   * (logical row 0 AND wrap-chunk 0). Mirrors the `isAtTop` test the
   * history plugin runs on the `editor.key` payload, computed here so
   * {@link tryQueueNav} can pass it in {@link QueueKeyContext}.
   */
  private cursorAtTop(): boolean {
    if (this.buf.row !== 0) return false
    const cols = (this.output as { columns?: number }).columns
    if (!cols || cols <= 0) return true
    const line = this.buf.lines[0] ?? ""
    const promptW = this.renderer.promptDisplayWidthForRow(0)
    return computeCursorVisualPos(line, this.buf.col, promptW, cols).visualRow === 0
  }

  /**
   * Wire a fresh-prompt builder for {@link submit}'s commit-render
   * call. Closes the prompt-prefix race where a mode toggle
   * immediately before Enter could leave the cached
   * `this.renderer.prompt` one repaint behind. See
   * {@link commitPromptBuilder}.
   *
   * Pass `null` to detach (falls back to the cached prefix).
   */
  setCommitPromptBuilder(builder: (() => string) | null): void {
    this.commitPromptBuilder = builder
  }

  /**
   * Update the prompt prefix shown by the editor. Repaints immediately so
   * the new label appears on the next frame. Useful when the active mode
   * changes (e.g. switching to ASK colors the prompt) without forcing the
   * caller to tear down and recreate the controller.
   */
  setPrompt(prompt: string, continuationPrompt?: string): void {
    this.renderer.setPrompt(prompt, continuationPrompt)
    if (this.started) this.repaint()
  }

  /**
   * Enable or disable visible rendering of invisible characters
   * (spaces as `·`, tabs as `→`, line-ends as `↵`). Repaints
   * immediately.
   *
   * Called by the REPL on startup (env var / CLI flag), on mode change
   * (when a mode declares `editorShowHidden: true`), and can be called
   * directly by test harnesses.
   *
   * Runtime toggle keybinding: Ctrl+\ (sends `\x1c` in raw mode,
   * or `\x1b[92;5u` via the kitty keyboard protocol).
   */
  setShowHidden(v: boolean): void {
    this.showHiddenChars = v
    this.renderer.setShowHidden(v)
    if (this.started) this.repaint()
  }

  /**
   * Show or clear a single status line above the editor prompt. When set,
   * the live area grows by one row so the spinner/status doesn't fight the
   * prompt for screen real estate.
   */
  setStatus(text: string | null): void {
    const next = text == null ? null : text
    if (next != null && next.length > 0) this.statusRowReserved = true
    if (this.statusLine === next) return
    this.statusLine = next
    this.repaint()
  }

  /**
   * Handle a terminal resize (SIGWINCH).
   *
   * A window-edge DRAG fires one SIGWINCH per intermediate column, and each
   * synchronous repaint of a near-viewport-tall live area can leave a
   * reflow residue frozen in scrollback: when the terminal reflows our
   * pre-wrapped full-width lines at a narrower width, the live area's
   * physical height grows and its top rows scroll ABOVE the viewport into
   * permanent scrollback before we are even notified. The compositor's
   * relative erase (`ESC[nA` + `ESC[J`) cannot reach above the viewport
   * top, so those rows remain. Repainting on every step of a drag stacks
   * one such residue per column = dozens of duplicate live areas.
   *
   * Fix: coalesce. Arm a trailing timer and repaint ONCE, `resizeDebounceMs`
   * after the LAST resize, so a continuous drag collapses to a single
   * repaint at the final geometry (measured on a 120→48 drag: 25 leaked
   * copies at 0ms, 10 at 80ms, 0 at the 150ms default). The compositor
   * already emits nothing on each
   * intermediate SIGWINCH (its own HARD RULE), so the only cost of waiting
   * is that the live area visually settles a few ms after the drag stops.
   *
   * `resizeDebounceMs === 0` keeps the legacy synchronous behavior (one
   * repaint per resize), used by tests that assert that contract.
   */
  notifyResize(): void {
    if (!this.started) return
    if (this.resizeDebounceMs <= 0) {
      this.repaint()
      return
    }
    if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer)
    this.resizeDebounceTimer = setTimeout(() => {
      this.resizeDebounceTimer = null
      if (this.started) this.repaint()
    }, this.resizeDebounceMs)
  }

  private statusLine: string | null = null
  private statusRowReserved = false
  /**
   * Decoration rows rendered between the status row and the editor prompt.
   * Used by the REPL to surface the queued-message buffer above the input
   * (so the user sees that messages they pressed Enter on are pending
   * injection at the next safe boundary in the agent loop). Each entry is
   * one already-styled line; the editor never interprets them as content,
   * just slots them into the live area and bumps the cursor row offset.
   */
  private decorationLines: string[] = []

  /**
   * Active modal-overlay owner id, or `null` when the prompt is live.
   *
   * Set via {@link openOverlay} (host wiring for the `editor.overlay.open`
   * channel) and cleared via {@link closeOverlay}. While non-null the editor
   * is in MODAL-OWNED mode:
   *
   *  - the prompt row + cursor are NOT rendered (the overlay owns the screen
   *    via its footer paint), so the user never sees a phantom blinking
   *    prompt underneath the overlay;
   *  - {@link submit} is a no-op, so a stray Enter can't flush the typed
   *    `/cmd` line to scrollback;
   *  - every printable char + Backspace is dispatched through the
   *    `editor.key` hook (instead of mutating `buf`), so the overlay drives
   *    its own text input from an internal draft rather than the shared
   *    prompt buffer.
   *
   * This is the capability the host's ask-user modal already had (priority
   * key capture + prompt suppression), now exposed to plugin command TUIs
   * over the bus. See `src/plugins/hooks/channels.ts` `editor.overlay.*`.
   */
  private overlayOwner: string | null = null

  /** True while a modal overlay owns the input line. */
  isOverlayOwned(): boolean {
    return this.overlayOwner !== null
  }

  /**
   * Take modal ownership of the input line for `owner`. Hides the prompt,
   * blocks submit, and routes all keys to the overlay. No-op if the same
   * owner is already active; a different owner REPLACES the current one
   * (last-open-wins, matching the single-active-overlay invariant). Clears
   * the prompt buffer so a half-typed `/cmd` fragment doesn't resurface when
   * the overlay later closes.
   */
  openOverlay(owner: string): void {
    if (this.overlayOwner === owner) return
    this.overlayOwner = owner
    // Drop whatever the user typed to trigger the command (`/config`). The
    // overlay owns the screen now; the prompt is hidden, so leaving stale
    // bytes in `buf` would only resurface on close.
    this.buf.clear()
    this.viewportTop = 0
    if (this.started) this.repaint()
  }

  /**
   * Release modal ownership held by `owner`. Owner-checked + idempotent: a
   * close from a non-owner (or when nothing is owned) is ignored, so a stale
   * handler can't tear down a different overlay. Restores the prompt row +
   * cursor on the next repaint.
   */
  closeOverlay(owner: string): void {
    if (this.overlayOwner === null || this.overlayOwner !== owner) return
    this.overlayOwner = null
    this.buf.clear()
    this.viewportTop = 0
    if (this.started) this.repaint()
  }

  /**
   * Set decoration rows to be drawn between the status row and the prompt.
   * Pass `[]` to clear. Triggers a repaint when the array contents change
   * (shallow string compare); a no-op otherwise so the live area doesn't
   * flicker when the REPL polls the queue at unchanged steady state.
   *
   * Decoration rows count against the editor's live-height budget - they
   * shrink the editor's available rows by `lines.length`. Callers should
   * keep the queue display compact (one row per queued item, plus an
   * optional header) on small terminals.
   */
  /**
   * Replace the editor buffer with the given text and repaint. Used by the
   * abort flow (`runReplLiveArea` → `handleAbort`) to restore the prompt
   * the user just sent so they can edit and resubmit it. Cursor lands at
   * the end of the inserted text - same place users expect to be after a
   * paste, since the typical follow-up is "tweak and resubmit".
   *
   * Multi-line text is split on `\n` and inserted line-by-line with
   * `EditorBuffer.newline()` between segments, mirroring how bracketed
   * paste handling works elsewhere in this controller.
   */
  setBuffer(text: string): void {
    this.buf.clear()
    if (text.length > 0) {
      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 0) this.buf.insert(lines[i])
        if (i < lines.length - 1) this.buf.newline()
      }
    }
    if (this.started) this.repaint()
  }

  /**
   * Install a synchronous paste interceptor (see {@link pasteInterceptor}).
   * Pass `undefined` to remove it. The host wires media drop/clipboard capture
   * through this so a dropped image becomes a `[Image #id …]` token instead of
   * a literal path.
   */
  setPasteInterceptor(fn: ((pasted: string) => string | null) | undefined): void {
    this.pasteInterceptor = fn
  }

  /**
   * Install a Ctrl+V clipboard-paste handler (see {@link clipboardPaste}).
   * Pass `undefined` to remove it. The host wires this so Ctrl+V pulls the
   * system clipboard (text or image) even on terminals/OSes where the native
   * paste shortcut (Cmd+V) never reaches the process. Returned text is routed
   * through the same insert path as a bracketed paste.
   */
  setClipboardPasteHandler(fn: (() => string | null) | undefined): void {
    this.clipboardPaste = fn
  }

  setDecorationLines(lines: string[]): void {
    if (
      lines.length === this.decorationLines.length &&
      lines.every((l, i) => l === this.decorationLines[i])
    ) {
      return
    }
    this.decorationLines = [...lines]
    if (this.started) this.repaint()
  }

  /**
   * Footer rows rendered BELOW the editor input in the live area. Used
   * by plugin-contributed live-area slots that want to surface ambient
   * status (quota %, git state, background-job progress) without
   * competing with what the user is typing.
   *
   * Each entry is one already-styled line. Empty array clears. Footer
   * rows count against the editor's live-height budget - they shrink
   * the editor's available rows by `lines.length`. Callers should keep
   * the footer compact (one row is the common case).
   */
  // ----------------------------- footer layers -----------------------------
  //
  // Multiple unrelated producers paint into the footer band: the plugin
  // scheduler / diagnostic aggregator (the "quota row" and last-warning
  // summary), and the abort-quit FSM (the armed-quit overlay). Earlier
  // designs gave both producers a SINGLE mutable `footerLines: string[]`
  // field reachable through `setFooterLines(lines)`. Last writer won. When
  // the FSM dismissed the armed overlay it called `setFooterLines([])`
  // which BLEW AWAY the aggregator's content; the aggregator was not
  // notified to re-emit, so the quota row stayed gone until the next
  // periodic refresh (see Bug 2801).
  //
  // The fix is a small layer-stack model:
  //   - Each producer owns a stable {@link FooterLayerId} and mutates
  //     ONLY its own layer via {@link setFooterLayer} / {@link clearFooterLayer}.
  //   - Layers compose by priority: the highest-priority non-empty layer
  //     wins composition (overlay semantics — clearing an upper layer
  //     reveals the one below).
  //   - {@link setFooterLines} stays as the back-compat sugar mapping to
  //     the {@link FOOTER_LAYER_DEFAULT} layer at priority 0, so the
  //     plugin aggregator and any other legacy callers keep working
  //     without changes.
  //   - The armed-quit FSM uses {@link FOOTER_LAYER_ARMED} at priority
  //     {@link FOOTER_PRIORITY_ARMED}, leaving room for future
  //     intermediate overlays (slash-menu completion bar, mid-prompt
  //     command surface, etc.).
  //
  // Dedup is at the COMPOSED-output level so a mutation to an OBSCURED
  // layer does NOT trigger a repaint (no flicker, no work).

  private footerLayers: Map<FooterLayerId, FooterLayer> = new Map()
  /**
   * Last composed footer pushed to {@link repaint}. Used purely for
   * dedup in {@link setFooterLayer} / {@link clearFooterLayer}; the
   * canonical render-path source of truth is always {@link composeFooter}.
   */
  private composedFooterCache: string[] = []

  /**
   * Set / replace a footer LAYER. Multiple producers can paint into the
   * footer band side-by-side; each owns a stable layer id and the
   * highest-priority non-empty layer wins composition.
   *
   * Passing `lines: []` is equivalent to {@link clearFooterLayer}: the
   * layer becomes invisible and the next-highest non-empty layer below
   * re-emerges.
   *
   * `opts.priority` is captured on first set and reused on subsequent
   * calls that omit it; pass it explicitly when the producer "owns" a
   * known z-index (e.g. the armed-quit FSM pins
   * {@link FOOTER_PRIORITY_ARMED}).
   *
   * Triggers a repaint iff the COMPOSED footer changed; a no-op
   * otherwise. Mutating an obscured layer is silent.
   */
  setFooterLayer(layerId: FooterLayerId, lines: string[], opts?: SetFooterLayerOptions): void {
    const prev = this.footerLayers.get(layerId)
    const priority = opts?.priority ?? prev?.priority ?? 0
    if (lines.length === 0) {
      if (prev === undefined) return
      this.footerLayers.delete(layerId)
    } else {
      const unchanged =
        prev !== undefined &&
        prev.priority === priority &&
        prev.lines.length === lines.length &&
        prev.lines.every((l, i) => l === lines[i])
      if (unchanged) return
      this.footerLayers.set(layerId, { id: layerId, priority, lines: [...lines] })
    }
    this.applyFooterChange()
  }

  /**
   * Remove a footer LAYER entirely. Equivalent to
   * `setFooterLayer(id, [])`. Unknown ids are a silent no-op (no
   * repaint).
   */
  clearFooterLayer(layerId: FooterLayerId): void {
    if (!this.footerLayers.has(layerId)) return
    this.footerLayers.delete(layerId)
    this.applyFooterChange()
  }

  /**
   * Set footer rows (back-compat shim).
   *
   * Routes to {@link setFooterLayer} on the {@link FOOTER_LAYER_DEFAULT}
   * layer at priority 0. Existing callers (the plugin scheduler /
   * diagnostic aggregator) keep working unchanged; their content shows
   * up at the bottom of the layer stack and is obscured (but not
   * destroyed) by any higher-priority overlay (e.g. the armed-quit
   * footer).
   *
   * Pass `[]` to clear the default layer. The default layer is fully
   * independent of any other layer the host may have pushed.
   */
  setFooterLines(lines: string[]): void {
    this.setFooterLayer(FOOTER_LAYER_DEFAULT, lines, { priority: 0 })
  }

  /**
   * Pure: compose the visible footer by picking the highest-priority
   * non-empty layer. Multi-line layers are returned in full (so a
   * future layer that wants 2 rows still composes correctly). Returns
   * a fresh array; the caller may freely mutate it.
   *
   * @internal Exposed for unit-test stability assertions.
   */
  composeFooter(): string[] {
    let best: FooterLayer | null = null
    for (const layer of this.footerLayers.values()) {
      if (layer.lines.length === 0) continue
      if (best === null || layer.priority > best.priority) best = layer
    }
    return best ? [...best.lines] : []
  }

  /**
   * Shared tail of {@link setFooterLayer} / {@link clearFooterLayer}:
   * compute the new composed footer, shallow-compare against the last
   * one we pushed, and call {@link repaint} only when the visible
   * footer actually changed.
   */
  private applyFooterChange(): void {
    const composed = this.composeFooter()
    const prev = this.composedFooterCache
    const unchanged = composed.length === prev.length && composed.every((l, i) => l === prev[i])
    if (unchanged) return
    this.composedFooterCache = composed
    if (this.started) this.repaint()
  }

  // ----------------------------- internals -----------------------------

  /**
   * Wrap-aware "cursor up by one PHYSICAL row". When the cursor sits on
   * the second-or-later wrap chunk of a long logical line, this moves it
   * up to the previous wrap chunk of the SAME logical line. Only when
   * the cursor is on the first wrap chunk does it cross into the prior
   * logical line (landing on that line's LAST wrap chunk, at the same
   * visual column).
   *
   * Sticky column ({@link desiredVisualCol}): when up/down navigation runs
   * consecutively, the cursor's visual column at the start of the run is
   * captured and reused. Standard vim/VSCode "keep column when walking
   * through short rows" behavior - without it, the cursor drifts to the
   * left edge through varied-width rows. The endpoint-match probe in
   * {@link isVerticalStickyAlive} invalidates the column automatically
   * whenever a non-vertical action moves the cursor between presses.
   *
   * Falls back to {@link EditorBuffer.moveUp} when the terminal width is
   * unknown (no wrap layout possible, e.g. non-TTY tests).
   *
   * Returns `true` when the cursor actually moved.
   */
  private moveUpVisual(): boolean {
    if (!this.isVerticalStickyAlive()) this.desiredVisualCol = null
    const cols = (this.output as { columns?: number }).columns
    if (!cols || cols <= 0) {
      const moved = this.buf.moveUp()
      this.recordVerticalEndpoint(moved)
      return moved
    }
    const line = this.buf.lines[this.buf.row]
    const promptW = this.renderer.promptDisplayWidthForRow(this.buf.row)
    const cur = computeCursorVisualPos(line, this.buf.col, promptW, cols)
    if (this.desiredVisualCol === null) this.desiredVisualCol = cur.visualCol
    const target = this.desiredVisualCol
    if (cur.visualRow > 0) {
      // Same logical line, one wrap chunk up.
      const newCol = findColAtVisualPos(line, cur.visualRow - 1, target, promptW, cols)
      if (newCol === this.buf.col) {
        this.recordVerticalEndpoint(false)
        return false
      }
      this.buf.col = newCol
      this.recordVerticalEndpoint(true)
      return true
    }
    // First wrap chunk of this line → cross into previous logical line.
    if (this.buf.row === 0) {
      this.recordVerticalEndpoint(false)
      return false
    }
    const prevRow = this.buf.row - 1
    const prevLine = this.buf.lines[prevRow]
    const prevPromptW = this.renderer.promptDisplayWidthForRow(prevRow)
    const prevWidth = prevPromptW + displayWidth(prevLine)
    const prevRowCount = prevWidth <= 0 ? 1 : Math.max(1, Math.ceil(prevWidth / cols))
    const targetVisualRow = prevRowCount - 1
    const newCol = findColAtVisualPos(prevLine, targetVisualRow, target, prevPromptW, cols)
    this.buf.row = prevRow
    // EditorBuffer's `row` setter clamps `col`; we then set col explicitly
    // (the setter clamps to the line length, which is what we want when
    // the target visual col is past the end of the previous line).
    this.buf.col = newCol
    this.recordVerticalEndpoint(true)
    return true
  }

  /**
   * Wrap-aware "cursor down by one PHYSICAL row" - mirror of
   * {@link moveUpVisual}. When more wrap chunks remain inside the current
   * logical line, walks down one chunk; otherwise crosses into the next
   * logical line and lands on its FIRST chunk, at the sticky visual col.
   */
  private moveDownVisual(): boolean {
    if (!this.isVerticalStickyAlive()) this.desiredVisualCol = null
    const cols = (this.output as { columns?: number }).columns
    if (!cols || cols <= 0) {
      const moved = this.buf.moveDown()
      this.recordVerticalEndpoint(moved)
      return moved
    }
    const line = this.buf.lines[this.buf.row]
    const promptW = this.renderer.promptDisplayWidthForRow(this.buf.row)
    const cur = computeCursorVisualPos(line, this.buf.col, promptW, cols)
    if (this.desiredVisualCol === null) this.desiredVisualCol = cur.visualCol
    const target = this.desiredVisualCol
    if (cur.visualRow < cur.rowsInLine - 1) {
      // Same logical line, one wrap chunk down.
      const newCol = findColAtVisualPos(line, cur.visualRow + 1, target, promptW, cols)
      if (newCol === this.buf.col) {
        this.recordVerticalEndpoint(false)
        return false
      }
      this.buf.col = newCol
      this.recordVerticalEndpoint(true)
      return true
    }
    // Last wrap chunk of this line → cross into next logical line.
    if (this.buf.row >= this.buf.lines.length - 1) {
      this.recordVerticalEndpoint(false)
      return false
    }
    const nextRow = this.buf.row + 1
    const nextLine = this.buf.lines[nextRow]
    const nextPromptW = this.renderer.promptDisplayWidthForRow(nextRow)
    const newCol = findColAtVisualPos(nextLine, 0, target, nextPromptW, cols)
    this.buf.row = nextRow
    this.buf.col = newCol
    this.recordVerticalEndpoint(true)
    return true
  }

  /**
   * `true` when the cursor still sits where the last vertical move
   * parked it - i.e. no non-vertical action (left/right, edit, paste,
   * etc.) has run since. Drives the implicit reset of
   * {@link desiredVisualCol} so no other keystroke handler needs to
   * touch it.
   */
  private isVerticalStickyAlive(): boolean {
    return this.lastVerticalEndRow === this.buf.row && this.lastVerticalEndCol === this.buf.col
  }

  /**
   * Stamp the current cursor position as "where the last vertical move
   * ended". A subsequent {@link moveUpVisual}/{@link moveDownVisual}
   * checks the cursor against this stamp; if anything moved it in
   * between, the sticky column is dropped.
   *
   * When `moved` is `false` (vertical move was a no-op at top/bottom),
   * we still stamp current pos so a follow-up up-arrow on the same row
   * doesn't think the cursor "drifted" and reset the sticky col.
   */
  private recordVerticalEndpoint(_moved: boolean): void {
    this.lastVerticalEndRow = this.buf.row
    this.lastVerticalEndCol = this.buf.col
  }

  private onData(chunk: string | Buffer): void {
    // Any new input invalidates a pending bare-Esc - either it's the
    // continuation bytes of a CSI we were holding, or it's a separate
    // key entirely. In both cases the disambiguation timer must NOT
    // fire, so cancel it before appending and re-running the consumer.
    this.cancelBareEscapeTimer()
    this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    this.consumePending()
  }

  private cancelBareEscapeTimer(): void {
    if (this.bareEscapeTimer !== null) {
      clearTimeout(this.bareEscapeTimer)
      this.bareEscapeTimer = null
    }
  }

  /**
   * Called when the bare-Esc disambiguation timer fires without follow-up
   * bytes arriving. At this point `pending` may still contain the lone
   * `\x1b` (no other handler had a chance to consume it), so we drop it
   * here and route to the abort bus when a turn is in flight. When no
   * turn is in flight, bare Esc is a no-op (the user gets neither a
   * spurious `cancel` nor anything inserted into the buffer).
   */
  private fireBareEscape(): void {
    this.bareEscapeTimer = null
    if (this.pending === "\x1b") {
      this.pending = ""
    }
    // Two-layer dispatch for ESC. Top to bottom:
    //
    //   1. InputCaptureStack (LIFO, transient): reflection cooldown,
    //      confirm modals, anything that wants strict "most recently
    //      opened, first to close" precedence.
    //   2. editor.key hook chain (priority, durable): plugins like
    //      slash-menu / autocomplete.
    //   3. abort-quit FSM (fallback): the only place that aborts the
    //      turn.
    //
    // If anyone in (1) or (2) claims, the FSM never sees this ESC.
    // The user's NEXT ESC pops the next layer (or aborts if the stack
    // and chain are both empty). N overlays → N ESCs to peel them
    // off, then one more to abort. Predictable LIFO.
    //
    // "Always a way out" is preserved by the rapid double-Ctrl+C
    // escape hatch (`EscapeHatch`, spec rule 5) — it bypasses both
    // (1), (2), AND the FSM, so a wedged capture can never trap the
    // user. See #abort-quit-ux-spec and the InputCaptureStack
    // module docstring.
    if (this.inputCaptureStack.dispatch("Escape")) {
      return
    }
    if (this.dispatchKeyHook("Escape")) {
      return
    }
    // Submit-queue nav: Esc closes the dequeue overlay (queue left
    // intact) and must NOT abort the turn. Only claims when the overlay
    // is open; otherwise falls through to the abort-quit FSM below so a
    // plain Esc still aborts an in-flight turn (which itself dequeues
    // everything back to the prompt — see runReplLiveArea's abort path).
    if (this.tryQueueNav("Escape")) {
      return
    }
    // Esc breaks the escape-hatch run too - otherwise (Ctrl+C, Esc,
    // Ctrl+C) would force-quit even though the user said "cancel that".
    this.escapeHatch.reset()
    // Feed the FSM. In `working` state this emits `abort-turn` (no arm).
    // In `armed` state this emits `hide-armed` (Esc cancels the modal).
    // In `idle` state this is a no-op.
    this.feedFsm({ kind: "esc", at: this.nowFn() })
  }

  private consumePending(): void {
    let dirty = false
    while (this.pending.length > 0) {
      if (this.bracketedPaste) {
        // A bracketed paste while the quit-confirm modal is open means
        // the user is back to editing - dismiss.
        if (this.fsmState.kind === "armed") {
          this.feedFsm({ kind: "printable", at: this.nowFn() })
        }
        const r = this.consumeBracketedPaste()
        if (r === "wait") return
        if (r) dirty = true
        continue
      }

      // FSM dismiss on engagement: while armed, ANY input other than
      // Ctrl+C (which would quit) or a bare Esc byte (which will route
      // through the bareEscape path → FSM esc → also hides) means the
      // user is back to typing/navigating. Dismiss the modal immediately
      // so the next keystroke feels live. Safe to call when not armed
      // (FSM transition is a no-op).
      const lead = this.pending[0]
      const isCtrlC_bare = lead === "\x03"
      const isBareEsc = lead === "\x1b" && this.pending.length === 1
      // Lookahead for CSI-encoded Ctrl+C (kitty CSI-u `\x1b[99;5u` or xterm
      // modifyOtherKeys `\x1b[27;5;99~`). Without this, the escape-hatch
      // reset below would zero the timestamp BEFORE parseModifiedKeySequence
      // gets a chance to observe - breaking rapid-double-Ctrl+C across
      // mixed encodings (e.g. \x03 then \x1b[99;5u within 500ms).
      const isCtrlC_csi = this.pendingHeadIsCsiCtrlC()
      const isCtrlC = isCtrlC_bare || isCtrlC_csi
      // Same lookahead for CSI-encoded ESC (kitty `\x1b[27u` or xterm
      // `\x1b[27;1;27~`). Treated as bare Esc for the armed-dismiss
      // gate below: Esc dismisses via the FSM esc transition, not via
      // the "printable" path.
      const isCsiEsc = this.pendingHeadIsCsiEsc()
      if (this.fsmState.kind === "armed" && !isCtrlC && !isBareEsc && !isCsiEsc) {
        this.feedFsm({ kind: "printable", at: this.nowFn() })
      }

      // Reset the escape-hatch run on any non-Ctrl+C keystroke. Two
      // Ctrl+Cs with non-Ctrl+C input between them are NOT a "rapid
      // double" anymore, even if they land within 500ms. The CSI
      // lookahead above ensures kitty/xterm-encoded Ctrl+C preserves
      // the timestamp.
      if (!isCtrlC) this.escapeHatch.reset()

      if (this.pending.startsWith("\x1b")) {
        // Lone Esc byte: arm the disambiguation timer and stop processing.
        // If more bytes show up before the timer fires, `onData` cancels
        // it and re-enters this loop with the full sequence available.
        if (this.pending.length === 1) {
          if (this.bareEscapeTimer === null) {
            this.bareEscapeTimer = setTimeout(() => {
              this.fireBareEscape()
            }, this.bareEscapeMs)
            // Keep the timer from holding the event loop alive after
            // process exit on Bun/Node.
            ;(this.bareEscapeTimer as { unref?: () => void }).unref?.()
          }
          if (dirty) this.repaint()
          return
        }
        const handled = this.consumeEscape()
        if (handled === "wait") return
        if (handled === "submit") {
          this.submit()
          return // submit() repaints; stop processing here
        }
        // CSI-encoded Ctrl+C / ESC route through the FSM inside
        // parseModifiedKeySequence (May 2026 - fixes Bug A + Bug B per
        // `src/abort-quit-keystroke.test.ts`). If those transitions land
        // us in `quitting`, bail out before processing more pending bytes
        // - mirrors the bare-\x03 handler at the bottom of this loop.
        if (this.fsmState.kind === "quitting") return
        if (handled === "changed") dirty = true
        continue
      }

      const codePoint = this.pending.codePointAt(0)
      if (codePoint === undefined) return
      const char = String.fromCodePoint(codePoint)
      this.pending = this.pending.slice(char.length)

      // Modal-owned routing: while a command overlay owns the input line,
      // printable characters and Backspace must NOT mutate the (hidden)
      // prompt buffer. Dispatch them through the `editor.key` hook so the
      // overlay drives its own internal draft. Printables arrive as their
      // single-char `key`; Backspace as `"Backspace"`. Enter / Escape / Tab
      // / arrows are intentionally left to fall through to their existing
      // handlers below, which already route through `dispatchKeyHook`.
      if (this.overlayOwner !== null) {
        if (char === "\x7f" || char === "\x08") {
          this.dispatchKeyHook("Backspace")
          continue
        }
        if (this.isPrintable(char)) {
          // Greedy run so a paste burst is one dispatch per char (cheap; the
          // overlay's draft append is O(1)). Each char is its own key event.
          this.dispatchKeyHook(char)
          while (this.pending.length > 0 && !this.pending.startsWith("\x1b")) {
            const cp = this.pending.codePointAt(0)
            if (cp === undefined) break
            const ch = String.fromCodePoint(cp)
            if (!this.isPrintable(ch)) break
            this.pending = this.pending.slice(ch.length)
            this.dispatchKeyHook(ch)
          }
          continue
        }
        // Other control bytes (Ctrl+A/E/K/U/W, etc.) are swallowed while a
        // modal overlay is up so they can't edit the hidden prompt buffer.
        if (char !== "\r" && char !== "\n" && char !== "\x03" && !char.startsWith("\x1b")) {
          continue
        }
      }

      if (char === "\r" || char === "\n") {
        // Submit-queue nav: Enter confirms the highlighted selection
        // (dequeue → input) when the overlay is open. Claims before any
        // CRLF coalescing / submit so a bare Enter inside the overlay
        // never falls through to `submit()`.
        if (this.tryQueueNav("Enter")) {
          // Eat a coalesced CR/LF partner if present so it doesn't
          // re-enter the loop as a second keystroke.
          const other = char === "\r" ? "\n" : "\r"
          if (this.pending.startsWith(other)) this.pending = this.pending.slice(other.length)
          dirty = true
          continue
        }
        // Coalesce CRLF / LFCR. Track whether we ate the partner byte -
        // a coalesced CRLF is unambiguously "plain Enter" regardless of
        // which half arrived first; a *bare* LF (no CR partner) is what
        // terminals send for Ctrl+J and for Shift+Enter when the user
        // has configured the terminal to send LF for Shift+Return
        // (e.g. iTerm2 → Profiles → Keys → Key Mappings: Shift+Return →
        // Send Hex Codes 0x0a). Treat bare LF as "newline insertion"
        // so Shift+Enter works alongside Alt/Option+Enter.
        const other = char === "\r" ? "\n" : "\r"
        const coalesced = this.pending.startsWith(other)
        if (coalesced) {
          this.pending = this.pending.slice(other.length)
        }
        // Bare LF without a CR partner → Shift+Enter / Ctrl+J → newline.
        // Check this BEFORE the isBlank() no-op so that Shift+Enter on
        // an empty buffer inserts a newline (matching Alt/Option+Enter,
        // which goes through the escape parser and bypasses isBlank()).
        // Without this ordering the two newline-insert keys disagree on
        // empty buffers: Alt+Enter expands to two blank lines, but bare
        // LF would be eaten by the no-op below.
        if (char === "\n" && !coalesced) {
          this.buf.newline()
          dirty = true
          continue
        }
        if (this.buf.isBlank()) {
          // Even on a blank buffer, an overlay (ask-user modal / slash-menu)
          // gets first crack at Enter — otherwise a confirm-modal can't be
          // confirmed on an empty prompt (the keystroke would be eaten by the
          // blank no-op below before reaching the hook chain at submit-time).
          if (this.dispatchKeyHook("Enter")) {
            continue
          }
          this.buf.clear()
          dirty = true
          continue
        }
        // Pasted multiline arriving without bracketed-paste markers shows
        // up here as `\r` followed by more printable bytes; treat as a
        // newline insertion. A trailing escape sequence (e.g. arrow key
        // coalesced into the same chunk) means the Enter is real.
        if (this.pending.length > 0 && !this.pending.startsWith("\x1b")) {
          this.buf.newline()
          dirty = true
          continue
        }
        // Plugins (slash-menu, etc.) can intercept Enter on a non-empty
        // buffer to swallow the submit (e.g. "execute the selected menu
        // item instead"). When halted, the listener typically also
        // sets `result.buffer = ""` to clear the prompt afterwards.
        if (this.dispatchKeyHook("Enter")) {
          continue
        }
        this.submit()
        return
      }
      if (char === "\x03") {
        // Ctrl+C is owned by the abort-quit FSM (May 2026 - see
        // `src/abort-quit-fsm.ts` and project memory #abort-quit-ux-spec).
        //
        // BEFORE we feed the FSM, observe the escape-hatch: two Ctrl+Cs
        // within 500ms force-quit regardless of FSM state. This is the
        // hard guarantee the user demanded - if the FSM somehow wedges,
        // the second rapid Ctrl+C still leaves.
        const now = this.nowFn()
        if (this.escapeHatch.observe(now) === "force-quit") {
          this.stopArmedTimers()
          this.clearFooterLayer(FOOTER_LAYER_ARMED)
          this.fsmState = { kind: "quitting", reason: "escape-hatch" }
          this.emit("quit", "escape-hatch" as QuitReason)
          this.emit("cancel", "escape-hatch" as QuitReason)
          return
        }
        // Normal path: feed the FSM, let `applyEffects` do the IO.
        this.feedFsm({ kind: "ctrl-c", at: now })
        if (this.fsmState.kind === "quitting") return
        continue
      }
      if (char === "\x04") {
        if (this.buf.deleteForward()) dirty = true
        continue
      }
      if (char === "\x7f") {
        if (this.buf.deleteBackward()) dirty = true
        continue
      }
      if (char === "\x01") {
        if (this.buf.moveLineStart()) dirty = true
        continue
      }
      if (char === "\x05") {
        if (this.buf.moveLineEnd()) dirty = true
        continue
      }
      if (char === "\x0b") {
        if (this.buf.killToLineEnd()) dirty = true
        continue
      }
      if (char === "\x15") {
        if (this.buf.killToLineStart()) dirty = true
        continue
      }
      if (char === "\x17") {
        if (this.buf.deleteWordBackward()) dirty = true
        continue
      }
      if (char === "\x12") {
        // Ctrl+R — reverse history search (history plugin). When no
        // listener consumes it, swallow silently rather than inserting
        // a control byte; readline-style "Ctrl+R but no history" is
        // a no-op everywhere we've ever seen.
        if (this.dispatchKeyHook("Ctrl+R")) dirty = true
        continue
      }
      if (char === "\x16") {
        // Ctrl+V — explicit clipboard paste. Cmd+V is intercepted by the
        // terminal/OS and may never reach us (and when it does it arrives as
        // a bracketed paste, handled elsewhere); Ctrl+V is the in-process
        // shortcut. The host wires `clipboardPaste` to pull text or a
        // clipboard image. The result is routed through `insertPasted`, so a
        // pasted image path still becomes an `[Image #id …]` token via the
        // media interceptor. When no handler is wired, swallow silently
        // rather than inserting a raw `\x16` control byte.
        if (this.clipboardPaste) {
          let replacement: string | null = null
          try {
            replacement = this.clipboardPaste()
          } catch {
            replacement = null
          }
          if (replacement != null && replacement.length > 0) {
            if (this.insertPasted(replacement)) dirty = true
          }
        }
        continue
      }
      if (char === "\x1c") {
        // Ctrl+\ - toggle show-hidden debug rendering
        this.setShowHidden(!this.showHiddenChars)
        dirty = true
        continue
      }
      if (char === "\t") {
        // Plugins (notably the slash-menu overlay) can intercept Tab.
        // When halted, the listener has either consumed the key (e.g.
        // tab-complete inside an overlay) or replaced the buffer; the
        // default literal-tab insertion is suppressed.
        if (this.dispatchKeyHook("Tab")) {
          dirty = true
          continue
        }
        this.buf.insert(char)
        dirty = true
        continue
      }
      if (this.isPrintable(char)) {
        // Submit-queue nav: while the overlay is open, single printables
        // are commands (`d` dequeue, `x` remove, `k` dequeue all) and
        // every other printable is swallowed to keep the overlay modal.
        // When the overlay is closed the handler returns false instantly
        // and we fall through to the normal greedy-insert path. Checked
        // per printable RUN (not per char), so normal typing pays at
        // most one cheap handler call per burst.
        if (this.tryQueueNav(char)) {
          dirty = true
          continue
        }
        // Greedy run of printables.
        let run = char
        while (this.pending.length > 0 && !this.pending.startsWith("\x1b")) {
          const cp = this.pending.codePointAt(0)
          if (cp === undefined) break
          const ch = String.fromCodePoint(cp)
          if (!this.isPrintable(ch)) break
          run += ch
          this.pending = this.pending.slice(ch.length)
        }
        this.buf.insert(run)
        dirty = true
        continue
      }
    }
    if (dirty) this.repaint()
  }

  /**
   * Lookahead: is `this.pending` currently headed by a complete CSI sequence
   * that parses to Ctrl+C (kitty CSI-u `\x1b[99;5u` or xterm modifyOtherKeys
   * `\x1b[27;5;99~`)?
   *
   * Used by `consumePending` to decide whether to reset the escape-hatch
   * BEFORE the CSI sequence is parsed. Without this, mixed-encoding
   * rapid-double-Ctrl+C (\x03 → \x1b[99;5u within 500ms) would lose its
   * timestamp and the escape-hatch backstop would silently fail. See
   * `src/abort-quit-keystroke.test.ts` "armed state transitions" for the
   * cross-encoding regression guard.
   *
   * Returns false on incomplete sequences (the next read will retry).
   */
  private pendingHeadIsCsiCtrlC(): boolean {
    if (!this.pending.startsWith("\x1b[")) return false
    const end = this.findCsiEnd(this.pending)
    if (end === null) return false
    const seq = this.pending.slice(0, end + 1)
    const key = this.parseCsiUKey(seq) ?? this.parseXtermOtherKey(seq)
    if (!key) return false
    // Code 99 = 'c'; modifier bit 2 = ctrl per kitty/xterm.
    return key.code === 99 && this.hasModifier(key.modifiers, 2)
  }

  /**
   * Lookahead: is `this.pending` currently headed by a complete CSI sequence
   * that parses to plain ESC (kitty `\x1b[27u` or xterm `\x1b[27;1;27~`)?
   *
   * Used by `consumePending`'s armed-dismiss gate to treat CSI-encoded ESC
   * the same as a bare `\x1b` byte (route via FSM `esc`, not via FSM
   * `printable`). Without this, kitty ESC while armed would dismiss as a
   * printable key - semantically incorrect even though end-state happens
   * to match.
   */
  private pendingHeadIsCsiEsc(): boolean {
    if (!this.pending.startsWith("\x1b[")) return false
    const end = this.findCsiEnd(this.pending)
    if (end === null) return false
    const seq = this.pending.slice(0, end + 1)
    const key = this.parseCsiUKey(seq) ?? this.parseXtermOtherKey(seq)
    if (!key) return false
    return key.code === 27 && key.modifiers <= 1
  }

  private consumeEscape(): "wait" | "ignore" | "changed" | "submit" {
    const input = this.pending
    if (input.length === 1) return "wait"

    if (input[1] === "[") {
      const end = this.findCsiEnd(input)
      if (end === null) return "wait"
      const seq = input.slice(0, end + 1)
      this.pending = input.slice(end + 1)
      if (seq === BRACKETED_PASTE_START) {
        this.bracketedPaste = true
        return "ignore"
      }
      // Legacy shift+tab (back-tab). Most terminals emit ESC[Z for it.
      // Cycle modes when a handler is wired; otherwise drop it (don't
      // insert a literal tab - the user's intent was clearly Shift+Tab).
      if (seq === "\x1b[Z") {
        if (this.cycleForward) this.cycleForward()
        return "ignore"
      }
      const modKey = this.parseModifiedKeySequence(seq)
      if (modKey) return modKey
      switch (seq) {
        case "\x1b[3~":
          return this.buf.deleteForward() ? "changed" : "ignore"
        case "\x1b[D":
          // Overlays (ask-user modal) capture ←/→ for option navigation; only
          // move the buffer cursor when no listener claims the key.
          if (this.dispatchKeyHook("ArrowLeft")) return "changed"
          return this.buf.moveLeft() ? "changed" : "ignore"
        case "\x1b[C":
          if (this.dispatchKeyHook("ArrowRight")) return "changed"
          return this.buf.moveRight() ? "changed" : "ignore"
        case "\x1b[A":
          // Submit-queue nav gets first crack at ↑ (open the dequeue
          // overlay / single-item dequeue / move selection up). It only
          // claims when a turn has a queue and the cursor is at the top
          // of an empty prompt; otherwise it passes through.
          if (this.tryQueueNav("ArrowUp")) return "changed"
          // Plugins (notably `history`) can intercept ↑. The hook may
          // halt + replace the buffer; otherwise we fall through to the
          // wrap-aware in-buffer cursor-up.
          if (this.dispatchKeyHook("ArrowUp")) return "changed"
          return this.moveUpVisual() ? "changed" : "ignore"
        case "\x1b[B":
          if (this.tryQueueNav("ArrowDown")) return "changed"
          if (this.dispatchKeyHook("ArrowDown")) return "changed"
          return this.moveDownVisual() ? "changed" : "ignore"
        case "\x1b[1;3D":
          return this.buf.moveWordLeft() ? "changed" : "ignore"
        case "\x1b[1;3C":
          return this.buf.moveWordRight() ? "changed" : "ignore"
        case "\x1b[H":
        case "\x1b[1~":
          return this.buf.moveLineStart() ? "changed" : "ignore"
        case "\x1b[F":
        case "\x1b[4~":
          return this.buf.moveLineEnd() ? "changed" : "ignore"
        default:
          return "ignore"
      }
    }

    if (input[1] === "O") {
      if (input.length < 3) return "wait"
      const seq = input.slice(0, 3)
      this.pending = input.slice(3)
      switch (seq) {
        case "\x1bOH":
          return this.buf.moveLineStart() ? "changed" : "ignore"
        case "\x1bOF":
          return this.buf.moveLineEnd() ? "changed" : "ignore"
        default:
          return "ignore"
      }
    }

    const seq = input.slice(0, 2)
    this.pending = input.slice(2)
    switch (seq) {
      case "\x1b\r":
      case "\x1b\n":
        this.buf.newline()
        return "changed"
      case "\x1bb":
        return this.buf.moveWordLeft() ? "changed" : "ignore"
      case "\x1bf":
        return this.buf.moveWordRight() ? "changed" : "ignore"
      // Alt+M / Option+M : interrupt-and-apply-mode. Cross-terminal
      // portable (CTRL+M is byte-identical to Enter, so we use the
      // meta-prefix path instead). The handler is opt-in via
      // `setModeInterruptHandler`; when unset we drop the bytes
      // silently so a stray Alt+M doesn't insert a literal `m`.
      case "\x1bm":
        if (this.modeInterrupt) this.modeInterrupt()
        return "ignore"
      default:
        return "ignore"
    }
  }

  private parseModifiedKeySequence(seq: string): "ignore" | "changed" | "submit" | null {
    const key = this.parseCsiUKey(seq) ?? this.parseXtermOtherKey(seq)
    if (!key) return null
    if (key.eventType !== 1) return "ignore"

    const { code, modifiers, text } = key
    const shift = this.hasModifier(modifiers, 0)
    const alt = this.hasModifier(modifiers, 1)
    const ctrl = this.hasModifier(modifiers, 2)

    // ── Submit-queue nav (CSI-u / xterm encodings) ──────────────────────
    // iTerm kitty proto (the agent's default) ships Esc / Enter / plain
    // letters as CSI-u sequences, so mirror the bare-byte queue-nav
    // hooks here. Only unmodified keys are eligible (Ctrl+C / Alt+… are
    // never queue-nav commands). When the overlay is closed every call
    // returns false and falls through to the normal handling below.
    if (!alt && !ctrl) {
      let navKey: string | null = null
      if (code === 27) navKey = "Escape"
      else if (code === 10 || code === 13) navKey = "Enter"
      // Associated text (kitty flag 16) is the typed character(s) for
      // this key event; for the nav commands (d/x/k) it's a single char.
      // The handler only matches exact command keys, so passing the raw
      // text is safe even in the (rare) multi-codepoint case.
      else if (text !== null) navKey = text
      else if (this.isPrintableCodePoint(code)) navKey = String.fromCodePoint(code)
      if (navKey !== null && this.tryQueueNav(navKey)) {
        // Esc consumed → "ignore" (no buffer churn); everything else may
        // have replaced the buffer, so report "changed" for a repaint.
        return navKey === "Escape" ? "ignore" : "changed"
      }
    }

    // ── Abort-quit FSM routing (May 2026, fixes Bug A + Bug B) ───────────
    // iTerm 3.5+ with kitty proto, and xterm with modifyOtherKeys=2, send
    // ESC and Ctrl+C through CSI sequences instead of bare bytes. They MUST
    // route through the abort-quit FSM identically to the bare paths,
    // otherwise:
    //   - Kitty Ctrl+C (\x1b[99;5u) silently quits the agent without a
    //     goodbye banner because the legacy `case 99` branch returned
    //     "cancel" → bare `emit("cancel")` in consumePending → REPL's
    //     `on("cancel")` set `cancelled = true` and exited.
    //   - Kitty ESC (\x1b[27u) silently no-ops because code=27 is not
    //     printable and fell through to "ignore".
    // Regression guards live in `src/abort-quit-keystroke.test.ts`.
    //
    // Ctrl+C - observe the escape-hatch BEFORE feeding the FSM so two
    // rapid Ctrl+Cs across encodings (\x03 then \x1b[99;5u within 500ms)
    // still force-quit per spec rule 5.
    if (code === 99 && ctrl && !alt) {
      const now = this.nowFn()
      if (this.escapeHatch.observe(now) === "force-quit") {
        this.stopArmedTimers()
        this.clearFooterLayer(FOOTER_LAYER_ARMED)
        this.fsmState = { kind: "quitting", reason: "escape-hatch" }
        this.emit("quit", "escape-hatch" as QuitReason)
        this.emit("cancel", "escape-hatch" as QuitReason)
        return "ignore"
      }
      this.feedFsm({ kind: "ctrl-c", at: now })
      return "ignore"
    }

    // ESC - mirror `fireBareEscape`'s two-layer dispatch across ALL
    // encodings (bare \x1b, kitty \x1b[27u, xterm modifyOtherKeys
    // \x1b[27;1;27~). The InputCaptureStack and editor.key hook chain
    // get first crack BEFORE the FSM so overlay precedence is the
    // same regardless of how the terminal encodes the byte. Without
    // this dispatch the overlay-claim path was encoding-dependent.
    // The `escapeHatch.reset()` ran in consumePending (lead byte is
    // `\x1b`), matching `fireBareEscape`'s own reset so the "Esc
    // breaks the Ctrl+C run" invariant holds across encodings.
    if (code === 27 && !shift && !alt && !ctrl) {
      if (this.inputCaptureStack.dispatch("Escape")) return "ignore"
      if (this.dispatchKeyHook("Escape")) return "ignore"
      this.feedFsm({ kind: "esc", at: this.nowFn() })
      return "ignore"
    }

    if ((code === 10 || code === 13) && !ctrl) {
      if (shift || alt) {
        this.buf.newline()
        return "changed"
      }
      // bare Enter via kitty
      if (this.buf.isBlank()) {
        this.buf.clear()
        return "changed"
      }
      return "submit"
    }

    if (code === 127 && !shift && !alt && !ctrl) {
      return this.buf.deleteBackward() ? "changed" : "ignore"
    }

    if (code === 9 && !shift && !alt && !ctrl) {
      this.buf.insert("\t")
      return "changed"
    }

    // Shift+Tab and Ctrl+Shift+Tab: cycle modes. Without a handler wired,
    // we still swallow the keystroke so it doesn't fall through to a
    // printable insertion.
    if (code === 9 && shift && !alt) {
      if (ctrl) {
        if (this.cycleBackward) this.cycleBackward()
      } else {
        if (this.cycleForward) this.cycleForward()
      }
      return "ignore"
    }

    if (alt) {
      if (code === 98) return this.buf.moveWordLeft() ? "changed" : "ignore"
      if (code === 102) return this.buf.moveWordRight() ? "changed" : "ignore"
      // Alt+M / Option+M via CSI-u (kitty `\x1b[109;3u`) or xterm
      // modifyOtherKeys=2 (`\x1b[27;3;109~`). Mirrors the bare
      // `\x1b[1bm` branch in `parseMetaSequence` so the
      // interrupt-and-apply-mode shortcut works regardless of how the
      // terminal encodes meta keys :
      //
      //   - iTerm 3.5+ with kitty proto enabled (the agent's default
      //     after sending `\x1b[>31u` at startup) ships modified
      //     keys as CSI-u. Option+m arrives here as code=109, alt=true.
      //   - iTerm with kitty disabled AND "Option as Meta" enabled
      //     ships `\x1bm` (the legacy meta-prefix path, handled in
      //     `parseMetaSequence`).
      //   - iTerm with kitty disabled AND Option set to "Normal" ships
      //     the macOS-native `µ` (UTF-8 `\xc2\xb5`). That falls into
      //     the printable-text branch and inserts the character; the
      //     fix on the user side is to enable either kitty proto or
      //     "Option as Meta". Documented in editor-controller.ts
      //     above and in the agent README.
      //
      // Match both lowercase `m` (109) and uppercase `M` (77, via
      // Shift+Alt+m) so the shortcut is forgiving of the shift state.
      // The handler is opt-in via `setModeInterruptHandler`; when
      // unset we still consume the keystroke (return "ignore") so it
      // doesn't fall through to the `text && !ctrl` branch below and
      // insert a literal `m`.
      if (code === 109 || code === 77) {
        if (this.modeInterrupt) this.modeInterrupt()
        return "ignore"
      }
    }

    if (ctrl) {
      switch (code) {
        case 92: // \ - Ctrl+\ toggles show-hidden debug rendering
          this.setShowHidden(!this.showHiddenChars)
          return "changed"
        case 97:
          return this.buf.moveLineStart() ? "changed" : "ignore"
        // case 99 (Ctrl+C) handled at the top of this method via the
        // abort-quit FSM routing block - never reaches this switch.
        case 100:
          return this.buf.deleteForward() ? "changed" : "ignore"
        case 101:
          return this.buf.moveLineEnd() ? "changed" : "ignore"
        case 107:
          return this.buf.killToLineEnd() ? "changed" : "ignore"
        case 117:
          return this.buf.killToLineStart() ? "changed" : "ignore"
        case 119:
          return this.buf.deleteWordBackward() ? "changed" : "ignore"
      }
    }

    if (text && !ctrl) {
      this.buf.insert(text)
      return "changed"
    }

    if (!shift && !alt && !ctrl && this.isPrintableCodePoint(code)) {
      this.buf.insert(String.fromCodePoint(code))
      return "changed"
    }

    return "ignore"
  }

  private parseCsiUKey(seq: string): ParsedKey | null {
    if (!seq.endsWith("u")) return null
    const body = seq.slice(2, -1)
    const fields = body.split(";")
    const code = Number(fields[0]?.split(":")[0] ?? "")
    if (!Number.isInteger(code)) return null
    const modParts = fields[1]?.split(":") ?? []
    const modifiers = modParts[0] ? Number(modParts[0]) : 1
    const eventType = modParts[1] ? Number(modParts[1]) : 1
    if (!Number.isInteger(modifiers) || modifiers < 1) return null
    if (!Number.isInteger(eventType) || eventType < 1) return null
    return {
      code,
      modifiers,
      eventType,
      text: this.parseTextCodePoints(fields[2]),
    }
  }

  private parseXtermOtherKey(seq: string): ParsedKey | null {
    if (!seq.endsWith("~")) return null
    const body = seq.slice(2, -1)
    const fields = body.split(";")
    if (fields.length < 3 || fields[0] !== "27") return null
    const modifiers = Number(fields[1])
    const code = Number(fields[2])
    if (!Number.isInteger(code) || !Number.isInteger(modifiers) || modifiers < 1) return null
    return { code, modifiers, eventType: 1, text: null }
  }

  private parseTextCodePoints(field?: string): string | null {
    if (!field) return null
    const codePoints: number[] = []
    for (const part of field.split(":")) {
      const value = Number(part)
      if (!Number.isInteger(value) || value < 0) return null
      codePoints.push(value)
    }
    return codePoints.length > 0 ? String.fromCodePoint(...codePoints) : null
  }

  private hasModifier(modifiers: number, bit: number): boolean {
    return ((modifiers - 1) & (1 << bit)) !== 0
  }

  private isPrintable(char: string): boolean {
    const cp = char.codePointAt(0)
    return cp !== undefined && cp >= 0x20 && char !== "\x7f"
  }

  private isPrintableCodePoint(cp: number): boolean {
    return cp >= 0x20 && cp !== 0x7f
  }

  private findCsiEnd(input: string): number | null {
    for (let i = 2; i < input.length; i++) {
      const code = input.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) return i
    }
    return null
  }

  private consumeBracketedPaste(): "wait" | boolean {
    const idx = this.pending.indexOf(BRACKETED_PASTE_END)
    if (idx !== -1) {
      const pasted = this.pending.slice(0, idx)
      this.pending = this.pending.slice(idx + BRACKETED_PASTE_END.length)
      this.bracketedPaste = false
      return this.insertPasted(pasted)
    }
    const keep = this.trailingPrefixLength(this.pending, BRACKETED_PASTE_END)
    const pasted = this.pending.slice(0, this.pending.length - keep)
    if (pasted.length === 0) return "wait"
    this.pending = this.pending.slice(pasted.length)
    return this.insertPasted(pasted)
  }

  private insertPasted(text: string): boolean {
    if (this.pasteInterceptor) {
      try {
        const replaced = this.pasteInterceptor(text)
        if (replaced != null) text = replaced
      } catch {
        // interceptor failed -> fall through and insert the paste literally
      }
    }
    let changed = false
    let run = ""
    const flush = () => {
      if (!run) return
      this.buf.insert(run)
      run = ""
      changed = true
    }
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)
      if (cp === undefined) break
      const ch = String.fromCodePoint(cp)
      i += ch.length
      if (ch === "\r" || ch === "\n") {
        flush()
        if (i < text.length) {
          const next = text[i]
          if ((ch === "\r" && next === "\n") || (ch === "\n" && next === "\r")) {
            i += 1
          }
        }
        this.buf.newline()
        changed = true
        continue
      }
      if (ch === "\t" || this.isPrintable(ch)) run += ch
    }
    flush()
    return changed
  }

  private trailingPrefixLength(text: string, pattern: string): number {
    const max = Math.min(text.length, pattern.length - 1)
    for (let len = max; len > 0; len--) {
      if (text.endsWith(pattern.slice(0, len))) return len
    }
    return 0
  }

  private submit(): void {
    // While a modal overlay owns the input line, Enter belongs to the
    // overlay, not the prompt. Block submit so a stray Enter can never flush
    // the typed `/cmd` line (or anything else) to scrollback as a user turn.
    // The overlay's `editor.key` handler is what acts on Enter.
    if (this.overlayOwner !== null) return
    const text = this.buf.toString()
    // Render the FULL buffer (not the viewport window) so multiline
    // submissions are preserved verbatim in scrollback. The HOST decides
    // WHEN to flush these lines : deferred to turn-start (or tool-boundary
    // drain time for queued items) so a queued prompt does NOT appear in
    // BOTH the scrollback AND the queue widget at the same time (Bug 393).
    // The submit event carries the lines so the host doesn't re-render.
    //
    // When the buffer is empty (`buf.lines.length === 0`), commitLines is
    // an empty array : the host's flusher no-ops, preserving the prior
    // "empty submits are silently ignored" semantics.
    let commitLines: string[] = []
    if (this.buf.lines.length > 0) {
      // Race-defense: if the host wired `setCommitPromptBuilder`,
      // re-fetch the prompt prefix right now. Swap it into the
      // renderer just for this render call, then restore the previous
      // cached value so the live editor's next repaint paints with
      // the same byte-stable string. This closes the case where a
      // mode toggle's repaint subscriber raced with the Enter keypress
      // and the cached `this.prompt` was one tick behind the
      // `<ma::agent::mode-change>` attachment that's about to ship.
      let savedPrompt: string | null = null
      if (this.commitPromptBuilder) {
        const current = this.renderer.getPrompt()
        const fresh = this.commitPromptBuilder()
        if (fresh !== current) {
          savedPrompt = current
          this.renderer.setPrompt(fresh)
        }
      }
      try {
        const rendered = this.renderer.render(this.buf, {
          firstRow: 0,
          rowCount: this.buf.lines.length,
        })
        commitLines = rendered.lines
      } finally {
        if (savedPrompt !== null) this.renderer.setPrompt(savedPrompt)
      }
    }
    this.buf.clear()
    this.viewportTop = 0
    this.repaint()
    this.emit("submit", text, commitLines)
  }

  private repaint(): void {
    // Coalesced "input" event broadcast. Cheap (the timer is reset each
    // call; the actual emit only fires `inputDebounceMs` after the LAST
    // repaint). The fire path skips when buffer text is unchanged, so
    // cursor-only repaints don't generate spurious events.
    if (this.started) this.scheduleInputEmit()
    // Plugin-channel emit for `editor.buffer.changed`. Undebounced so
    // overlays (slash-menu, autocomplete, etc.) can re-render in lock-
    // step with the keystroke pump. Dedup'd internally — cursor-only
    // repaints don't trigger it.
    this.fireBufferChangedHook()
    const cols = (this.output as { columns?: number }).columns
    const decorationRows = this.decorationLines.length
    // Do not reserve the status band at cold idle. Once a status has
    // appeared, keep the band as blank rows when idle so status clear does
    // not move the prompt.
    const statusFilled = this.statusLine != null && this.statusLine.length > 0
    const statusReserved = statusFilled || this.statusRowReserved
    // One blank row between the status band and the editor keeps busy
    // state readable without moving the prompt again at end of turn.
    const statusGapRows = statusReserved ? 1 : 0
    const statusRows = (statusReserved ? 1 : 0) + decorationRows
    // A blank row between editor content and the footer when both are
    // present, so footer lines (quota, ambient status, etc.) don't visually
    // butt against the prompt's `❯ ` row.
    // Compose ONCE per repaint and thread the result through height
    // math (above) and layout assembly (below). The layer stack is
    // the source of truth; we never read a stale field.
    const composedFooter = this.composeFooter()
    const footerSpacerRows = composedFooter.length > 0 ? 1 : 0
    const footerRows = composedFooter.length + footerSpacerRows
    const cap = Math.max(1, this.maxLiveHeight())
    const editorBudget = Math.max(1, cap - statusRows - statusGapRows - footerRows)

    // Modal-owned short-circuit: a command overlay (/config, /usage) owns the
    // input line. Render ONLY the status band, decoration, and the overlay's
    // footer paint — NO prompt row, NO editor content, NO cursor in a phantom
    // prompt. The overlay's own UI lives entirely in `composedFooter` (it
    // emitted it via `editor.footer.set`). Park the cursor at the top-left so
    // the terminal doesn't blink it inside the hidden prompt.
    if (this.overlayOwner !== null) {
      const rawStatusOwned = this.statusLine ?? ""
      const statusLineOwned =
        !rawStatusOwned || !cols || cols <= 0
          ? rawStatusOwned
          : truncateDisplayWidth(rawStatusOwned, cols)
      const ownedHead: string[] = statusReserved ? [statusLineOwned] : []
      const ownedGap: string[] = statusGapRows > 0 ? Array(statusGapRows).fill("") : []
      const ownedFooter = composedFooter.length > 0 ? [...composedFooter] : []
      const ownedLines = [...ownedHead, ...this.decorationLines, ...ownedGap, ...ownedFooter]
      const ownedTarget = ownedLines.length
      if (ownedTarget !== this.compositor.liveHeight) {
        this.compositor.setLiveHeight(Math.max(1, ownedTarget))
      }
      this.compositor.setLiveArea(ownedLines, { row: 0, col: 0 })
      return
    }

    // Run the viewport/window calculation for a given physical-row content
    // budget. Does not mutate any state; returns the computed values.
    const computeWindow = (budget: number, startVTop: number) => {
      let vTop = startVTop
      if (this.buf.row < vTop) vTop = this.buf.row
      const totalLogical = this.buf.lines.length
      // Tentatively grow the window to include the cursor row, then trim
      // from the top until it fits in the physical budget.
      let windowEnd = Math.max(this.buf.row + 1, vTop + 1)
      if (windowEnd > totalLogical) windowEnd = totalLogical
      let physicalRows = this.measureWindowPhysicalRows(vTop, windowEnd, cols)
      while (physicalRows > budget && vTop < this.buf.row) {
        vTop += 1
        physicalRows = this.measureWindowPhysicalRows(vTop, windowEnd, cols)
      }
      // Try to extend the window downward to fill remaining budget.
      while (windowEnd < totalLogical) {
        const next = this.measureWindowPhysicalRows(vTop, windowEnd + 1, cols)
        if (next > budget) break
        windowEnd += 1
        physicalRows = next
      }
      // Try to extend upward too if there's room.
      while (vTop > 0) {
        const next = this.measureWindowPhysicalRows(vTop - 1, windowEnd, cols)
        if (next > budget) break
        vTop -= 1
        physicalRows = next
      }
      return { vTop, windowEnd, physicalRows }
    }

    // Pass 1: compute window with full editor budget (no indicator reservation).
    let { vTop, windowEnd, physicalRows } = computeWindow(editorBudget, this.viewportTop)

    // When the viewport is scrolled AND we have room (editorBudget ≥ 2), reserve
    // a separate indicator row above the content rows.  This prevents the cursor
    // from ever landing on the "↑ N more lines" line: redo the window calculation
    // with a budget reduced by 1 so the cursor always maps to a content row.
    // With editorBudget=1 there is no room for both indicator and content, so we
    // fall back to the replacing behaviour (indicator overwrites the single row).
    const needSeparateIndicator = vTop > 0 && editorBudget >= 2
    if (needSeparateIndicator) {
      const r = computeWindow(editorBudget - 1, this.viewportTop)
      vTop = r.vTop
      windowEnd = r.windowEnd
      physicalRows = r.physicalRows
    }

    this.viewportTop = vTop

    const editorWindow = Math.max(1, windowEnd - vTop)
    // Re-check after pass 2 (in the unlikely case pass 2 brought vTop back to
    // 0, no indicator is needed and we reclaim the reserved row).
    const actualNeedSeparate = needSeparateIndicator && vTop > 0
    const target =
      physicalRows + statusRows + statusGapRows + footerRows + (actualNeedSeparate ? 1 : 0)
    if (target !== this.compositor.liveHeight) {
      this.compositor.setLiveHeight(target)
    }

    const { lines, cursor } = this.renderer.render(this.buf, {
      firstRow: vTop,
      rowCount: editorWindow,
      columns: cols,
    })

    // Build the scroll indicator when content is hidden above the viewport.
    //
    // The indicator carries the active mode's prompt prefix (e.g. `❯ ` in
    // default mode, `ASK ❯ ` in ASK) BEFORE the dashes+label. This is the
    // only place the user can read off the mode while the buffer is
    // scrolled: visible content rows below the indicator render with the
    // continuation prompt (two spaces) and carry no mode info.
    //
    // The prompt comes pre-styled (its own SGR open/close). We then open a
    // dim attribute (`\x1b[2m`) for the dashes+label and close with
    // `\x1b[22m`. `cols` is read fresh from `this.output.columns` on every
    // repaint, so SIGWINCH → `notifyResize()` → `repaint()` recomputes the
    // dash run to fit the new width.
    let indicatorLine: string | null = null
    if (vTop > 0) {
      const w = cols ?? 0
      const n = vTop
      const label = `^ ${n} more line${n === 1 ? "" : "s"}`
      const prompt = this.renderer.getPrompt()
      const promptW = this.renderer.getPromptDisplayWidth()
      const labelW = label.length // pure ASCII; bytes == display cells
      // Three forms, picked by available width (preferring mode visibility):
      //   1. `<prompt><dashes> <label>` when room for ≥1 dash + spacing.
      //      Fixed cells = promptW + 1 (dash) + 1 (space) + labelW = promptW + labelW + 2.
      //      Pad 1 trailing cell so the row never wraps at exact width.
      //   2. `<prompt><label>` when prompt + label fit but no dash room.
      //      The prompt's trailing space already separates it from the `^`.
      //   3. ` <label>` bare fallback when even the prompt doesn't fit.
      //      Same shape as the pre-mode-aware indicator - graceful degrade.
      if (w >= promptW + labelW + 3) {
        const dashes = w - promptW - labelW - 2
        indicatorLine = `${prompt}\x1b[2m${"\u2500".repeat(dashes)} ${label}\x1b[22m`
      } else if (w >= promptW + labelW) {
        indicatorLine = `${prompt}\x1b[2m${label}\x1b[22m`
      } else {
        indicatorLine = `\x1b[2m ${label}\x1b[22m`
      }
    }

    const rawStatus = this.statusLine ?? ""
    const statusLine =
      !rawStatus || !cols || cols <= 0 ? rawStatus : truncateDisplayWidth(rawStatus, cols)

    let finalLines: string[]
    let finalCursor: { row: number; col: number }

    // Layout (top → bottom):
    //   [statusLine]              ← 0 or 1 row (only when status is FILLED)
    //   [...decorationLines]      ← 0..N rows (queue display, etc.)
    //   ["", ""]                  ← 0 or 2 rows (blank gap, only when status filled)
    //   [indicatorLine?]          ← 0..1 row (scroll indicator, if needed)
    //   [...lines]                ← editor content
    //   [footerSpacer = ""]       ← 0 or 1 row (only when footer is present)
    //   [...composedFooter]       ← 0..N rows (highest-priority non-empty layer
    //                               wins composition: quota/diagnostic at
    //                               priority 0, armed-quit at priority 100,
    //                               etc. See `setFooterLayer` and
    //                               `composeFooter` for the contract.)
    // Cursor offset = (statusRows = statusFilled?1:0 + decorationRows)
    //               + statusGapRows + indicatorOffset.
    const decoration = this.decorationLines
    const head: string[] = statusReserved ? [statusLine] : []
    const gap: string[] = statusGapRows > 0 ? Array(statusGapRows).fill("") : []
    const footerWithSpacer = composedFooter.length > 0 ? ["", ...composedFooter] : []
    const baseOffset = statusRows + statusGapRows
    if (actualNeedSeparate && indicatorLine) {
      // Separate indicator row above content.
      finalLines = [...head, ...decoration, ...gap, indicatorLine, ...lines, ...footerWithSpacer]
      finalCursor = { row: cursor.row + baseOffset + 1, col: cursor.col }
    } else if (indicatorLine && lines.length > 0) {
      // Fallback for editorBudget=1: indicator replaces the single content row.
      lines[0] = indicatorLine
      finalLines = [...head, ...decoration, ...gap, ...lines, ...footerWithSpacer]
      finalCursor = { row: cursor.row + baseOffset, col: cursor.col }
    } else {
      // No indicator (viewport at top).
      finalLines = [...head, ...decoration, ...gap, ...lines, ...footerWithSpacer]
      finalCursor = { row: cursor.row + baseOffset, col: cursor.col }
    }

    this.compositor.setLiveArea(finalLines, finalCursor)
  }

  private measureWindowPhysicalRows(
    firstRow: number,
    endRow: number,
    cols: number | undefined,
  ): number {
    if (endRow <= firstRow) return 1
    const { lines } = this.renderer.render(this.buf, {
      firstRow,
      rowCount: endRow - firstRow,
      columns: cols,
    })
    return Math.max(1, lines.length)
  }
}
