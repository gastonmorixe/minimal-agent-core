import { createInterface } from "node:readline"

import {
  codePointWidth,
  cursorRowOffset,
  cursorVisualCol,
  displayWidth,
  wrapRows,
} from "./term-width.ts"

type ReadOutcome = { kind: "continue" } | { kind: "submit"; value: string | null }

type EscapeToken =
  | { kind: "wait" }
  | { kind: "ignore"; consumed: number }
  | { kind: "submit_current"; consumed: number }
  | { kind: "submit"; consumed: number; value: string | null }
  | { kind: "edit"; consumed: number; apply: () => boolean }

type ParsedKey = {
  code: number
  modifiers: number
  eventType: number
  text: string | null
}

export class RawInput {
  private static readonly BRACKETED_PASTE_START = "\x1b[200~"
  private static readonly BRACKETED_PASTE_END = "\x1b[201~"
  private static readonly KITTY_KEYBOARD_ENABLE = "\x1b[>31u"
  private static readonly KITTY_KEYBOARD_DISABLE = "\x1b[<u"
  private static readonly XTERM_FORMAT_OTHER_KEYS_ENABLE = "\x1b[>4;1f"
  private static readonly XTERM_FORMAT_OTHER_KEYS_DISABLE = "\x1b[>4f"
  private static readonly XTERM_MODIFY_OTHER_KEYS_ENABLE = "\x1b[>4;2m"
  private static readonly XTERM_MODIFY_OTHER_KEYS_DISABLE = "\x1b[>4m"
  /**
   * Active read-instances that have an open raw-mode session. Tracked so the
   * process-wide cleanup hooks can restore terminal modes on `exit`,
   * `SIGINT`, `SIGTERM`, or `SIGHUP` even if a parent throws past the normal
   * `cleanup()` path.
   */
  private static readonly activeInstances = new Set<RawInput>()
  private static cleanupHooksInstalled = false

