/**
 * Stream-aware stripper for the `<ma::agent::reflection-ack ... />` tag emitted by
 * the model in its assistant text.
 *
 * **Why this exists.** The reflection-ack tag is internal protocol between the
 * agent harness and the model — it tells the agent to silence the next K
 * reflection checkpoints. The agent already parses it from the FULL response
 * (`parseReflectionAck` in `agent.ts`) and surfaces a dim transcript line
 * (`› reflection ack: silencing next K checkpoint — <reason>`). If we ALSO
 * stream the raw XML to scrollback, the user sees both the cryptic tag and
 * the rendered confirmation. The tag should be hidden, the rendered line is
 * the user-visible artifact.
 *
 * **Why not the `<ma::plugin::` inline-tag scanner.** That scanner is namespaced to
 * `<ma::plugin::` openers (see `OPENER_PROBE` in `src/plugins/scanner.ts`) and only
 * matches plugin-contributed tags. The `<ma::` namespace is agent-runtime
 * protocol and intentionally not plugin-handleable — see the project memory
 * note on namespace conventions (#mp2793zz-e02e).
 *
 * **Design.** Wrapping-sink pattern: feed bytes via `write(s)`, receive a
 * cleaned string to emit downstream. Cross-chunk safety via a small tail
 * buffer that holds back any partial-tag prefix until the next chunk
 * completes (or doesn't) the match. End-of-stream is signalled via `flush()`
 * which emits the tail verbatim — partial / malformed tags are NEVER
 * silently dropped (mirrors the fallback policy of the inline-tag scanner).
 *
 * **Blank-line policy.** The tag is typically emitted on its own line with
 * blank lines on either side, e.g. `prose\n\n<tag>\n\nmore`. After stripping
 * just the tag we'd see `prose\n\n\n\nmore` (4 newlines). The compositor's
 * `capBlankLines` then caps consecutive newline runs at 3 = at most 2 blank
 * rows. The model's apparent intent was 1 blank row, so the worst case is
 * one extra blank row of spacing — acceptable polish. We deliberately do
 * NOT consume any surrounding whitespace: doing so safely (preserving
 * `prose\n<tag>\nmore` → `prose\n\nmore` rather than smashing to
 * `prose\nmore`) requires cross-chunk lookback both before and after the
 * tag, and the visual win doesn't justify the state-machine complexity.
 *
 * **Bounded buffer.** If the held tail ever exceeds `MAX_BUFFER` bytes (a
 * model that emits `<ma::agent::reflection-ack` then runs away without closing),
 * the buffered bytes flush verbatim. This bounds worst-case memory and
 * preserves output if the model misbehaves.
 *
 * @module reflection-ack-stripper
 */

/**
 * Matches a complete self-closing reflection-ack tag in either attribute
 * order. Mirrors the parser regex in `agent.ts` (kept duplicated rather
 * than imported so the stripper's intent is locally readable). Trailing
 * whitespace is intentionally NOT consumed; see the blank-line policy
 * note in the module header.
 */
const TAG_RE = /<ma::agent::reflection-ack(?:\s+(?:silence-for="\d+"|reason="[^"]*")){0,2}\s*\/>/g

/** Literal opener prefix used for cross-chunk hold detection. */
const OPENER = "<ma::agent::reflection-ack"

/**
 * Maximum bytes we'll hold in the tail buffer without completing a match
 * before we give up and flush verbatim. 4 KiB comfortably exceeds any
 * realistic tag (`silence-for` is single-digit-ish; `reason` is a short
 * free-form string per the prompt's instruction). If a model emits more,
 * something is wrong and we'd rather show it than swallow it.
 */
const MAX_BUFFER = 4096

/**
 * Public shape of the stripper. Stateful (holds a tail buffer between
 * calls), so callers should create one per logical stream and dispose
 * via `flush()` at end-of-stream to recover any held bytes.
 */
export interface ReflectionAckStripper {
  /**
   * Feed an incoming text chunk. Returns the cleaned bytes ready to emit
   * downstream. The return value may be empty if the entire chunk was
   * either tag bytes or a partial-tag prefix being held.
   */
  write(s: string): string

  /**
   * Signal end-of-stream. Performs one final strip pass on the held tail
   * (in case the trailing bytes completed a tag) and returns whatever
   * remains verbatim. The internal buffer is cleared.
   */
  flush(): string
}

/**
 * Compute the "hold point" within `s`: the index from which bytes might
 * still be growing into a tag and should NOT yet be emitted.
 *
 * Two cases produce a hold:
 *
 * 1. A complete opener `<ma::agent::reflection-ack` appears in `s` but no `/>`
 *    closes it. Hold from the opener position.
 * 2. The tail of `s` is a prefix of the opener (e.g. `<ma::`, `<ma::r`).
 *    Hold from where the prefix begins.
 *
 * Otherwise return `s.length` (nothing to hold).
 */
function findHoldPoint(s: string): number {
  const open = s.lastIndexOf(OPENER)
  if (open !== -1 && s.indexOf("/>", open) === -1) {
    return open
  }
  for (let n = Math.min(OPENER.length - 1, s.length); n >= 1; n--) {
    const tail = s.slice(s.length - n)
    if (OPENER.startsWith(tail)) return s.length - n
  }
  return s.length
}

/**
 * Construct a fresh stripper. Each instance owns its own tail buffer; do
 * not share across logical streams.
 */
export function createReflectionAckStripper(): ReflectionAckStripper {
  let buf = ""

  return {
    write(s: string): string {
      if (s.length === 0) return ""
      buf += s
      // Strip any complete matches first. Note `replace` with the /g flag
      // resets the lastIndex on each call, so re-running on subsequent
      // writes is safe.
      buf = buf.replace(TAG_RE, "")
      let hold = findHoldPoint(buf)
      // Bounded buffer: if the held tail has grown beyond MAX_BUFFER
      // without completing, emit it verbatim and reset. Avoids unbounded
      // memory if the model emits an opener and never closes it.
      if (buf.length - hold > MAX_BUFFER) {
        hold = buf.length
      }
      const out = buf.slice(0, hold)
      buf = buf.slice(hold)
      return out
    },

    flush(): string {
      if (buf.length === 0) return ""
      // One last strip in case the trailing bytes happened to complete a
      // tag (e.g. `... />` arrived just before end-of-stream).
      buf = buf.replace(TAG_RE, "")
      const out = buf
      buf = ""
      return out
    },
  }
}
