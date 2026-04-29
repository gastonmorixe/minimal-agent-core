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
import { EditorBuffer } from "./editor-buffer.ts"
import { EditorRenderer } from "./editor-renderer.ts"
import { truncateDisplayWidth } from "./term-width.ts"

interface CompositorLike {
  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void
  setLiveHeight(n: number): void
  liveHeight: number
  /**
   * Optional. When present, used by {@link EditorController.submit} to
   * commit the just-submitted prompt into the terminal's native scrollback
   * (so users can scroll up to re-read what they typed) before the live
   * area is cleared for the next turn. Compositors without scrollback
   * (e.g. test stubs) can omit it.
   */
  writeStream?(chunk: string): void
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
}

type ParsedKey = {
  code: number
  modifiers: number
  eventType: number
  text: string | null
}

const BRACKETED_PASTE_START = "\x1b[200~"
const BRACKETED_PASTE_END = "\x1b[201~"
const KITTY_KEYBOARD_ENABLE = "\x1b[>31u"
const KITTY_KEYBOARD_DISABLE = "\x1b[<u"
const XTERM_FORMAT_OTHER_KEYS_ENABLE = "\x1b[>4;1f"
const XTERM_FORMAT_OTHER_KEYS_DISABLE = "\x1b[>4f"
const XTERM_MODIFY_OTHER_KEYS_ENABLE = "\x1b[>4;2m"
const XTERM_MODIFY_OTHER_KEYS_DISABLE = "\x1b[>4m"

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
  private started = false
  private cycleForward: (() => void) | null = null
  private cycleBackward: (() => void) | null = null
  private onDataBound = (chunk: string | Buffer): void => {
    this.onData(chunk)
  }

  constructor(opts: EditorControllerOptions) {
    super()
    this.renderer = new EditorRenderer({
      prompt: opts.prompt,
      continuationPrompt: opts.continuationPrompt,
    })
    this.compositor = opts.compositor
    this.stdin = opts.stdin ?? process.stdin
    this.output = opts.output ?? process.stdout
    const cap = opts.maxLiveHeight ?? Number.POSITIVE_INFINITY
    this.maxLiveHeight = typeof cap === "function" ? cap : () => cap
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
   * swallows errors; do not call from normal control flow — use {@link stop}.
   * @internal
   */
  emergencyRestore(): void {
    if (!activeControllers.has(this)) return
    activeControllers.delete(this)
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
   * Show or clear a single status line above the editor prompt. When set,
   * the live area grows by one row so the spinner/status doesn't fight the
   * prompt for screen real estate.
   */
  setStatus(text: string | null): void {
    const next = text == null ? null : text
    if (this.statusLine === next) return
    this.statusLine = next
    this.repaint()
  }

  notifyResize(): void {
    if (this.started) this.repaint()
  }

  private statusLine: string | null = null

  // ----------------------------- internals -----------------------------

  private onData(chunk: string | Buffer): void {
    this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    this.consumePending()
  }

  private consumePending(): void {
    let dirty = false
    while (this.pending.length > 0) {
      if (this.bracketedPaste) {
        const r = this.consumeBracketedPaste()
        if (r === "wait") return
        if (r) dirty = true
        continue
      }

      if (this.pending.startsWith("\x1b")) {
        const handled = this.consumeEscape()
        if (handled === "wait") return
        if (handled === "submit") {
          this.submit()
          return // submit() repaints; stop processing here
        }
        if (handled === "cancel") {
          this.emit("cancel")
          return
        }
        if (handled === "changed") dirty = true
        continue
      }

      const codePoint = this.pending.codePointAt(0)
      if (codePoint === undefined) return
      const char = String.fromCodePoint(codePoint)
      this.pending = this.pending.slice(char.length)

      if (char === "\r" || char === "\n") {
        // Coalesce CRLF / LFCR.
        const other = char === "\r" ? "\n" : "\r"
        if (this.pending.startsWith(other)) {
          this.pending = this.pending.slice(other.length)
        }
        if (this.buf.isBlank()) {
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
        this.submit()
        return
      }
      if (char === "\x03") {
        if (this.buf.isBlank()) {
          this.emit("cancel")
          return
        }
        this.buf.clear()
        dirty = true
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
      if (char === "\t") {
        this.buf.insert(char)
        dirty = true
        continue
      }
      if (this.isPrintable(char)) {
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

  private consumeEscape(): "wait" | "ignore" | "changed" | "submit" | "cancel" {
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
      // insert a literal tab — the user's intent was clearly Shift+Tab).
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
          return this.buf.moveLeft() ? "changed" : "ignore"
        case "\x1b[C":
          return this.buf.moveRight() ? "changed" : "ignore"
        case "\x1b[A":
          return this.buf.moveUp() ? "changed" : "ignore"
        case "\x1b[B":
          return this.buf.moveDown() ? "changed" : "ignore"
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
      default:
        return "ignore"
    }
  }

  private parseModifiedKeySequence(seq: string): "ignore" | "changed" | "submit" | "cancel" | null {
    const key = this.parseCsiUKey(seq) ?? this.parseXtermOtherKey(seq)
    if (!key) return null
    if (key.eventType !== 1) return "ignore"

    const { code, modifiers, text } = key
    const shift = this.hasModifier(modifiers, 0)
    const alt = this.hasModifier(modifiers, 1)
    const ctrl = this.hasModifier(modifiers, 2)

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
    }

    if (ctrl) {
      switch (code) {
        case 97:
          return this.buf.moveLineStart() ? "changed" : "ignore"
        case 99:
          if (this.buf.isBlank()) return "cancel"
          this.buf.clear()
          return "changed"
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
    const text = this.buf.toString()
    // Commit the prompt to scrollback BEFORE clearing the buffer, so the
    // user can scroll up later and re-read what they typed (mirrors what
    // a normal shell does after Enter). We render the FULL buffer here —
    // not the viewport window — so multiline submissions that scrolled
    // internally are preserved in their entirety. writeStream() erases
    // the live area, prints these lines into the natural scroll region,
    // then redraws the live area; clearing the buffer immediately after
    // replaces that redraw with a fresh, empty prompt.
    if (typeof this.compositor.writeStream === "function") {
      const { lines: fullLines } = this.renderer.render(this.buf, {
        firstRow: 0,
        rowCount: this.buf.lines.length,
      })
      if (fullLines.length > 0) {
        this.compositor.writeStream(`${fullLines.join("\n")}\n`)
      }
    }
    this.buf.clear()
    this.viewportTop = 0
    this.repaint()
    this.emit("submit", text)
  }

  private repaint(): void {
    const cols = (this.output as { columns?: number }).columns
    const statusRows = this.statusLine == null ? 0 : 1
    const cap = Math.max(1, this.maxLiveHeight())
    const editorBudget = Math.max(1, cap - statusRows)

    // Window size in **logical** lines. We pick the largest K such that
    // the K logical lines starting at viewportTop wrap to ≤ editorBudget
    // physical rows AND the cursor's logical row is included. Without
    // `cols` (non-TTY tests), we treat each logical line as 1 physical row.
    const totalLogical = this.buf.lines.length

    // Slide viewport so cursor's logical row is in view (logical units).
    if (this.buf.row < this.viewportTop) {
      this.viewportTop = this.buf.row
    }
    // Tentatively grow the window to include the cursor row, then trim
    // from the top until it fits in the physical budget.
    let windowEnd = Math.max(this.buf.row + 1, this.viewportTop + 1)
    if (windowEnd > totalLogical) windowEnd = totalLogical
    let physicalRows = this.measureWindowPhysicalRows(this.viewportTop, windowEnd, cols)
    while (physicalRows > editorBudget && this.viewportTop < this.buf.row) {
      this.viewportTop += 1
      physicalRows = this.measureWindowPhysicalRows(this.viewportTop, windowEnd, cols)
    }
    // Try to extend the window downward to fill remaining budget.
    while (windowEnd < totalLogical) {
      const next = this.measureWindowPhysicalRows(this.viewportTop, windowEnd + 1, cols)
      if (next > editorBudget) break
      windowEnd += 1
      physicalRows = next
    }
    // Try to extend upward too if there's room.
    while (this.viewportTop > 0) {
      const next = this.measureWindowPhysicalRows(this.viewportTop - 1, windowEnd, cols)
      if (next > editorBudget) break
      this.viewportTop -= 1
      physicalRows = next
    }

    const editorWindow = Math.max(1, windowEnd - this.viewportTop)
    const target = physicalRows + statusRows
    if (target !== this.compositor.liveHeight) {
      this.compositor.setLiveHeight(target)
    }
    const { lines, cursor } = this.renderer.render(this.buf, {
      firstRow: this.viewportTop,
      rowCount: editorWindow,
      columns: cols,
    })

    // When the viewport has scrolled down, replace the first editor line with
    // a faint "↑ more" indicator so the user knows content is hidden above.
    if (this.viewportTop > 0 && lines.length > 0) {
      const w = cols ?? 0
      const indicator = w > 10
        ? `\x1b[2m ${"─".repeat(w - 10)} ↑ more\x1b[22m`
        : `\x1b[2m ↑ more\x1b[22m`
      lines[0] = indicator
    }

    const statusLine =
      this.statusLine == null || !cols || cols <= 0
        ? this.statusLine
        : truncateDisplayWidth(this.statusLine, cols)
    const finalLines = statusLine == null ? lines : [statusLine, ...lines]
    const finalCursor = this.statusLine == null ? cursor : { row: cursor.row + 1, col: cursor.col }
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
