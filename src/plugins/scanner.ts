/**
 * Plugin inline-tag stream scanner.
 *
 * Streaming state machine that sits between the SSE text-chunk pipeline and
 * the stdout writer. It watches assistant text for spans of the form
 * `<ma::emit::NAME ...>...</ma::emit::NAME>` (or self-closing
 * `<ma::emit::NAME ... />`) and emits parsed tag events while passing all
 * other text through untouched.
 *
 * **Why stream-aware:** a tag opener can be split across chunk boundaries by
 * the SSE delta granularity. Naively running a regex per chunk would miss
 * cross-chunk matches. The scanner holds a small tail in a buffer so partial
 * prefixes can be completed on the next write.
 *
 * **Fallback policy:** if a capture exceeds `maxSpanBytes` (default 64 KiB)
 * or the stream ends mid-capture, the buffered bytes are flushed verbatim to
 * the text channel. Tags are never silently dropped. This bounds worst-case
 * memory and preserves user output.
 *
 * **Escape form:** the literal sequence `\<ma::emit::` suppresses
 * detection at that position. The backslash is consumed on emit (the text
 * channel sees `<ma::emit::...`). This is the only escape.
 *
 * **Markdown code context:** the scanner tracks inline code spans
 * (single-backtick spans, or any longer backtick run closed by the same run
 * length) and fenced code blocks (lines beginning with 3+ backticks or 3+
 * tildes, closed by a same-char fence of equal-or-greater length at line
 * start). Inside either context, `<ma::emit::` openers are passed through
 * as plain text and no tag event fires. This prevents the model's prose --
 * which often references plugin tag names inside backticks or fenced
 * examples -- from accidentally triggering plugin handlers. Leading-space
 * indent on fence openers is NOT supported (zero-indent only); this covers
 * the realistic agent-emitted markdown but skips obscure CommonMark cases.
 *
 * **Nesting:** the scanner captures until the first `</ma::emit::NAME>`
 * matching the opener name. Nested tags with different names are safe
 * because they do not match the outer close. Nested tags with the same name
 * are ambiguous; the first inner close will end the outer capture. Plugin
 * authors should avoid nesting same-name tags.
 *
 * **Spec:** design note, section "Inline tag trigger path".
 *
 * @module plugins/scanner
 */

/**
 * A parsed inline tag span emitted on `onTag`.
 *
 * The `raw` field carries the original bytes verbatim (opener + body +
 * closer, or just the self-closing opener), so the caller can fall back to
 * writing the raw bytes if no plugin claims the tag.
 */
export interface TagSpan {
  /** Tag name from `<ma::emit::NAME ...>`, lowercased per spec. */
  name: string
  /** Attribute map. Values have escape sequences decoded. */
  attrs: Record<string, string>
  /** Body bytes between opener and closer. Empty for self-closing tags. */
  body: string
  /** True if the tag was self-closing `<ma::emit::NAME ... />`. */
  self_closing: boolean
  /** The original bytes of the full span (opener + body + closer). */
  raw: string
}

/** Scanner constructor options. */
export interface TagScannerOptions {
  /** Receives plain text runs in order. */
  onText: (text: string) => void
  /** Receives a parsed tag span when one is fully assembled. */
  onTag: (span: TagSpan) => void
  /**
   * Maximum total bytes a single span may hold before the scanner falls back
   * to raw-text flushing. Default 64 KiB.
   */
  maxSpanBytes?: number
}

const DEFAULT_MAX_SPAN = 64 * 1024

// The longest prefix that could be the start of `<ma::emit::` — used to
// decide how many bytes to retain in the tail when flushing plain text in
// default state.
const OPENER_PROBE = "<ma::emit::"

/**
 * Streaming scanner. Feed chunks via {@link write}, call {@link end} when the
 * stream finishes. Tag and text events fire synchronously during `write`/`end`.
 *
 * Not safe for concurrent use across threads. One scanner per stream.
 */
export class TagScanner {
  private buf = ""
  private state: "default" | "capturing" = "default"
  private captureName = ""
  // Absolute offset (bytes from the start of the current `buf`) at which the
  // current capture began.
  private captureStart = 0

  // Markdown code-context state. Persists across writes; suppresses inline
  // tag detection while inside inline-code (backtick runs) or fenced-code
  // blocks. See module docstring "Markdown code context".
  private mdInline = 0
  private mdFence: { char: "`" | "~"; len: number } | null = null
  private mdAtLineStart = true

  private readonly onText: (text: string) => void
  private readonly onTag: (span: TagSpan) => void
  private readonly maxSpanBytes: number

