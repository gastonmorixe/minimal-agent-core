/**
 * Raw-stdin key dispatch for the {@link EditorController}: consumes the
 * pending byte stream and turns it into editor actions.
 *
 * Owns the byte-level state machine - the `pending` buffer, the
 * bracketed-paste mode flag, and the bare-Esc disambiguation timer -
 * and translates terminal input (control bytes, CSI sequences, kitty
 * CSI-u / xterm modifyOtherKeys encodings, bracketed pastes) into calls
 * on a narrow {@link KeyDispatchHost} interface implemented by the
 * controller. Extracted verbatim from `src/editor-controller.ts` so the
 * controller stays under the repo's `max-lines` budget; no behavior
 * changes.
 *
 * @module editor/key-dispatch
 */

import type { EscapeHatch, FsmInput, FsmState } from "../../bus/abort-quit-fsm.ts"
import type { EditorBuffer } from "../../input/editor-buffer.ts"
import type { InputCaptureStack } from "../../input/input-capture-stack.ts"
import {
  findCsiEnd,
  hasModifier,
  isPrintableChar,
  isPrintableCodePoint,
  parseCsiUKey,
  parseXtermOtherKey,
  trailingPrefixLength,
} from "../../input/key-codec.ts"

import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "./types.ts"

/**
 * The editor capabilities the key dispatcher drives. Implemented by
 * `EditorController` as a bag of bound closures; every member maps 1:1
 * onto controller state/behavior that pre-extraction code reached via
 * `this`. Kept narrow and documented so the byte-level pipeline can be
 * read (and tested) without the full controller in view.
 */
export interface KeyDispatchHost {
  /** The shared editor text buffer; the dispatcher edits it in place. */
  readonly buf: EditorBuffer
  /** The rapid-double-Ctrl+C escape hatch (spec rule 5). */
  readonly escapeHatch: EscapeHatch
  /** LIFO transient ESC capture stack; consulted before the hook chain. */
  readonly captureStack: InputCaptureStack
  /** Current abort-quit FSM state kind (e.g. "armed", "quitting"). */
  fsmKind(): FsmState["kind"]
  /** Drive the abort-quit FSM with one input; effects are applied by the host. */
  feedFsm(input: FsmInput): void
  /** Clock used for FSM timestamps (injectable in tests). */
  now(): number
  /**
   * Escape-hatch force-quit: tear down armed timers/footer, mark the FSM
   * quitting, and emit `quit`/`cancel` with reason `"escape-hatch"`.
   */
  forceQuitEscapeHatch(): void
  /** Broadcast `editor.key`; true = a listener halted default handling. */
  dispatchKeyHook(key: string): boolean
  /** Offer a key to the submit-queue nav handler; true = claimed. */
  tryQueueNav(key: string): boolean
  /** True while a modal overlay owns the input line. */
  isOverlayOwned(): boolean
  /** Invoke the Shift+Tab mode-cycle handler when wired (else no-op). */
  cycleForward(): void
  /** Invoke the Ctrl+Shift+Tab mode-cycle handler when wired (else no-op). */
  cycleBackward(): void
  /** Invoke the Alt+M interrupt-and-apply-mode handler when wired (else no-op). */
  modeInterrupt(): void
  /**
   * Pull clipboard text for Ctrl+V via the wired handler. Returns `null`
   * when no handler is wired, the handler throws, or there is nothing to
   * paste - all of which mean "swallow the keystroke".
   */
  clipboardPasteText(): string | null
  /**
   * Run the paste interceptor over pasted text. Returns the replacement
   * (e.g. a media token) or the original text when no interceptor is
   * wired / the interceptor declines / throws.
   */
  interceptPaste(text: string): string
  /** Wrap-aware cursor-up; true when the cursor moved. */
  moveUpVisual(): boolean
  /** Wrap-aware cursor-down; true when the cursor moved. */
  moveDownVisual(): boolean
  /** Toggle show-hidden-characters rendering (Ctrl+\). */
  toggleShowHidden(): void
  /** Submit the current buffer (controller emits `submit` + repaints). */
  submit(): void
  /** Repaint the live area after buffer mutations. */
  repaint(): void
}

/** Options for {@link EditorKeyDispatcher}. */
export interface KeyDispatchOptions {
  /**
   * Bare-Esc disambiguation window in ms; see
   * `EditorControllerOptions.bareEscapeMs`.
   */
  bareEscapeMs: number
  /** Window after one confirmed Escape for `EscapeEscape` recognition. */
  doubleEscapeMs: number
}

