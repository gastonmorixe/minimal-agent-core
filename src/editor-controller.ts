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
import { EditorKeyDispatcher, type KeyDispatchHost } from "./editor/key-dispatch.ts"
import {
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
  type QueueKeyContext,
  type QueueKeyHandler,
  type QueueKeyResult,
  type SetFooterLayerOptions,
  XTERM_FORMAT_OTHER_KEYS_DISABLE,
  XTERM_FORMAT_OTHER_KEYS_ENABLE,
  XTERM_MODIFY_OTHER_KEYS_DISABLE,
  XTERM_MODIFY_OTHER_KEYS_ENABLE,
} from "./editor/types.ts"
import { VerticalNavigator } from "./editor/vertical-nav.ts"
import { EditorBuffer } from "./editor-buffer.ts"
import { type InputCaptureStack, inputCaptureStack } from "./input-capture-stack.ts"
import type { Hooks } from "./plugins/hooks/hooks.ts"
import { truncateDisplayWidth } from "./term-width.ts"
import { formatArmedFooter } from "./ui/chrome/armed-footer.ts"
import { computeCursorVisualPos, EditorRenderer } from "./ui/editor/renderer.ts"
import { c } from "./ui/style/ansi.ts"

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

/**
 * Orchestrates the interactive prompt: owns the editor buffer, key dispatch
 * (including the plugin `editor.key` hook chain), kill-ring, undo, history
 * navigation, and submit/cancel events for the REPL.
 */
export class EditorController extends EventEmitter {
  private readonly buf = new EditorBuffer()
  private readonly renderer: EditorRenderer
  private readonly compositor: CompositorLike
  private readonly stdin: NodeJS.ReadStream
  private readonly output: Pick<NodeJS.WriteStream, "write">
  private readonly maxLiveHeight: () => number
  private viewportTop = 0
  /**
   * Byte-stream key dispatcher: owns the `pending` buffer, the
   * bracketed-paste flag, and the bare-Esc disambiguation timer, and
   * routes parsed keys back into this controller through the
   * {@link KeyDispatchHost} closure bag built in the constructor.
   */
  private readonly dispatcher: EditorKeyDispatcher
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
   * Wrap-aware vertical cursor movement with sticky visual column.
   * Owns the sticky-column state; see `editor/vertical-nav.ts`.
   */
  private readonly verticalNav: VerticalNavigator
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
   * the dispatch order lives in `editor/key-dispatch.ts`.
   */
  private readonly inputCaptureStack: InputCaptureStack
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
    this.dispatcher.onData(chunk)
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
    this.inputDebounceMs = opts.inputDebounceMs ?? 120
    this.resizeDebounceMs = opts.resizeDebounceMs ?? 150
    this.abortBus = opts.abortBus ?? abortBus
    this.fsmOptions = opts.quitFsm ?? {}
    this.nowFn = opts.nowFn ?? (() => Date.now())
    this.armedTickMs = opts.armedTickMs ?? 250
    this.hooks = opts.hooks ?? null
    this.inputCaptureStack = opts.inputCaptureStack ?? inputCaptureStack
    this.verticalNav = new VerticalNavigator(
      this.buf,
      (row) => this.renderer.promptDisplayWidthForRow(row),
      () => (this.output as { columns?: number }).columns,
    )
    this.dispatcher = new EditorKeyDispatcher(this.makeDispatchHost(), {
      bareEscapeMs: opts.bareEscapeMs ?? 20,
    })
  }

  /**
   * Build the {@link KeyDispatchHost} closure bag the byte-stream
   * dispatcher drives. Every member forwards to controller state /
   * behavior that the pre-extraction `consumePending` pipeline reached
   * via `this`; the indirection exists purely so the dispatch state
   * machine can live in `editor/key-dispatch.ts`.
   */
  private makeDispatchHost(): KeyDispatchHost {
    return {
      buf: this.buf,
      escapeHatch: this.escapeHatch,
      captureStack: this.inputCaptureStack,
      fsmKind: () => this.fsmState.kind,
      feedFsm: (input) => {
        this.feedFsm(input)
      },
      now: () => this.nowFn(),
      forceQuitEscapeHatch: () => {
        this.stopArmedTimers()
        this.clearFooterLayer(FOOTER_LAYER_ARMED)
        this.fsmState = { kind: "quitting", reason: "escape-hatch" }
        this.emit("quit", "escape-hatch" as QuitReason)
        this.emit("cancel", "escape-hatch" as QuitReason)
        // Hard guarantee: rapid double-Ctrl+C ALWAYS quits.
        // Cooperative cancellation (emit → REPL loop → cancelled check)
        // can't break out of a hung transport (the inner gen.next() await
        // never resolves). process.exit() tears through the event loop;
        // the existing process.on("exit") handler in installCleanupHooksOnce
        // still restores terminal settings first.
        setImmediate(() => process.exit(0))
      },
      dispatchKeyHook: (key) => this.dispatchKeyHook(key),
      tryQueueNav: (key) => this.tryQueueNav(key),
      isOverlayOwned: () => this.overlayOwner !== null,
      cycleForward: () => {
        if (this.cycleForward) this.cycleForward()
      },
      cycleBackward: () => {
        if (this.cycleBackward) this.cycleBackward()
      },
      modeInterrupt: () => {
        if (this.modeInterrupt) this.modeInterrupt()
      },
      clipboardPasteText: () => {
        if (!this.clipboardPaste) return null
        try {
          return this.clipboardPaste()
        } catch {
          return null
        }
      },
      interceptPaste: (text) => {
        if (this.pasteInterceptor) {
          try {
            const replaced = this.pasteInterceptor(text)
            if (replaced != null) return replaced
          } catch {
            // interceptor failed -> insert the paste literally
          }
        }
        return text
      },
      moveUpVisual: () => this.verticalNav.moveUp(),
      moveDownVisual: () => this.verticalNav.moveDown(),
      toggleShowHidden: () => {
        this.setShowHidden(!this.showHiddenChars)
      },
      submit: () => {
        this.submit()
      },
      repaint: () => {
        this.repaint()
      },
    }
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
   * @param key - Canonical key name ("ArrowUp", "ArrowDown", "Ctrl+R", …).
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
          // Hard guarantee: confirmed Ctrl+C×2 ALWAYS quits.
          // Same rationale as forceQuitEscapeHatch above: cooperative
          // cancellation can't break a hung transport. process.exit()
          // tears through the event loop; the existing process.on("exit")
          // handler in installCleanupHooksOnce still restores the terminal.
          setImmediate(() => process.exit(0))
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
    this.dispatcher.resetPasteState()
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
   * Runtime toggle keybinding: Ctrl+backslash (sends `\x1c` in raw mode,
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
    this.emit("submit", text, commitLines, new Date())
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
    // The prompt comes pre-styled (its own SGR open/close). The indicator
    // suffix uses the shared dim wrapper. `cols` is read fresh from
    // `this.output.columns` on every repaint, so SIGWINCH → `notifyResize()`
    // → `repaint()` recomputes the dash run to fit the new width.
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
        indicatorLine = `${prompt}${c.dim(`${"\u2500".repeat(dashes)} ${label}`)}`
      } else if (w >= promptW + labelW) {
        indicatorLine = `${prompt}${c.dim(label)}`
      } else {
        indicatorLine = c.dim(` ${label}`)
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