  constructor(opts: TagScannerOptions) {
    this.onText = opts.onText
    this.onTag = opts.onTag
    this.maxSpanBytes = opts.maxSpanBytes ?? DEFAULT_MAX_SPAN
  }

  /** Append a chunk and drive the state machine as far as possible. */
  write(chunk: string): void {
    if (!chunk) return
    this.buf += chunk
    this.drive()
  }

  /**
   * Finish the stream. Flushes any pending text and falls back to raw output
   * for any in-progress capture. Idempotent after the first call.
   *
   * **Common cause of unterminated captures:** a mismatched closer. Only
   * `</ma::emit::NAME>` exactly matching the opener name closes a
   * capture. A differently-named closer (e.g. `</thinking>` or
   * `</ma::emit::other>`) is just
   * buffered as more body content, the matching close never arrives, and the
   * span is flushed verbatim here at end-of-stream. This failure is silent
   * from the producer's perspective: the body appears in the user's terminal
   * exactly once (here, in the fallback flush) but no tag event fires, so any
   * plugin side-effect — memory save, diff render, etc. — is skipped.
   */
  end(): void {
    if (this.state === "capturing") {
      // Unterminated capture: flush buffered bytes as raw text.
      if (this.buf.length > 0) {
        this.onText(decodeEscapes(this.buf))
        this.buf = ""
      }
      this.state = "default"
      this.captureName = ""
      this.captureStart = 0
      return
    }
    if (this.buf.length > 0) {
      this.onText(decodeEscapes(this.buf))
      this.buf = ""
    }
  }

  // ---- internal ----------------------------------------------------------

  private drive(): void {
    // Loop until no more progress can be made.
    for (;;) {
      if (this.state === "default") {
        if (!this.driveDefault()) return
      } else {
        if (!this.driveCapturing()) return
      }
    }
  }

  /**
   * Default state: walk `buf` byte-by-byte, tracking markdown code context,
   * and look for an unescaped `<ma::emit::` opener at a position that is
   * not inside an inline or fenced code span.
   *
   * Returns `true` if progress was made (caller should loop), `false` if the
   * scanner is waiting for more data.
   */
  private driveDefault(): boolean {
    const buf = this.buf
    const n = buf.length
    let i = 0

    while (i < n) {
      const ch = buf[i]

      // Newlines reset the line-start flag regardless of code state.
      if (ch === "\n") {
        this.mdAtLineStart = true
        i++
        continue
      }

      // Inside a fenced code block: look only for a closing fence at line
      // start. Everything else is opaque content.
      if (this.mdFence) {
        if (this.mdAtLineStart && ch === this.mdFence.char) {
          const runLen = countRun(buf, i, ch)
          if (i + runLen >= n) {
            // Partial run at end-of-buf; hold and wait for more.
            return this.flushAndHoldAt(i)
          }
          if (runLen >= this.mdFence.len) this.mdFence = null
          i += runLen
          this.mdAtLineStart = false
          continue
        }
        this.mdAtLineStart = false
        i++
        continue
      }

      // Not in fenced code. Detect a fence opener at line start (3+
      // backticks or 3+ tildes, zero-indent only), else fall through to
      // inline-code / opener detection.
      if (this.mdAtLineStart && (ch === "`" || ch === "~")) {
        const runLen = countRun(buf, i, ch)
        if (i + runLen >= n) return this.flushAndHoldAt(i)
        if (runLen >= 3) {
          this.mdFence = { char: ch as "`" | "~", len: runLen }
          this.mdAtLineStart = false
          i += runLen
          continue
        }
        // Backtick run < 3 at line start: inline code toggle.
        if (ch === "`") {
          this.toggleInline(runLen)
          this.mdAtLineStart = false
          i += runLen
          continue
        }
        // Tilde run < 3 at line start: just text.
        this.mdAtLineStart = false
        i += runLen
        continue
      }

      // Backtick (not at line start): inline code toggle.
      if (ch === "`") {
        const runLen = countRun(buf, i, "`")
        if (i + runLen >= n) return this.flushAndHoldAt(i)
        this.toggleInline(runLen)
        this.mdAtLineStart = false
        i += runLen
        continue
      }

      // Inside an inline code span: everything else is opaque content.
      if (this.mdInline > 0) {
        this.mdAtLineStart = false
        i++
        continue
      }

      // Escape form: `\<ma::emit::` suppresses detection. The backslash is
      // collapsed by decodeEscapes on flush.
      if (ch === "\\" && i + 1 + OPENER_PROBE.length <= n && buf.startsWith(OPENER_PROBE, i + 1)) {
        this.mdAtLineStart = false
        i += 1 + OPENER_PROBE.length
        continue
      }

      // Opener candidate at a non-code position.
      if (ch === "<" && buf.startsWith(OPENER_PROBE, i)) {
        // Flush text before the opener, then hand off to opener handling.
        if (i > 0) {
          this.onText(decodeEscapes(buf.slice(0, i)))
          this.buf = buf.slice(i)
        }
        return this.handleOpener()
      }

      this.mdAtLineStart = false
      i++
    }

    // Reached end-of-buf with no opener and no incomplete-run hold. Flush
    // what we can, retaining a short tail for partial-opener-prefix matching
    // (only meaningful when not inside code).
    return this.flushAndHoldAt(n)
  }

