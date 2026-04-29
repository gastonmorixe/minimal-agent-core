/**
 * TUI inline-tag stream scanner.
 *
 * Streaming state machine that sits between the SSE text-chunk pipeline and
 * the stdout writer. It watches assistant text for spans of the form
 * `<tui::NAME ...>...</tui::NAME>` (or self-closing `<tui::NAME ... />`) and
 * emits parsed tag events while passing all other text through untouched.
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
 * **Escape form:** the literal sequence `\<tui::` suppresses detection at
 * that position. The backslash is consumed on emit (the text channel sees
 * `<tui::...`). This is the only escape.
 *
 * **Nesting:** the scanner captures until the first `</tui::NAME>` matching
 * the opener name. Nested tags with different names are safe because they do
 * not match the outer close. Nested tags with the same name are ambiguous;
 * the first inner close will end the outer capture. Plugin authors should
 * avoid nesting same-name tags.
 *
 * **Spec:** `/Users/gaston/.claude/plans/polished-drifting-dijkstra.md`,
 * section "Inline tag trigger path".
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
  /** Tag name from `<tui::NAME ...>`, lowercased per spec. */
  name: string
  /** Attribute map. Values have escape sequences decoded. */
  attrs: Record<string, string>
  /** Body bytes between opener and closer. Empty for self-closing tags. */
  body: string
  /** True if the tag was self-closing `<tui::NAME ... />`. */
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

// The longest prefix that could be the start of `<tui::` — used to decide how
// many bytes to retain in the tail when flushing plain text in default state.
const OPENER_PROBE = "<tui::"

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
   * Default state: look for the next unescaped `<tui::`, flush text before
   * it, and try to parse an opener.
   *
   * Returns `true` if progress was made (caller should loop), `false` if the
   * scanner is waiting for more data.
   */
  private driveDefault(): boolean {
    const idx = findUnescapedOpener(this.buf)

    if (idx < 0) {
      // No opener in sight. Flush everything except a short tail that might
      // be the start of an opener (e.g. `... <tu` at end of chunk).
      const safe = safeTextEnd(this.buf)
      if (safe > 0) {
        this.onText(decodeEscapes(this.buf.slice(0, safe)))
        this.buf = this.buf.slice(safe)
      }
      return false
    }

    // Flush any plain text before the opener.
    if (idx > 0) {
      this.onText(decodeEscapes(this.buf.slice(0, idx)))
      this.buf = this.buf.slice(idx)
    }

    // Try to parse an opener at buf[0].
    const parsed = parseOpener(this.buf)
    if (parsed === "incomplete") {
      // Need more bytes.
      return false
    }
    if (parsed === "malformed") {
      // Not a valid opener. Emit the leading `<` as text, advance, retry.
      this.onText("<")
      this.buf = this.buf.slice(1)
      return true
    }

    if (parsed.self_closing) {
      // Atomic self-closing tag.
      this.onTag({
        name: parsed.name,
        attrs: parsed.attrs,
        body: "",
        self_closing: true,
        raw: this.buf.slice(0, parsed.openerLen),
      })
      this.buf = this.buf.slice(parsed.openerLen)
      return true
    }

    // Transition to capturing. Keep opener in buf so `raw` includes it.
    this.state = "capturing"
    this.captureName = parsed.name
    this.captureStart = 0
    // Stash parsed opener metadata in a side field so the closing step
    // doesn't re-parse.
    this.pendingOpener = parsed
    return true
  }

  private pendingOpener: ParsedOpener | null = null

  /**
   * Capturing state: look for matching `</tui::NAME>`. On find, emit a tag
   * event. On size overflow, fall back to raw text.
   */
  private driveCapturing(): boolean {
    const close = `</tui::${this.captureName}>`
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
 * Find the first unescaped `<tui::` in `s`, or -1 if none. A preceding
 * backslash suppresses detection; the escape is consumed by {@link decodeEscapes}
 * when the surrounding text is flushed.
 */
function findUnescapedOpener(s: string): number {
  let from = 0
  for (;;) {
    const i = s.indexOf(OPENER_PROBE, from)
    if (i < 0) return -1
    if (i > 0 && s[i - 1] === "\\") {
      from = i + OPENER_PROBE.length
      continue
    }
    return i
  }
}

/**
 * Decode the scanner's single escape form: `\<tui::` → `<tui::`. All other
 * characters pass through unchanged. Applied to plain text flushes so the
 * escape is invisible downstream.
 */
function decodeEscapes(s: string): string {
  return s.replace(/\\<tui::/g, "<tui::")
}

/**
 * Return the safe prefix length of `s` in default state: the longest prefix
 * that cannot possibly be the start of an unescaped `<tui::` once more data
 * arrives. Retains a short tail that could still turn into an opener.
 */
function safeTextEnd(s: string): number {
  if (s.length === 0) return 0

  // The largest suffix that could be a prefix of `<tui::` (including the
  // backslash-escape form `\<tui::`) is 7 characters: `\<tui::`.
  const maxPrefix = 7
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
 * Parse `<tui::NAME ... >` or `<tui::NAME ... />` at the start of `s`.
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