  private static installCleanupHooksOnce(): void {
    if (RawInput.cleanupHooksInstalled) return
    RawInput.cleanupHooksInstalled = true
    const restoreAll = () => {
      for (const inst of RawInput.activeInstances) {
        try {
          inst.emergencyRestore()
        } catch {
          // best-effort
        }
      }
    }
    process.on("exit", restoreAll)
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => {
        restoreAll()
        // Preserve conventional signal-exit semantics.
        process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1))
      })
    }
  }

  private prompt: string
  private continuationPrompt: string
  private promptDisplayWidth: number
  private continuationPromptDisplayWidth: number
  private cycleForward: (() => void) | null = null
  private cycleBackward: (() => void) | null = null
  /**
   * Lifecycle state. The input has three modes:
   *
   * - `"idle"`: no listeners installed; raw mode off (default).
   * - `"ambient"`: persistent stdin ownership; only global shortcuts (mode
   *   cycling, Ctrl+C) are processed. Used in between turns and *while a
   *   turn is streaming* so the user can prepare for the next turn (e.g.
   *   cycle into ASK mode) without waiting for the response to finish.
   * - `"reading"`: full input editing. Set transitionally inside `read()`.
   */
  private active: "idle" | "ambient" | "reading" = "idle"
  /** Shared data listener installed by {@link enable}. Null when idle. */
  private ambientListener: ((chunk: string | Buffer) => void) | null = null
  private lines: string[] = [""]
  private row = 0
  private col = 0
  private pending = ""
  private bracketedPaste = false
  private renderedLineCount = 0
  private renderedCursorRow = 0
  private renderedTotalPhysicalRows = 0
  private stdin: NodeJS.ReadStream = process.stdin
  private output: Pick<NodeJS.WriteStream, "write"> & { columns?: number } = process.stdout

  constructor(prompt: string, continuationPrompt: string) {
    this.prompt = prompt
    this.continuationPrompt = continuationPrompt
    this.promptDisplayWidth = RawInput.visibleLength(prompt)
    this.continuationPromptDisplayWidth = RawInput.visibleLength(continuationPrompt)
  }

  private static visibleLength(text: string): number {
    // Display-width in terminal cells. Strips ANSI, accounts for wide /
    // zero-width code points. See `term-width.ts`.
    return displayWidth(text)
  }

  /**
   * Restore terminal modes if a session is currently active. Idempotent.
   * Wired up by `installCleanupHooksOnce()` so that crashes / signals don't
   * leave the user's terminal in raw + bracketed-paste + Kitty-keyboard
   * mode after the agent dies.
   */
  private emergencyRestore(): void {
    if (!RawInput.activeInstances.has(this)) return
    RawInput.activeInstances.delete(this)
    try {
      this.disableTerminalInputModes()
    } catch {
      // ignore
    }
    try {
      if (this.stdin.isTTY) this.stdin.setRawMode(false)
    } catch {
      // ignore
    }
  }

  /**
   * Update the displayed prompt in place. Safe to call from a key-cycle
   * handler — the next render pass picks up the new prompt automatically.
   *
   * If we're currently inside `read()` and a `render()` already happened,
   * the caller is expected to follow up with `redraw()` so the change is
   * visible immediately.
   */
  setPrompt(prompt: string, continuationPrompt: string): void {
    this.prompt = prompt
    this.continuationPrompt = continuationPrompt
    this.promptDisplayWidth = RawInput.visibleLength(prompt)
    this.continuationPromptDisplayWidth = RawInput.visibleLength(continuationPrompt)
  }

  /**
   * Force a re-render of the current input buffer. Useful after a prompt
   * change to repaint the line with the new prefix.
   */
  redraw(): void {
    if (!this.stdin.isTTY) return
    this.render()
  }

  /**
   * Wire keyboard handlers for cycling app-level state (e.g. modes).
   *
   * - `forward` is invoked on Shift+Tab (CSI-Z legacy, and CSI-u with shift
   *   modifier on tab).
   * - `backward` is invoked on Ctrl+Shift+Tab (CSI-u with ctrl+shift on tab).
   *
   * Pass `null` to detach.
   */
  setModeCycleHandlers(forward: (() => void) | null, backward: (() => void) | null): void {
    this.cycleForward = forward
    this.cycleBackward = backward
  }

  /**
   * Take persistent ownership of stdin in raw mode and start listening for
   * global shortcuts (Shift+Tab cycles modes, Ctrl+C raises SIGINT).
   *
   * Call this once when the REPL starts. While enabled, every keystroke
   * goes through this instance: between turns the editing loop runs, and
   * during streaming the ambient handler runs so the user can change modes
   * mid-stream. Pair with {@link disable} when the REPL exits.
   */
  enable(): void {
    if (this.active !== "idle") return
    if (!this.stdin.isTTY) return // ambient ownership is a TTY-only feature
    this.stdin.setEncoding("utf8")
    this.stdin.resume()
    this.stdin.setRawMode(true)
    this.enableTerminalInputModes()
    RawInput.installCleanupHooksOnce()
    RawInput.activeInstances.add(this)
    this.attachAmbientListener()
    this.active = "ambient"
  }

  /**
   * Release stdin and undo terminal mode changes installed by {@link enable}.
   * No-op if not currently enabled. Safe to call from a `finally`.
   */
  disable(): void {
    if (this.active === "idle") return
    if (this.ambientListener) {
      this.stdin.off("data", this.ambientListener)
      this.ambientListener = null
    }
    if (this.stdin.isTTY) {
      this.disableTerminalInputModes()
      this.stdin.setRawMode(false)
      this.stdin.pause()
    }
    RawInput.activeInstances.delete(this)
    this.active = "idle"
  }

  private attachAmbientListener(): void {
    const listener = (chunk: string | Buffer) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      this.handleAmbient(s)
    }
    this.ambientListener = listener
    this.stdin.on("data", listener)
  }

  /**
   * Process a chunk while in ambient mode. Only global shortcuts trigger;
   * everything else is silently dropped (the user shouldn't be typing
   * substantive input while a turn is streaming).
   */
  private handleAmbient(s: string): void {
    let i = 0
    while (i < s.length) {
      const ch = s[i]
      if (ch === "\x03") {
        // Ctrl+C: forward as SIGINT so `process.on('SIGINT')` (or default
        // termination) handles it as it would in cooked mode.
        process.kill(process.pid, "SIGINT")
        i += 1
        continue
      }
      if (ch === "\x1b" && i + 1 < s.length && s[i + 1] === "[") {
        // Try matching well-known shift+tab sequences in priority order.
        const rest = s.slice(i)
        const legacy = rest.startsWith("\x1b[Z") ? "\x1b[Z" : null
        const csiU = !legacy ? rest.match(/^\x1b\[9;(\d+)u/) : null
        const xterm = !legacy && !csiU ? rest.match(/^\x1b\[27;(\d+);9~/) : null
        if (legacy) {
          if (this.cycleForward) this.cycleForward()
          i += legacy.length
          continue
        }
        if (csiU || xterm) {
          const m = csiU ?? xterm!
          const mods = Number(m[1])
          const shift = ((mods - 1) & 1) !== 0
          const ctrl = ((mods - 1) & 4) !== 0
          if (shift && ctrl && this.cycleBackward) this.cycleBackward()
          else if (shift && this.cycleForward) this.cycleForward()
          i += m[0].length
          continue
        }
        // Unrecognized escape: skip the introducer byte and keep scanning.
        i += 1
        continue
      }
      i += 1
    }
  }

  /**
   * Show the prompt and read input until the user submits.
   * Returns the full text (may contain \n for multiline).
   * Returns null when the read is cancelled, or when non-TTY stdin closes.
   */
  async read(): Promise<string | null> {
    this.resetState()

    if (!this.stdin.isTTY) {
      return this.readFallback()
    }

    // If `enable()` was called we already own stdin in raw mode; just swap
    // the ambient listener for a reading listener and put it back when done.
    const wasAmbient = this.active === "ambient"
    if (wasAmbient) {
      if (this.ambientListener) {
        this.stdin.off("data", this.ambientListener)
        this.ambientListener = null
      }
    } else {
      this.stdin.setEncoding("utf8")
      this.stdin.resume()
      this.stdin.setRawMode(true)
      this.enableTerminalInputModes()
      RawInput.installCleanupHooksOnce()
      RawInput.activeInstances.add(this)
    }
    this.active = "reading"
    this.render()

    return await new Promise<string | null>((resolve, reject) => {
      let settled = false

      const onData = (chunk: string | Buffer) => {
        try {
          this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8")
          const outcome = this.consumePending()
          if (outcome.kind === "submit") {
            finish(outcome.value)
          }
        } catch (error) {
          fail(error)
        }
      }

      const cleanup = () => {
        this.stdin.off("data", onData)
        this.bracketedPaste = false
        if (wasAmbient) {
          this.attachAmbientListener()
          this.active = "ambient"
        } else {
          this.disableTerminalInputModes()
          this.stdin.setRawMode(false)
          this.stdin.pause()
          RawInput.activeInstances.delete(this)
          this.active = "idle"
        }
      }

      const finish = (value: string | null) => {
        if (settled) return
        settled = true
        this.moveCursorToEnd()
        this.output.write("\n")
        cleanup()
        resolve(value)
      }

      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }

      this.stdin.on("data", onData)
    })
  }

  private resetState(): void {
    this.lines = [""]
    this.row = 0
    this.col = 0
    this.pending = ""
    this.bracketedPaste = false
    this.renderedLineCount = 0
    this.renderedCursorRow = 0
    this.renderedTotalPhysicalRows = 0
  }

  private async readFallback(): Promise<string | null> {
    const rl = createInterface({
      input: this.stdin,
      crlfDelay: Infinity,
    })

    return await new Promise<string | null>((resolve) => {
      let settled = false

      rl.once("line", (line) => {
        settled = true
        rl.close()
        resolve(line)
      })

      rl.once("close", () => {
        if (!settled) {
          resolve(null)
        }
      })
    })
  }

  private consumePending(): ReadOutcome {
    while (this.pending.length > 0) {
      if (this.bracketedPaste) {
        const pasted = this.consumeBracketedPaste()
        if (pasted.kind === "wait") {
          return { kind: "continue" }
        }
        if (pasted.changed) {
          this.render()
        }
        continue
      }

      if (this.pending.startsWith("\x1b")) {
        const token = this.parseEscape(this.pending)
        if (token.kind === "wait") {
          return { kind: "continue" }
        }
        this.pending = this.pending.slice(token.consumed)
        if (token.kind === "ignore") {
          continue
        }
        if (token.kind === "submit_current") {
          if (this.isBlankBuffer()) {
            this.clearBuffer()
            this.render()
            continue
          }
          return { kind: "submit", value: this.lines.join("\n") }
        }
        if (token.kind === "submit") {
          return { kind: "submit", value: token.value }
        }
        if (token.apply()) {
          this.render()
        }
        continue
      }

      const codePoint = this.pending.codePointAt(0)
      if (codePoint === undefined) {
        return { kind: "continue" }
      }

      const char = String.fromCodePoint(codePoint)
      this.pending = this.pending.slice(char.length)

      if (char === "\r" || char === "\n") {
        const outcome = this.consumeLineBreak(char)
        if (outcome === "newline") {
          // Paste-style continuation; consumeLineBreak already inserted
          // the newline into the buffer.
          this.render()
          continue
        }
        // Bare LF without a CR partner → Shift+Enter / Ctrl+J → newline.
        // Terminals that distinguish Shift+Enter from Enter typically
        // emit LF for the former (e.g. iTerm2 with a Shift+Return →
        // Send Hex Codes 0x0a key binding). A coalesced CRLF or a bare
        // CR stays a real Enter submit. We honor this BEFORE the empty-
        // buffer no-op so that Shift+Enter on an empty prompt expands to
        // a blank-line newline-insert (matching Alt/Option+Enter, which
        // bypasses isBlank() entirely via the escape parser).
        if (char === "\n" && outcome === "submit") {
          this.insertNewline()
          this.render()
          continue
        }
        // Real Enter (coalesced CRLF or bare CR). On an empty / blank-
        // whitespace buffer this is the standard "press Enter on empty
        // line" no-op: clear any whitespace, don't submit.
        if (this.isBlankBuffer()) {
          this.clearBuffer()
          this.render()
          continue
        }
        return { kind: "submit", value: this.lines.join("\n") }
      }
      if (char === "\x04") {
        if (this.deleteForward()) {
          this.render()
        }
        continue
      }
      if (char === "\x03") {
        return { kind: "submit", value: null }
      }
      if (char === "\x7f") {
        if (this.deleteBackward()) {
          this.render()
        }
        continue
      }
      if (char === "\x01") {
        if (this.moveLineStart()) {
          this.render()
        }
        continue
      }
      if (char === "\x05") {
        if (this.moveLineEnd()) {
          this.render()
        }
        continue
      }
      if (char === "\x0b") {
        if (this.killToLineEnd()) {
          this.render()
        }
        continue
      }
      if (char === "\x15") {
        if (this.killToLineStart()) {
          this.render()
        }
        continue
      }
      if (char === "\x17") {
        if (this.deleteWordBackward()) {
          this.render()
        }
        continue
      }
      if (char === "\t") {
        this.insertText(char)
        this.render()
        continue
      }

      if (this.isPrintable(char)) {
        const rest = this.readPrintableRun(char)
        this.insertText(rest)
        this.render()
      }
    }

    return { kind: "continue" }
  }

  private readPrintableRun(firstChar: string): string {
    const parts = [firstChar]

    while (this.pending.length > 0) {
      if (this.pending.startsWith("\x1b")) break
      const codePoint = this.pending.codePointAt(0)
      if (codePoint === undefined) break
      const char = String.fromCodePoint(codePoint)
      if (!this.isPrintable(char)) break
      parts.push(char)
      this.pending = this.pending.slice(char.length)
    }

    return parts.join("")
  }

  private parseEscape(input: string): EscapeToken {
    if (input.length === 1) {
      return { kind: "wait" }
    }

    if (input[1] === "[") {
      const end = this.findCsiEnd(input)
      if (end === null) {
        return { kind: "wait" }
      }
      const seq = input.slice(0, end + 1)
      if (seq === RawInput.BRACKETED_PASTE_START) {
        return { kind: "edit", consumed: seq.length, apply: () => this.startBracketedPaste() }
      }
      // Legacy back-tab / shift+tab. Most terminals emit ESC[Z. Promote it
      // to a mode-cycle when a forward handler is wired; otherwise ignore.
      if (seq === "\x1b[Z") {
        if (this.cycleForward) {
          return {
            kind: "edit",
            consumed: seq.length,
            apply: () => {
              this.cycleForward!()
              return true
            },
          }
        }
        return { kind: "ignore", consumed: seq.length }
      }
      const modifiedKeyToken = this.parseModifiedKeySequence(seq)
      if (modifiedKeyToken) {
        return modifiedKeyToken
      }
      switch (seq) {
        case "\x1b[3~":
          return { kind: "edit", consumed: seq.length, apply: () => this.deleteForward() }
        case "\x1b[D":
          return { kind: "edit", consumed: seq.length, apply: () => this.moveLeft() }
        case "\x1b[C":
          return { kind: "edit", consumed: seq.length, apply: () => this.moveRight() }
        case "\x1b[A":
          return { kind: "edit", consumed: seq.length, apply: () => this.moveUp() }
        case "\x1b[B":
          return { kind: "edit", consumed: seq.length, apply: () => this.moveDown() }
        case "\x1b[1;3D":
          return { kind: "edit", consumed: seq.length, apply: () => this.moveWordLeft() }
        case "\x1b[1;3C":
          return { kind: "edit", consumed: seq.length, apply: () => this.moveWordRight() }
        case "\x1b[H":
        case "\x1b[1~":
          return { kind: "edit", consumed: seq.length, apply: () => this.moveLineStart() }
        case "\x1b[F":
        case "\x1b[4~":
          return { kind: "edit", consumed: seq.length, apply: () => this.moveLineEnd() }
        default:
          return { kind: "ignore", consumed: seq.length }
      }
    }

    if (input[1] === "O") {
      if (input.length < 3) {
        return { kind: "wait" }
      }
      const seq = input.slice(0, 3)
      switch (seq) {
        case "\x1bOH":
          return { kind: "edit", consumed: seq.length, apply: () => this.moveLineStart() }
        case "\x1bOF":
          return { kind: "edit", consumed: seq.length, apply: () => this.moveLineEnd() }
        default:
          return { kind: "ignore", consumed: seq.length }
      }
    }

    const seq = input.slice(0, 2)
    switch (seq) {
      case "\x1b\r":
      case "\x1b\n":
        return { kind: "edit", consumed: seq.length, apply: () => this.insertNewline() }
      case "\x1bb":
        return { kind: "edit", consumed: seq.length, apply: () => this.moveWordLeft() }
      case "\x1bf":
        return { kind: "edit", consumed: seq.length, apply: () => this.moveWordRight() }
      default:
        return { kind: "ignore", consumed: seq.length }
    }
  }

  private findCsiEnd(input: string): number | null {
    for (let i = 2; i < input.length; i++) {
      const code = input.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) {
        return i
      }
    }
    return null
  }

  private consumeBracketedPaste(): { kind: "wait" } | { kind: "continue"; changed: boolean } {
    const endSeq = RawInput.BRACKETED_PASTE_END
    const endIdx = this.pending.indexOf(endSeq)
    if (endIdx !== -1) {
      const pasted = this.pending.slice(0, endIdx)
      this.pending = this.pending.slice(endIdx + endSeq.length)
      this.bracketedPaste = false
      return { kind: "continue", changed: this.insertPastedText(pasted) }
    }

    const keep = this.trailingPrefixLength(this.pending, endSeq)
    const pasted = this.pending.slice(0, this.pending.length - keep)
    if (pasted.length === 0) {
      return { kind: "wait" }
    }

    this.pending = this.pending.slice(pasted.length)
    return { kind: "continue", changed: this.insertPastedText(pasted) }
  }

  /**
   * Decide whether a freshly-consumed `\r` / `\n` is a real submit or a
   * paste-style newline. Returns `true` for "submit, drain stops here".
   *
   * Rules:
   *   1. Coalesce CRLF / LFCR pairs.
   *   2. Empty pending → real Enter, submit.
   *   3. Trailing data starting with ESC is a key event delivered in the
   *      same chunk (e.g. arrow key right after Enter under load). Treat
   *      the Enter as a real submit and leave the rest in `pending` for
   *      the next read cycle to discard.
   *   4. Otherwise (printable bytes follow) → paste-style multiline,
   *      insert a newline and keep draining.
   *
   * The previous heuristic ("any trailing byte ⇒ newline") could silently
   * eat a real Enter when Node coalesced an arrow key into the same chunk.
   */
  private consumeLineBreak(char: string): "submit" | "submit_coalesced" | "newline" {
    const other = char === "\r" ? "\n" : "\r"
    let coalesced = false
    if (this.pending.startsWith(other)) {
      this.pending = this.pending.slice(other.length)
      coalesced = true
    }

    if (this.pending.length === 0) return coalesced ? "submit_coalesced" : "submit"
    if (this.pending.startsWith("\x1b")) return coalesced ? "submit_coalesced" : "submit"

    this.insertNewline()
    return "newline"
  }

  private startBracketedPaste(): boolean {
    this.bracketedPaste = true
    return false
  }

  private enableTerminalInputModes(): void {
    this.output.write(
      "\x1b[?2004h" +
        RawInput.KITTY_KEYBOARD_ENABLE +
        RawInput.XTERM_FORMAT_OTHER_KEYS_ENABLE +
        RawInput.XTERM_MODIFY_OTHER_KEYS_ENABLE,
    )
  }

  private disableTerminalInputModes(): void {
    this.output.write(
      RawInput.XTERM_MODIFY_OTHER_KEYS_DISABLE +
        RawInput.XTERM_FORMAT_OTHER_KEYS_DISABLE +
        RawInput.KITTY_KEYBOARD_DISABLE +
        "\x1b[?2004l",
    )
  }

  private parseModifiedKeySequence(seq: string): EscapeToken | null {
    const key = this.parseCsiUKey(seq) ?? this.parseXtermOtherKey(seq)
    if (!key) {
      return null
    }

    if (key.eventType !== 1) {
      return { kind: "ignore", consumed: seq.length }
    }

    return this.tokenForModifiedKey(seq.length, key)
  }

  private parseCsiUKey(seq: string): ParsedKey | null {
    if (!seq.endsWith("u")) {
      return null
    }

    const body = seq.slice(2, -1)
    const fields = body.split(";")
    const code = Number(fields[0]?.split(":")[0] ?? "")
    if (!Number.isInteger(code)) {
      return null
    }

    const modifierParts = fields[1]?.split(":") ?? []
    const modifiers = modifierParts[0] ? Number(modifierParts[0]) : 1
    const eventType = modifierParts[1] ? Number(modifierParts[1]) : 1

    if (!Number.isInteger(modifiers) || modifiers < 1) {
      return null
    }
    if (!Number.isInteger(eventType) || eventType < 1) {
      return null
    }

    return {
      code,
      modifiers,
      eventType,
      text: this.parseTextCodePoints(fields[2]),
    }
  }

  private parseXtermOtherKey(seq: string): ParsedKey | null {
    if (!seq.endsWith("~")) {
      return null
    }

    const body = seq.slice(2, -1)
    const fields = body.split(";")
    if (fields.length < 3 || fields[0] !== "27") {
      return null
    }

    const modifiers = Number(fields[1])
    const code = Number(fields[2])
    if (!Number.isInteger(code) || !Number.isInteger(modifiers) || modifiers < 1) {
      return null
    }

    return { code, modifiers, eventType: 1, text: null }
  }

  private tokenForModifiedKey(consumed: number, key: ParsedKey): EscapeToken {
    const { code, modifiers, text } = key
    const shift = this.hasModifier(modifiers, 0)
    const alt = this.hasModifier(modifiers, 1)
    const ctrl = this.hasModifier(modifiers, 2)

    if ((code === 10 || code === 13) && !ctrl) {
      if (shift || alt) {
        return { kind: "edit", consumed, apply: () => this.insertNewline() }
      }
      return { kind: "submit_current", consumed }
    }

    if (code === 127 && !shift && !alt && !ctrl) {
      return { kind: "edit", consumed, apply: () => this.deleteBackward() }
    }

    if (code === 9 && !shift && !alt && !ctrl) {
      return { kind: "edit", consumed, apply: () => this.insertText("\t") }
    }

    // Shift+Tab and Ctrl+Shift+Tab: cycle modes.
    if (code === 9 && shift && !alt) {
      if (ctrl && this.cycleBackward) {
        return {
          kind: "edit",
          consumed,
          apply: () => {
            this.cycleBackward!()
            return true
          },
        }
      }
      if (!ctrl && this.cycleForward) {
        return {
          kind: "edit",
          consumed,
          apply: () => {
            this.cycleForward!()
            return true
          },
        }
      }
      return { kind: "ignore", consumed }
    }

    if (alt) {
      if (code === 98) {
        return { kind: "edit", consumed, apply: () => this.moveWordLeft() }
      }
      if (code === 102) {
        return { kind: "edit", consumed, apply: () => this.moveWordRight() }
      }
    }

    if (ctrl) {
      switch (code) {
        case 97:
          return { kind: "edit", consumed, apply: () => this.moveLineStart() }
        case 99:
          return { kind: "submit", consumed, value: null }
        case 100:
          return { kind: "edit", consumed, apply: () => this.deleteForward() }
        case 101:
          return { kind: "edit", consumed, apply: () => this.moveLineEnd() }
        case 107:
          return { kind: "edit", consumed, apply: () => this.killToLineEnd() }
        case 117:
          return { kind: "edit", consumed, apply: () => this.killToLineStart() }
        case 119:
          return { kind: "edit", consumed, apply: () => this.deleteWordBackward() }
      }
    }

    if (text && !ctrl) {
      return { kind: "edit", consumed, apply: () => this.insertText(text) }
    }

    if (!shift && !alt && !ctrl && this.isPrintableCodePoint(code)) {
      return {
        kind: "edit",
        consumed,
        apply: () => this.insertText(String.fromCodePoint(code)),
      }
    }

    return { kind: "ignore", consumed }
  }

  private hasModifier(modifiers: number, bit: number): boolean {
    return ((modifiers - 1) & (1 << bit)) !== 0
  }

  private isPrintable(char: string): boolean {
    const codePoint = char.codePointAt(0)
    return codePoint !== undefined && codePoint >= 0x20 && char !== "\x7f"
  }

  /**
   * "Blank" means the buffer holds nothing the user typed — exactly one
   * empty logical line. This is intentionally narrower than
   * `lines.join("\n").trim() === ""`: a multi-line buffer made of blank
   * lines is real content the user composed, and pressing Enter on it
   * should submit (or insert another newline), not silently wipe it.
   */
  private isBlankBuffer(): boolean {
    return this.lines.length === 1 && this.lines[0].length === 0
  }

  private insertText(text: string): boolean {
    const [before, after] = this.splitAt(this.lines[this.row], this.col)
    this.lines[this.row] = before + text + after
    this.col += this.charLength(text)
    return true
  }

  private insertNewline(): boolean {
    const [before, after] = this.splitAt(this.lines[this.row], this.col)
    this.lines.splice(this.row, 1, before, after)
    this.row += 1
    this.col = 0
    return true
  }

  private deleteBackward(): boolean {
    if (this.col > 0) {
      this.lines[this.row] = this.removeRange(this.lines[this.row], this.col - 1, this.col)
      this.col -= 1
      return true
    }

    if (this.row === 0) {
      return false
    }

    const previous = this.lines[this.row - 1]
    const current = this.lines[this.row]
    const previousLength = this.charLength(previous)
    this.lines.splice(this.row - 1, 2, previous + current)
    this.row -= 1
    this.col = previousLength
    return true
  }

  private deleteForward(): boolean {
    const line = this.lines[this.row]
    const lineLength = this.charLength(line)

    if (this.col < lineLength) {
      this.lines[this.row] = this.removeRange(line, this.col, this.col + 1)
      return true
    }

    if (this.row >= this.lines.length - 1) {
      return false
    }

    this.lines.splice(this.row, 2, line + this.lines[this.row + 1])
    return true
  }

  private moveLeft(): boolean {
    if (this.col > 0) {
      this.col -= 1
      return true
    }

    if (this.row === 0) {
      return false
    }

    this.row -= 1
    this.col = this.lineLength(this.row)
    return true
  }

  private moveRight(): boolean {
    const lineLength = this.lineLength(this.row)
    if (this.col < lineLength) {
      this.col += 1
      return true
    }

    if (this.row >= this.lines.length - 1) {
      return false
    }

    this.row += 1
    this.col = 0
    return true
  }

  /**
   * Visual position of `(row, col)`: which physical sub-row of the logical
   * line the cursor sits on, and the visual column inside that sub-row
   * (0..cols, where `cols` means "right edge / phantom column").
   */
  private visualPos(row: number, col: number): { physInLine: number; vCol: number } {
    const cols = this.columnsOrDefault()
    const total = this.promptWidth(row) + this.displayWidthBefore(row, col)
    const physInLine = total === 0 ? 0 : Math.floor(Math.max(0, total - 1) / cols)
    return { physInLine, vCol: total - physInLine * cols }
  }

  private physRowsInLine(row: number): number {
    return wrapRows(this.promptWidth(row) + this.lineDisplayWidth(row), this.columnsOrDefault())
  }

  /**
   * Translate a (logical row, physical sub-row, visual column) target back
   * into a code-point cursor column on that line. Used for visual up/down
   * so the cursor lands at "the same visual column" on a wrapped row.
   */
  private colForVisual(row: number, physInLine: number, vCol: number): number {
    const cols = this.columnsOrDefault()
    const promptW = this.promptWidth(row)
    let targetPrefixCells: number
    if (physInLine === 0) {
      targetPrefixCells = Math.max(0, vCol - promptW)
    } else {
      // Row 0 of this logical line consumes (cols - promptW) cells of
      // content; each subsequent wrapped row consumes `cols` cells.
      const consumed = cols - promptW + (physInLine - 1) * cols
      targetPrefixCells = consumed + vCol
    }
    targetPrefixCells = Math.min(targetPrefixCells, this.lineDisplayWidth(row))
    return this.colForDisplayWidth(row, targetPrefixCells)
  }

  /**
   * Up-arrow. Steps one *physical* row at a time so wrapped logical lines
   * navigate naturally. Falls back to the previous logical line when the
   * cursor is already on the first sub-row of its line.
   */
  private moveUp(): boolean {
    const { physInLine, vCol } = this.visualPos(this.row, this.col)
    if (physInLine > 0) {
      this.col = this.colForVisual(this.row, physInLine - 1, vCol)
      return true
    }
    if (this.row === 0) return false
    this.row -= 1
    const lastPhys = this.physRowsInLine(this.row) - 1
    this.col = this.colForVisual(this.row, lastPhys, vCol)
    return true
  }

  /** Down-arrow. Symmetric to {@link moveUp}. */
  private moveDown(): boolean {
    const { physInLine, vCol } = this.visualPos(this.row, this.col)
    const lastPhys = this.physRowsInLine(this.row) - 1
    if (physInLine < lastPhys) {
      this.col = this.colForVisual(this.row, physInLine + 1, vCol)
      return true
    }
    if (this.row >= this.lines.length - 1) return false
    this.row += 1
    this.col = this.colForVisual(this.row, 0, vCol)
    return true
  }

  private moveWordLeft(): boolean {
    const [row, col] = this.scanWordLeft(this.row, this.col)
    if (row === this.row && col === this.col) {
      return false
    }
    this.row = row
    this.col = col
    return true
  }

  private moveWordRight(): boolean {
    const [row, col] = this.scanWordRight(this.row, this.col)
    if (row === this.row && col === this.col) {
      return false
    }
    this.row = row
    this.col = col
    return true
  }

  /**
   * Walk left from (row, col) over one "word", treating line breaks as
   * whitespace. Mirrors {@link EditorBuffer.scanWordLeft} so multi-line
   * word motion / delete behave the same in both code paths.
   */
  private scanWordLeft(row: number, col: number): [number, number] {
    let r = row
    let c = col
    while (true) {
      if (c === 0) {
        if (r === 0) break
        r -= 1
        c = this.lineLength(r)
        continue
      }
      const chars = this.lineChars(r)
      if (!this.isWhitespace(chars[c - 1])) break
      c -= 1
    }
    while (c > 0) {
      const chars = this.lineChars(r)
      if (this.isWhitespace(chars[c - 1])) break
      c -= 1
    }
    return [r, c]
  }

  /**
   * Mirror of {@link scanWordLeft} going forward.
   */
  private scanWordRight(row: number, col: number): [number, number] {
    let r = row
    let c = col
    while (true) {
      const lineLen = this.lineLength(r)
      if (c === lineLen) {
        if (r === this.lines.length - 1) break
        r += 1
        c = 0
        continue
      }
      const chars = this.lineChars(r)
      if (!this.isWhitespace(chars[c])) break
      c += 1
    }
    while (true) {
      const lineLen = this.lineLength(r)
      if (c === lineLen) break
      const chars = this.lineChars(r)
      if (this.isWhitespace(chars[c])) break
      c += 1
    }
    return [r, c]
  }

  private moveLineStart(): boolean {
    if (this.col === 0) {
      return false
    }
    this.col = 0
    return true
  }

  private moveLineEnd(): boolean {
    const nextCol = this.lineLength(this.row)
    if (this.col === nextCol) {
      return false
    }
    this.col = nextCol
    return true
  }

  private killToLineEnd(): boolean {
    const lineLength = this.lineLength(this.row)
    if (this.col < lineLength) {
      this.lines[this.row] = this.sliceChars(this.lines[this.row], 0, this.col)
      return true
    }

    if (this.row >= this.lines.length - 1) {
      return false
    }

    this.lines.splice(this.row, 2, this.lines[this.row] + this.lines[this.row + 1])
    return true
  }

  private killToLineStart(): boolean {
    if (this.col === 0) {
      return false
    }

    this.lines[this.row] = this.sliceChars(this.lines[this.row], this.col)
    this.col = 0
    return true
  }

  private deleteWordBackward(): boolean {
    const endRow = this.row
    const endCol = this.col
    const [startRow, startCol] = this.scanWordLeft(endRow, endCol)
    if (startRow === endRow && startCol === endCol) {
      return false
    }
    if (startRow === endRow) {
      const chars = this.lineChars(endRow)
      this.lines[endRow] = chars.slice(0, startCol).join("") + chars.slice(endCol).join("")
    } else {
      const startChars = this.lineChars(startRow)
      const endChars = this.lineChars(endRow)
      const merged = startChars.slice(0, startCol).join("") + endChars.slice(endCol).join("")
      this.lines.splice(startRow, endRow - startRow + 1, merged)
    }
    this.row = startRow
    this.col = startCol
    return true
  }

  private clearBuffer(): void {
    this.lines = [""]
    this.row = 0
    this.col = 0
  }

  private insertPastedText(text: string): boolean {
    let changed = false
    let run = ""

    const flushRun = () => {
      if (!run) {
        return
      }
      this.insertText(run)
      run = ""
      changed = true
    }

    for (let i = 0; i < text.length; ) {
      const codePoint = text.codePointAt(i)
      if (codePoint === undefined) {
        break
      }

      const char = String.fromCodePoint(codePoint)
      i += char.length

      if (char === "\r" || char === "\n") {
        flushRun()
        if (i < text.length) {
          const next = text[i]
          if ((char === "\r" && next === "\n") || (char === "\n" && next === "\r")) {
            i += 1
          }
        }
        this.insertNewline()
        changed = true
        continue
      }

      if (char === "\t" || this.isPrintable(char)) {
        run += char
      }
    }

    flushRun()
    return changed
  }

  private columnsOrDefault(): number {
    return this.output.columns || 80
  }

  private lineDisplayWidth(row: number): number {
    return displayWidth(this.lines[row])
  }

  /**
   * Display width (in cells) of `lines[row]` from code-point index 0 up to
   * (but not including) `endCol`. Used to translate the logical cursor
   * column into a visual column.
   */
  private displayWidthBefore(row: number, endCol: number): number {
    const chars = this.lineChars(row)
    const slice = chars.slice(0, endCol).join("")
    return displayWidth(slice)
  }

  /**
   * Inverse of `displayWidthBefore`: given a target display-width offset,
   * return the largest code-point column index whose cumulative width
   * does not exceed `targetCells`. Used for visual up/down so the cursor
   * lands at "the same visual column" on a wrapped row.
   */
  private colForDisplayWidth(row: number, targetCells: number): number {
    const chars = this.lineChars(row)
    let acc = 0
    for (let i = 0; i < chars.length; i++) {
      const cp = chars[i].codePointAt(0) ?? 0
      const cw = codePointWidth(cp)
      if (acc + cw > targetCells) return i
      acc += cw
    }
    return chars.length
  }

  /** Physical row offset (0-based) of the *start* of logical line `row`. */
  private physicalRowStartOf(row: number): number {
    const cols = this.columnsOrDefault()
    let r = 0
    for (let i = 0; i < row; i++) {
      r += wrapRows(this.promptWidth(i) + this.lineDisplayWidth(i), cols)
    }
    return r
  }

  private getPhysicalRows(row: number, col: number): number {
    const cols = this.columnsOrDefault()
    return (
      this.physicalRowStartOf(row) +
      cursorRowOffset(this.promptWidth(row), this.displayWidthBefore(row, col), cols)
    )
  }

  private getTotalPhysicalRows(): number {
    const cols = this.columnsOrDefault()
    let total = 0
    for (let i = 0; i < this.lines.length; i++) {
      total += wrapRows(this.promptWidth(i) + this.lineDisplayWidth(i), cols)
    }
    return total
  }

  /**
   * Repaint the prompt + buffer in place.
   *
   * Strategy: move the cursor to the very top-left of the previously
   * rendered frame, clear from there to end-of-screen, then draw the new
   * frame from scratch. This guarantees no stale rows ever survive a
   * shrink (delete / kill / clear) regardless of whether the terminal's
   * actual wrap matched our prediction during the previous render.
   */
  private render(): void {
    const parts: string[] = []
    const cols = this.columnsOrDefault()

    if (this.renderedLineCount > 0) {
      // Move up to the first physical row of the previous frame.
      if (this.renderedCursorRow > 0) {
        parts.push(`\x1b[${this.renderedCursorRow}A`)
      }
      // Carriage return + clear-to-end-of-screen wipes the entire previous
      // frame, including any rows the terminal wrapped past our prediction.
      parts.push("\r\x1b[J")
    }

    for (let i = 0; i < this.lines.length; i++) {
      parts.push(i === 0 ? this.prompt : this.continuationPrompt)
      parts.push(this.lines[i])
      if (i < this.lines.length - 1) {
        parts.push("\r\n")
      }
    }

    const currentPhysicalRow = this.getPhysicalRows(this.row, this.col)
    const totalPhysicalRows = this.getTotalPhysicalRows()
    const rowsUp = totalPhysicalRows - 1 - currentPhysicalRow
    if (rowsUp > 0) parts.push(`\x1b[${rowsUp}A`)
    parts.push("\r")

    const visualCol = cursorVisualCol(
      this.promptWidth(this.row),
      this.displayWidthBefore(this.row, this.col),
      cols,
    )
    // Position cursor at visualCol (1-based for CUF; 0 means "stay at col 0").
    if (visualCol > 0) parts.push(`\x1b[${visualCol}C`)

    this.output.write(parts.join(""))
    this.renderedLineCount = this.lines.length
    this.renderedCursorRow = currentPhysicalRow
    this.renderedTotalPhysicalRows = totalPhysicalRows
  }

  private moveCursorToEnd(): void {
    const totalPhysicalRows = this.getTotalPhysicalRows()
    const rowsDown = totalPhysicalRows - 1 - this.renderedCursorRow
    const parts: string[] = []

    if (rowsDown > 0) parts.push(`\x1b[${rowsDown}B`)
    parts.push("\r")

    const cols = this.columnsOrDefault()
    const lastRow = this.lines.length - 1
    const visualCol = cursorVisualCol(
      this.promptWidth(lastRow),
      this.lineDisplayWidth(lastRow),
      cols,
    )
    if (visualCol > 0) parts.push(`\x1b[${visualCol}C`)

    this.output.write(parts.join(""))
    this.renderedCursorRow = totalPhysicalRows - 1
  }

  private promptWidth(row: number): number {
    return row === 0 ? this.promptDisplayWidth : this.continuationPromptDisplayWidth
  }

  private lineLength(row: number): number {
    return this.charLength(this.lines[row])
  }

  private lineChars(row: number): string[] {
    return Array.from(this.lines[row])
  }

  private charLength(text: string): number {
    return Array.from(text).length
  }

  private splitAt(text: string, index: number): [string, string] {
    const chars = Array.from(text)
    return [chars.slice(0, index).join(""), chars.slice(index).join("")]
  }

  private sliceChars(text: string, start: number, end?: number): string {
    return Array.from(text).slice(start, end).join("")
  }

  private removeRange(text: string, start: number, end: number): string {
    const chars = Array.from(text)
    return chars.slice(0, start).join("") + chars.slice(end).join("")
  }

  private trailingPrefixLength(text: string, pattern: string): number {
    const max = Math.min(text.length, pattern.length - 1)
    for (let len = max; len > 0; len--) {
      if (text.endsWith(pattern.slice(0, len))) {
        return len
      }
    }
    return 0
  }

  private isWhitespace(char: string): boolean {
    return /\s/u.test(char)
  }

  private parseTextCodePoints(field?: string): string | null {
    if (!field) {
      return null
    }

    const codePoints: number[] = []
    for (const part of field.split(":")) {
      const value = Number(part)
      if (!Number.isInteger(value) || value < 0) {
        return null
      }
      codePoints.push(value)
    }

    return codePoints.length > 0 ? String.fromCodePoint(...codePoints) : null
  }

  private isPrintableCodePoint(codePoint: number): boolean {
    return codePoint >= 0x20 && codePoint !== 0x7f
  }
}