  /**
   * Flush `buf[0..upto)` as text, retaining any trailing partial opener
   * prefix (e.g. `... <ma::pl`) so it can be completed by the next chunk.
   * When inside a code context, no opener can fire, so the full prefix is
   * safe to flush.
   */
  private flushAndHoldAt(upto: number): boolean {
    if (upto <= 0) return false
    const head = this.buf.slice(0, upto)
    const tailHold = this.mdInline > 0 || this.mdFence ? 0 : head.length - safeTextEnd(head)
    const flushLen = head.length - tailHold
    if (flushLen > 0) {
      this.onText(decodeEscapes(head.slice(0, flushLen)))
      this.buf = this.buf.slice(flushLen)
    }
    return false
  }

  /** Toggle the inline-code state on a backtick run of length `runLen`. */
  private toggleInline(runLen: number): void {
    if (this.mdInline === 0) this.mdInline = runLen
    else if (runLen === this.mdInline) this.mdInline = 0
    // Else: mismatched run inside an open inline-code span -- just content.
  }

  /**
   * Parse an opener at `buf[0]` and either fire a self-closing event,
   * transition to capturing state, or report incomplete/malformed.
   */
  private handleOpener(): boolean {
    const parsed = parseOpener(this.buf)
    if (parsed === "incomplete") return false
    if (parsed === "malformed") {
      // Not a valid opener. Emit the leading `<` as text, advance, retry.
      this.onText("<")
      this.buf = this.buf.slice(1)
      this.mdAtLineStart = false
      return true
    }

    if (parsed.self_closing) {
      this.onTag({
        name: parsed.name,
        attrs: parsed.attrs,
        body: "",
        self_closing: true,
        raw: this.buf.slice(0, parsed.openerLen),
      })
      this.buf = this.buf.slice(parsed.openerLen)
      this.mdAtLineStart = false
      return true
    }

    // Transition to capturing. Keep opener in buf so `raw` includes it.
    this.state = "capturing"
    this.captureName = parsed.name
    this.captureStart = 0
    this.pendingOpener = parsed
    return true
  }

  private pendingOpener: ParsedOpener | null = null