/**
 * Byte-stream consumer for the editor controller. Feed it stdin chunks
 * via {@link onData}; it parses them (coalescing split escape sequences
 * across chunks) and drives the {@link KeyDispatchHost}.
 */
export class EditorKeyDispatcher {
  private pending = ""
  private bracketedPaste = false
  private bareEscapeTimer: ReturnType<typeof setTimeout> | null = null
  private doubleEscapeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly bareEscapeMs: number
  private readonly doubleEscapeMs: number

  constructor(
    private readonly host: KeyDispatchHost,
    opts: KeyDispatchOptions,
  ) {
    this.bareEscapeMs = opts.bareEscapeMs
    this.doubleEscapeMs = opts.doubleEscapeMs
  }

  /** Append a stdin chunk and consume as much of `pending` as possible. */
  onData(chunk: string | Buffer): void {
    const input = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    // Two literal Escapes are never a terminal control sequence. Confirm both
    // immediately, rather than treating the second byte as an unknown escape.
    if (input === "\x1b\x1b" && this.pending.length === 0) {
      this.confirmEscape()
      this.confirmEscape()
      return
    }
    if (this.bareEscapeTimer !== null && this.pending === "\x1b" && input === "\x1b") {
      this.cancelBareEscapeTimer()
      this.pending = ""
      this.confirmEscape()
      this.confirmEscape()
      return
    }
    if (this.doubleEscapeTimer !== null && !input.startsWith("\x1b")) {
      clearTimeout(this.doubleEscapeTimer)
      this.doubleEscapeTimer = null
      this.dispatchSingleEscape()
    }
    this.cancelBareEscapeTimer()
    this.pending += input
    this.consumePending()
  }

  /**
   * Drop bracketed-paste mode. Called by the controller's `stop()` so a
   * stopped editor doesn't resume mid-paste.
   */
  resetPasteState(): void {
    this.bracketedPaste = false
  }

  /** Clear pending input and delayed Escape routes. */
  dispose(): void {
    this.cancelBareEscapeTimer()
    if (this.doubleEscapeTimer !== null) clearTimeout(this.doubleEscapeTimer)
    this.doubleEscapeTimer = null
    this.pending = ""
    this.bracketedPaste = false
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
    if (this.pending === "\x1b") this.pending = ""
    this.confirmEscape()
  }

  private confirmEscape(): void {
    if (this.doubleEscapeTimer !== null) {
      clearTimeout(this.doubleEscapeTimer)
      this.doubleEscapeTimer = null
      if (this.host.captureStack.dispatch("EscapeEscape")) return
      if (this.host.dispatchKeyHook("EscapeEscape")) return
      this.dispatchSingleEscape()
      return
    }
    if (this.doubleEscapeMs <= 0) {
      this.dispatchSingleEscape()
      return
    }
    this.doubleEscapeTimer = setTimeout(() => {
      this.doubleEscapeTimer = null
      this.dispatchSingleEscape()
    }, this.doubleEscapeMs)
    ;(this.doubleEscapeTimer as { unref?: () => void }).unref?.()
  }

  private dispatchSingleEscape(): void {
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
    if (this.host.captureStack.dispatch("Escape")) {
      return
    }
    if (this.host.dispatchKeyHook("Escape")) {
      return
    }
    // Submit-queue nav: Esc closes the dequeue overlay (queue left
    // intact) and must NOT abort the turn. Only claims when the overlay
    // is open; otherwise falls through to the abort-quit FSM below so a
    // plain Esc still aborts an in-flight turn (which itself dequeues
    // everything back to the prompt — see runReplLiveArea's abort path).
    if (this.host.tryQueueNav("Escape")) {
      return
    }
    // Esc breaks the escape-hatch run too - otherwise (Ctrl+C, Esc,
    // Ctrl+C) would force-quit even though the user said "cancel that".
    this.host.escapeHatch.reset()
    // Feed the FSM. In `working` state this emits `abort-turn` (no arm).
    // In `armed` state this emits `hide-armed` (Esc cancels the modal).
    // In `idle` state this is a no-op.
    this.host.feedFsm({ kind: "esc", at: this.host.now() })
  }

