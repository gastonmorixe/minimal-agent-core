/**
 * Streaming buffer that holds back any partial CSI / OSC sequence at
 * the end of a chunk so downstream consumers never see a chunk that
 * ends mid-escape.
 *
 * Why this matters: the {@link Compositor} wraps every chunk it
 * receives with its own `\x1b[?25l` / cursor moves / `\x1b[K`
 * sequences. If the caller forwards an incoming chunk that ends with
 * a partial CSI like `\x1b[38;2;180;` and the compositor immediately
 * appends `❯ \x1b[K...`, the terminal's parser glues them together as
 * one malformed escape and prints fragments as literal text.
 *
 * Producers that read from a pipe (`Bun.spawn(..., { stdout: "pipe"
 * })` or a pty master fd) hit arbitrary byte boundaries and can split
 * any escape mid-way. Wrap them in {@link AnsiStreamBuffer} before
 * forwarding to the compositor.
 *
 * Bounded retention: at most {@link MAX_PENDING} bytes are held back.
 * If a producer emits something that *looks* like an unterminated
 * sequence longer than that (e.g. a runaway OSC), we flush it as-is
 * and stop pretending we can recover — better to draw garbage than to
 * stall the stream forever.
 *
 * @module ansi-stream
 */

/** Cap on how much we'll buffer waiting for the next chunk. */
export const MAX_PENDING = 4096

/**
 * Stateful helper. Call {@link push} for every chunk; the returned
 * string is safe to forward. Call {@link flush} on EOF to drain any
 * unterminated tail.
 */
export class AnsiStreamBuffer {
  private pending = ""

  /**
   * Combine `incoming` with any held-back tail, split off the longest
   * complete prefix, and return it. The remainder (a known-incomplete
   * escape sequence) is stashed for the next call.
   */
  push(incoming: string): string {
    if (incoming.length === 0 && this.pending.length === 0) return ""
    const text = this.pending + incoming
    this.pending = ""

    const split = findEscapeSafeSplit(text)
    if (split === text.length) return text
    if (text.length - split > MAX_PENDING) {
      // Unterminated and too long — flush, give up on the dangling
      // partial. Subsequent chunks will start fresh.
      return text
    }
    this.pending = text.slice(split)
    return text.slice(0, split)
  }

  /** Drain on EOF / shutdown. Returns whatever was being held back. */
  flush(): string {
    const out = this.pending
    this.pending = ""
    return out
  }

  /** For tests / introspection. */
  get pendingLength(): number {
    return this.pending.length
  }
}

/**
 * Pure helper: given a string, return the index `i` such that
 * `text.slice(0, i)` is guaranteed not to end mid-escape, and
 * `text.slice(i)` is either empty or starts with `\x1b` and is an
 * incomplete CSI / OSC sequence.
 */
export function findEscapeSafeSplit(text: string): number {
  if (text.length === 0) return 0

  // Walk backward from the end looking for an ESC that has no proper
  // terminator yet. We only need to look back as far as the LAST ESC
  // — anything earlier was already followed by something that closed
  // it (otherwise we would have returned `i` for that earlier ESC on
  // a previous push and never seen the rest of `text` here).
  for (let i = text.length - 1; i >= 0; i--) {
    if (text.charCodeAt(i) !== 0x1b) continue
    const next = text.charCodeAt(i + 1)
    if (Number.isNaN(next)) {
      // ESC at very end → incomplete.
      return i
    }
    if (next === 0x5b /* '[' */) {
      // CSI: terminated by a final byte in 0x40..0x7e.
      let j = i + 2
      while (j < text.length) {
        const c = text.charCodeAt(j)
        if (c >= 0x40 && c <= 0x7e) return text.length // closed
        if (!((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f))) {
          // Malformed mid-CSI byte — terminal will treat the whole
          // thing as garbage; let it through so the user sees what's
          // happening rather than silently swallowing.
          return text.length
        }
        j++
      }
      return i // unterminated
    }
    if (next === 0x5d /* ']' */) {
      // OSC: terminated by BEL or ST (ESC \).
      let j = i + 2
      while (j < text.length) {
        const c = text.charCodeAt(j)
        if (c === 0x07) return text.length
        if (c === 0x1b && text.charCodeAt(j + 1) === 0x5c) return text.length
        j++
      }
      return i // unterminated
    }
    // Any other ESC X form is always 2 bytes once `next` is present —
    // and if we got here, `next` is present, so it's complete.
    return text.length
  }
  // No ESC anywhere → all complete.
  return text.length
}