  /**
   * Capturing state: look for matching `</ma::emit::NAME>`. On find, emit
   * a tag event. On size overflow, fall back to raw text.
   */
  private driveCapturing(): boolean {
    const close = `</ma::emit::${this.captureName}>`
    const closeIdx = this.buf.indexOf(close, this.captureStart)

    if (closeIdx >= 0) {
      const endIdx = closeIdx + close.length
      const raw = this.buf.slice(this.captureStart, endIdx)
      const body = this.buf.slice(
        this.captureStart + (this.pendingOpener?.openerLen ?? 0),
        closeIdx,
      )
      this.onTag({
        name: this.captureName,
        attrs: this.pendingOpener?.attrs ?? {},
        body,
        self_closing: false,
        raw,
      })
      this.buf = this.buf.slice(endIdx)
      this.state = "default"
      this.captureName = ""
      this.captureStart = 0
      this.pendingOpener = null
      return true
    }

    // No close found yet. Size check.
    const spanSize = this.buf.length - this.captureStart
    if (spanSize > this.maxSpanBytes) {
      // Fallback: flush raw bytes to text.
      this.onText(decodeEscapes(this.buf))
      this.buf = ""
      this.state = "default"
      this.captureName = ""
      this.captureStart = 0
      this.pendingOpener = null
      return false
    }

    // Waiting for more data.
    return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count consecutive occurrences of `ch` in `s` starting at `from`. Used by
 * the markdown walker to size backtick / tilde runs in a single step.
 */
function countRun(s: string, from: number, ch: string): number {
  let i = from
  while (i < s.length && s[i] === ch) i++
  return i - from
}

/**
 * Decode the scanner's single escape form: `\<ma::emit::` →
 * `<ma::emit::`. All other characters pass through unchanged. Applied to
 * plain text flushes so the escape is invisible downstream.
 */
function decodeEscapes(s: string): string {
  return s.replace(/\\<ma::emit::/g, "<ma::emit::")
}

/**
 * Return the safe prefix length of `s` in default state: the longest prefix
 * that cannot possibly be the start of an unescaped `<ma::emit::` once
 * more data arrives. Retains a short tail that could still turn into an
 * opener.
 */
function safeTextEnd(s: string): number {
  if (s.length === 0) return 0

  // The largest suffix that could be a prefix of `<ma::emit::` (including
  // the backslash-escape form `\<ma::emit::`) is `OPENER_PROBE.length + 1`
  // characters (12 for the current `<ma::emit::` probe).
  const maxPrefix = OPENER_PROBE.length + 1
  const start = Math.max(0, s.length - maxPrefix)

  for (let i = start; i < s.length; i++) {
    const tail = s.slice(i)
    if (OPENER_PROBE.startsWith(tail)) return i
    if (`\\${OPENER_PROBE}`.startsWith(tail)) return i
  }
  return s.length
}

// ---------------------------------------------------------------------------
// Opener parsing
// ---------------------------------------------------------------------------

interface ParsedOpener {
  name: string
  attrs: Record<string, string>
  self_closing: boolean
  /** Number of bytes the opener occupies at the start of the buffer. */
  openerLen: number
}

type ParseResult = ParsedOpener | "incomplete" | "malformed"

/**
 * Parse `<ma::emit::NAME ... >` or `<ma::emit::NAME ... />` at the
 * start of `s`.
 *
 * Returns:
 * - a parsed opener, or
 * - `"incomplete"` if the opener is not yet fully in the buffer, or
 * - `"malformed"` if the prefix looks like an opener but is not valid
 *   (caller should emit `<` as text and advance one char).
 *
 * Recognizes quoted attribute values (`"..."` and `'...'`) with the minimal
 * escape set `\"`, `\'`, `\\`, `\n`, `\t`. Unknown backslash sequences pass
 * through unchanged.
 */
function parseOpener(s: string): ParseResult {
  if (!s.startsWith(OPENER_PROBE)) return "malformed"
  let i = OPENER_PROBE.length

  // Parse NAME.
  const nameStart = i
  while (i < s.length && isNameChar(s[i])) i++
  if (i === nameStart) {
    // No name yet; either incomplete or truly malformed. We need more data
    // to know which, so wait.
    if (i >= s.length) return "incomplete"
    return "malformed"
  }
  const name = s.slice(nameStart, i)

  // Parse attributes.
  const attrs: Record<string, string> = {}
  for (;;) {
    // Skip whitespace.
    while (i < s.length && isSpace(s[i])) i++
    if (i >= s.length) return "incomplete"

    const c = s[i]
    if (c === ">") {
      return { name, attrs, self_closing: false, openerLen: i + 1 }
    }
    if (c === "/") {
      // Self-closing: expect `/>`.
      if (i + 1 >= s.length) return "incomplete"
      if (s[i + 1] !== ">") return "malformed"
      return { name, attrs, self_closing: true, openerLen: i + 2 }
    }

    // Attribute: KEY=VALUE
    const keyStart = i
    while (i < s.length && isNameChar(s[i])) i++
    if (i === keyStart) return "malformed"
    if (i >= s.length) return "incomplete"
    const key = s.slice(keyStart, i)
    if (s[i] !== "=") return "malformed"
    i++
    if (i >= s.length) return "incomplete"
    const quote = s[i]
    if (quote !== '"' && quote !== "'") return "malformed"
    i++
    // Read quoted value with minimal escapes.
    let value = ""
    while (i < s.length) {
      const ch = s[i]
      if (ch === "\\") {
        if (i + 1 >= s.length) return "incomplete"
        const next = s[i + 1]
        if (next === "n") value += "\n"
        else if (next === "t") value += "\t"
        else if (next === "\\") value += "\\"
        else if (next === '"') value += '"'
        else if (next === "'") value += "'"
        else value += next
        i += 2
        continue
      }
      if (ch === quote) {
        i++
        break
      }
      value += ch
      i++
    }
    if (i > s.length) return "incomplete"
    attrs[key] = value
  }
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r"
}

function isNameChar(c: string): boolean {
  return /[a-zA-Z0-9_-]/.test(c)
}