  private consumePending(): void {
    const { host } = this
    const buf = host.buf
    let dirty = false
    while (this.pending.length > 0) {
      if (this.bracketedPaste) {
        // A bracketed paste while the quit-confirm modal is open means
        // the user is back to editing - dismiss.
        if (host.fsmKind() === "armed") {
          host.feedFsm({ kind: "printable", at: host.now() })
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
      if (host.fsmKind() === "armed" && !isCtrlC && !isBareEsc && !isCsiEsc) {
        host.feedFsm({ kind: "printable", at: host.now() })
      }

      // Reset the escape-hatch run on any non-Ctrl+C keystroke. Two
      // Ctrl+Cs with non-Ctrl+C input between them are NOT a "rapid
      // double" anymore, even if they land within 500ms. The CSI
      // lookahead above ensures kitty/xterm-encoded Ctrl+C preserves
      // the timestamp.
      if (!isCtrlC) host.escapeHatch.reset()

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
          if (dirty) host.repaint()
          return
        }
        const handled = this.consumeEscape()
        if (handled === "wait") return
        if (handled === "submit") {
          host.submit()
          return // submit() repaints; stop processing here
        }
        // CSI-encoded Ctrl+C / ESC route through the FSM inside
        // parseModifiedKeySequence (May 2026 - fixes Bug A + Bug B per
        // `src/abort-quit-keystroke.test.ts`). If those transitions land
        // us in `quitting`, bail out before processing more pending bytes
        // - mirrors the bare-\x03 handler at the bottom of this loop.
        if (host.fsmKind() === "quitting") return
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
      if (host.isOverlayOwned()) {
        if (char === "\x7f" || char === "\x08") {
          host.dispatchKeyHook("Backspace")
          continue
        }
        if (isPrintableChar(char)) {
          // Greedy run so a paste burst is one dispatch per char (cheap; the
          // overlay's draft append is O(1)). Each char is its own key event.
          host.dispatchKeyHook(char)
          while (this.pending.length > 0 && !this.pending.startsWith("\x1b")) {
            const cp = this.pending.codePointAt(0)
            if (cp === undefined) break
            const ch = String.fromCodePoint(cp)
            if (!isPrintableChar(ch)) break
            this.pending = this.pending.slice(ch.length)
            host.dispatchKeyHook(ch)
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
        if (host.tryQueueNav("Enter")) {
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
          buf.newline()
          dirty = true
          continue
        }
        if (buf.isBlank()) {
          // Even on a blank buffer, an overlay (ask-user modal / slash-menu)
          // gets first crack at Enter — otherwise a confirm-modal can't be
          // confirmed on an empty prompt (the keystroke would be eaten by the
          // blank no-op below before reaching the hook chain at submit-time).
          if (host.dispatchKeyHook("Enter")) {
            continue
          }
          buf.clear()
          dirty = true
          continue
        }
        // Pasted multiline arriving without bracketed-paste markers shows
        // up here as `\r` followed by more printable bytes; treat as a
        // newline insertion. A trailing escape sequence (e.g. arrow key
        // coalesced into the same chunk) means the Enter is real.
        if (this.pending.length > 0 && !this.pending.startsWith("\x1b")) {
          buf.newline()
          dirty = true
          continue
        }
        // Plugins (slash-menu, etc.) can intercept Enter on a non-empty
        // buffer to swallow the submit (e.g. "execute the selected menu
        // item instead"). When halted, the listener typically also
        // sets `result.buffer = ""` to clear the prompt afterwards.
        if (host.dispatchKeyHook("Enter")) {
          continue
        }
        host.submit()
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
        const now = host.now()
        if (host.escapeHatch.observe(now) === "force-quit") {
          host.forceQuitEscapeHatch()
          return
        }
        // Normal path: feed the FSM, let `applyEffects` do the IO.
        host.feedFsm({ kind: "ctrl-c", at: now })
        if (host.fsmKind() === "quitting") return
        continue
      }
      if (char === "\x04") {
        if (buf.deleteForward()) dirty = true
        continue
      }
      if (char === "\x7f") {
        if (buf.deleteBackward()) dirty = true
        continue
      }
      if (char === "\x01") {
        if (buf.moveLineStart()) dirty = true
        continue
      }
      if (char === "\x05") {
        if (buf.moveLineEnd()) dirty = true
        continue
      }
      if (char === "\x0b") {
        if (buf.killToLineEnd()) dirty = true
        continue
      }
      if (char === "\x15") {
        if (buf.killToLineStart()) dirty = true
        continue
      }
      if (char === "\x17") {
        if (buf.deleteWordBackward()) dirty = true
        continue
      }
      if (char === "\x12") {
        // Ctrl+R — reverse history search (history plugin). When no
        // listener consumes it, swallow silently rather than inserting
        // a control byte; readline-style "Ctrl+R but no history" is
        // a no-op everywhere we've ever seen.
        if (host.dispatchKeyHook("Ctrl+R")) dirty = true
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
        const replacement = host.clipboardPasteText()
        if (replacement != null && replacement.length > 0) {
          if (this.insertPasted(replacement)) dirty = true
        }
        continue
      }
      if (char === "\x1c") {
        // Ctrl+\ - toggle show-hidden debug rendering
        host.toggleShowHidden()
        dirty = true
        continue
      }
      if (char === "\t") {
        // Plugins (notably the slash-menu overlay) can intercept Tab.
        // When halted, the listener has either consumed the key (e.g.
        // tab-complete inside an overlay) or replaced the buffer; the
        // default literal-tab insertion is suppressed.
        if (host.dispatchKeyHook("Tab")) {
          dirty = true
          continue
        }
        buf.insert(char)
        dirty = true
        continue
      }
      if (isPrintableChar(char)) {
        // Submit-queue nav: while the overlay is open, single printables
        // are commands (`d` dequeue, `x` remove, `k` dequeue all) and
        // every other printable is swallowed to keep the overlay modal.
        // When the overlay is closed the handler returns false instantly
        // and we fall through to the normal greedy-insert path. Checked
        // per printable RUN (not per char), so normal typing pays at
        // most one cheap handler call per burst.
        if (host.tryQueueNav(char)) {
          dirty = true
          continue
        }
        // A typed slash-menu trigger must be observable after insertion.
        // Pasted input takes insertPasted(), so it deliberately never enters
        // this key-hook path or causes autocomplete flicker.
        let run = char
        while (this.pending.length > 0 && !this.pending.startsWith("\x1b")) {
          const cp = this.pending.codePointAt(0)
          if (cp === undefined) break
          const ch = String.fromCodePoint(cp)
          if (!isPrintableChar(ch)) break
          run += ch
          this.pending = this.pending.slice(ch.length)
        }
        if (run.includes("/") || run.includes("$")) {
          for (const ch of run) {
            buf.insert(ch)
            if (ch === "/" || ch === "$") host.dispatchKeyHook(ch)
          }
        } else {
          buf.insert(run)
        }
        dirty = true
        continue
      }
    }
    if (dirty) host.repaint()
  }

  /**
   * Lookahead: is `this.pending` currently headed by a complete CSI sequence
   * that parses to Ctrl+C (kitty CSI-u `\x1b[99;5u` or xterm modifyOtherKeys
   * `\x1b[27;5;99~`)?
   *
   * Used by `consumePending` to decide whether to reset the escape-hatch
   * BEFORE the CSI sequence is parsed. Without this, mixed-encoding
   * rapid-double-Ctrl+C (`\x03` → `\x1b[99;5u` within 500ms) would lose its
   * timestamp and the escape-hatch backstop would silently fail. See
   * `src/abort-quit-keystroke.test.ts` "armed state transitions" for the
   * cross-encoding regression guard.
   *
   * Returns false on incomplete sequences (the next read will retry).
   */
  private pendingHeadIsCsiCtrlC(): boolean {
    if (!this.pending.startsWith("\x1b[")) return false
    const end = findCsiEnd(this.pending)
    if (end === null) return false
    const seq = this.pending.slice(0, end + 1)
    const key = parseCsiUKey(seq) ?? parseXtermOtherKey(seq)
    if (!key) return false
    // Code 99 = 'c'; modifier bit 2 = ctrl per kitty/xterm.
    return key.code === 99 && hasModifier(key.modifiers, 2)
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
    const end = findCsiEnd(this.pending)
    if (end === null) return false
    const seq = this.pending.slice(0, end + 1)
    const key = parseCsiUKey(seq) ?? parseXtermOtherKey(seq)
    if (!key) return false
    return key.code === 27 && key.modifiers <= 1
  }

  private consumeEscape(): "wait" | "ignore" | "changed" | "submit" {
    const { host } = this
    const buf = host.buf
    const input = this.pending
    if (input.length === 1) return "wait"

    if (input[1] === "[") {
      const end = findCsiEnd(input)
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
        host.cycleForward()
        return "ignore"
      }
      const modKey = this.parseModifiedKeySequence(seq)
      if (modKey) return modKey
      switch (seq) {
        case "\x1b[3~":
          return buf.deleteForward() ? "changed" : "ignore"
        case "\x1b[D":
          // Overlays (ask-user modal) capture ←/→ for option navigation; only
          // move the buffer cursor when no listener claims the key.
          if (host.dispatchKeyHook("ArrowLeft")) return "changed"
          return buf.moveLeft() ? "changed" : "ignore"
        case "\x1b[C":
          if (host.dispatchKeyHook("ArrowRight")) return "changed"
          return buf.moveRight() ? "changed" : "ignore"
        case "\x1b[A":
          // Submit-queue nav gets first crack at ↑ (open the dequeue
          // overlay / single-item dequeue / move selection up). It only
          // claims when a turn has a queue and the cursor is at the top
          // of an empty prompt; otherwise it passes through.
          if (host.tryQueueNav("ArrowUp")) return "changed"
          // Plugins (notably `history`) can intercept ↑. The hook may
          // halt + replace the buffer; otherwise we fall through to the
          // wrap-aware in-buffer cursor-up.
          if (host.dispatchKeyHook("ArrowUp")) return "changed"
          return host.moveUpVisual() ? "changed" : "ignore"
        case "\x1b[B":
          if (host.tryQueueNav("ArrowDown")) return "changed"
          if (host.dispatchKeyHook("ArrowDown")) return "changed"
          return host.moveDownVisual() ? "changed" : "ignore"
        case "\x1b[1;3D":
          return buf.moveWordLeft() ? "changed" : "ignore"
        case "\x1b[1;3C":
          return buf.moveWordRight() ? "changed" : "ignore"
        case "\x1b[H":
        case "\x1b[1~":
          return buf.moveLineStart() ? "changed" : "ignore"
        case "\x1b[F":
        case "\x1b[4~":
          return buf.moveLineEnd() ? "changed" : "ignore"
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
          return buf.moveLineStart() ? "changed" : "ignore"
        case "\x1bOF":
          return buf.moveLineEnd() ? "changed" : "ignore"
        default:
          return "ignore"
      }
    }

    const seq = input.slice(0, 2)
    this.pending = input.slice(2)
    switch (seq) {
      case "\x1b\r":
      case "\x1b\n":
        buf.newline()
        return "changed"
      case "\x1bb":
        return buf.moveWordLeft() ? "changed" : "ignore"
      case "\x1bf":
        return buf.moveWordRight() ? "changed" : "ignore"
      // Alt+M / Option+M : interrupt-and-apply-mode. Cross-terminal
      // portable (CTRL+M is byte-identical to Enter, so we use the
      // meta-prefix path instead). The handler is opt-in via
      // `setModeInterruptHandler`; when unset we drop the bytes
      // silently so a stray Alt+M doesn't insert a literal `m`.
      case "\x1bm":
        host.modeInterrupt()
        return "ignore"
      default:
        return "ignore"
    }
  }

  private parseModifiedKeySequence(seq: string): "ignore" | "changed" | "submit" | null {
    const { host } = this
    const buf = host.buf
    const key = parseCsiUKey(seq) ?? parseXtermOtherKey(seq)
    if (!key) return null
    if (key.eventType !== 1) return "ignore"

    const { code, modifiers, text } = key
    const shift = hasModifier(modifiers, 0)
    const alt = hasModifier(modifiers, 1)
    const ctrl = hasModifier(modifiers, 2)

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
      else if (isPrintableCodePoint(code)) navKey = String.fromCodePoint(code)
      if (navKey !== null && host.tryQueueNav(navKey)) {
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
      const now = host.now()
      if (host.escapeHatch.observe(now) === "force-quit") {
        host.forceQuitEscapeHatch()
        return "ignore"
      }
      host.feedFsm({ kind: "ctrl-c", at: now })
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
      this.confirmEscape()
      return "ignore"
    }

    if ((code === 10 || code === 13) && !ctrl) {
      if (shift || alt) {
        buf.newline()
        return "changed"
      }
      // bare Enter via kitty
      if (buf.isBlank()) {
        buf.clear()
        return "changed"
      }
      return "submit"
    }

    if (code === 127 && !shift && !alt && !ctrl) {
      return buf.deleteBackward() ? "changed" : "ignore"
    }

    if (code === 9 && !shift && !alt && !ctrl) {
      buf.insert("\t")
      return "changed"
    }

    // Shift+Tab and Ctrl+Shift+Tab: cycle modes. Without a handler wired,
    // we still swallow the keystroke so it doesn't fall through to a
    // printable insertion.
    if (code === 9 && shift && !alt) {
      if (ctrl) {
        host.cycleBackward()
      } else {
        host.cycleForward()
      }
      return "ignore"
    }

    if (alt) {
      if (code === 98) return buf.moveWordLeft() ? "changed" : "ignore"
      if (code === 102) return buf.moveWordRight() ? "changed" : "ignore"
      // Alt+M / Option+M via CSI-u (kitty `\x1b[109;3u`) or xterm
      // modifyOtherKeys=2 (`\x1b[27;3;109~`). Mirrors the bare
      // `\x1bm` branch in `consumeEscape` so the interrupt-and-apply-
      // mode shortcut works regardless of how the terminal encodes
      // meta keys :
      //
      //   - iTerm 3.5+ with kitty proto enabled (the agent's default
      //     after sending `\x1b[>31u` at startup) ships modified
      //     keys as CSI-u. Option+m arrives here as code=109, alt=true.
      //   - iTerm with kitty disabled AND "Option as Meta" enabled
      //     ships `\x1bm` (the legacy meta-prefix path, handled in
      //     `consumeEscape`).
      //   - iTerm with kitty disabled AND Option set to "Normal" ships
      //     the macOS-native `µ` (UTF-8 `\xc2\xb5`). That falls into
      //     the printable-text branch and inserts the character; the
      //     fix on the user side is to enable either kitty proto or
      //     "Option as Meta". Documented in the agent README.
      //
      // Match both lowercase `m` (109) and uppercase `M` (77, via
      // Shift+Alt+m) so the shortcut is forgiving of the shift state.
      // The handler is opt-in via `setModeInterruptHandler`; when
      // unset we still consume the keystroke (return "ignore") so it
      // doesn't fall through to the `text && !ctrl` branch below and
      // insert a literal `m`.
      if (code === 109 || code === 77) {
        host.modeInterrupt()
        return "ignore"
      }
    }

    if (ctrl) {
      switch (code) {
        case 92: // \ - Ctrl+\ toggles show-hidden debug rendering
          host.toggleShowHidden()
          return "changed"
        case 97:
          return buf.moveLineStart() ? "changed" : "ignore"
        // case 99 (Ctrl+C) handled at the top of this method via the
        // abort-quit FSM routing block - never reaches this switch.
        case 100:
          return buf.deleteForward() ? "changed" : "ignore"
        case 101:
          return buf.moveLineEnd() ? "changed" : "ignore"
        case 107:
          return buf.killToLineEnd() ? "changed" : "ignore"
        case 117:
          return buf.killToLineStart() ? "changed" : "ignore"
        case 119:
          return buf.deleteWordBackward() ? "changed" : "ignore"
      }
    }

    if (text && !ctrl) {
      buf.insert(text)
      return "changed"
    }

    if (!shift && !alt && !ctrl && isPrintableCodePoint(code)) {
      buf.insert(String.fromCodePoint(code))
      return "changed"
    }

    return "ignore"
  }

  private consumeBracketedPaste(): "wait" | boolean {
    const idx = this.pending.indexOf(BRACKETED_PASTE_END)
    if (idx !== -1) {
      const pasted = this.pending.slice(0, idx)
      this.pending = this.pending.slice(idx + BRACKETED_PASTE_END.length)
      this.bracketedPaste = false
      return this.insertPasted(pasted)
    }
    const keep = trailingPrefixLength(this.pending, BRACKETED_PASTE_END)
    const pasted = this.pending.slice(0, this.pending.length - keep)
    if (pasted.length === 0) return "wait"
    this.pending = this.pending.slice(pasted.length)
    return this.insertPasted(pasted)
  }

  private insertPasted(text: string): boolean {
    const buf = this.host.buf
    const intercepted = this.host.interceptPaste(text)
    let changed = false
    let run = ""
    const flush = () => {
      if (!run) return
      buf.insert(run)
      run = ""
      changed = true
    }
    for (let i = 0; i < intercepted.length; ) {
      const cp = intercepted.codePointAt(i)
      if (cp === undefined) break
      const ch = String.fromCodePoint(cp)
      i += ch.length
      if (ch === "\r" || ch === "\n") {
        flush()
        if (i < intercepted.length) {
          const next = intercepted[i]
          if ((ch === "\r" && next === "\n") || (ch === "\n" && next === "\r")) {
            i += 1
          }
        }
        buf.newline()
        changed = true
        continue
      }
      if (ch === "\t" || isPrintableChar(ch)) run += ch
    }
    flush()
    return changed
  }
}
