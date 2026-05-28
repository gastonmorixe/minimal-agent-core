/**
 * Recall state machine for ↑/↓ history navigation.
 *
 * The host (`editor.key` hook) calls `up()` / `down()` / `noteEdit()` /
 * `noteSubmit()`. The recall returns either:
 *
 *  - `{halt: false}`           — pass through to default buffer nav
 *  - `{halt: true, buffer}`    — replace the editor buffer
 *  - `{halt: true, buffer: ""}`— restore an empty draft (overshoot)
 *
 * ## Mental model
 *
 * Three logical states:
 *
 *  - **IDLE**: cursor is composing a NEW prompt. `pos = -1`. No draft
 *    snapshot held.
 *  - **BROWSING**: the user pressed ↑ at least once; the buffer
 *    currently shows entry `entries[pos]`. We have a `draftSnapshot`
 *    of whatever the user had typed before they started browsing
 *    (typically `""`).
 *  - **EDITED**: same as BROWSING but the user edited the recalled
 *    text. `pos` is "frozen" — further ↑/↓ does NOT walk history
 *    until the user re-empties the buffer. This is readline's
 *    behavior (and what GNU bash / zsh / fish all do).
 *
 * State is encoded implicitly by `pos`, `draftSnapshot`, and an
 * `bufferAtRecall` checksum so we don't need an enum:
 *
 *  - `pos === -1`                   → IDLE
 *  - `pos >= 0  && cur === recall`  → BROWSING
 *  - `pos >= 0  && cur !== recall`  → EDITED (frozen — ↑/↓ pass through)
 *
 * Where `cur` is the live buffer text the host passes in on each call
 * and `recall` is the text we put there last time. Comparison is a
 * simple `===` — that's enough to detect any edit (insert, delete,
 * paste, whatever the user did to the recalled string).
 *
 * @module plugins/history/lib/recall
 */

export interface RecallResult {
  /** True when the recall consumed the key. Editor skips default handling. */
  halt: boolean
  /** Text to put in the editor buffer. Only set when `halt` is true. */
  buffer?: string
}

/**
 * Build a recall instance backed by an in-memory snapshot of history
 * entries. `entries` is taken oldest-first (matches `loadEntries`).
 *
 * The recall is stateful — construct ONE per editor session. It owns
 * `pos`, the draft snapshot, and the bufferAtRecall checksum.
 */
export interface Recall {
  /** Try to walk one entry older. Returns `{halt: false}` when at the head. */
  up(currentBuffer: string): RecallResult
  /**
   * Try to walk one entry newer. On overshoot past the most-recent
   * entry, returns `{halt: true, buffer: <draftSnapshot>}` to restore
   * the user's pre-recall draft and resets to IDLE.
   */
  down(currentBuffer: string): RecallResult
  /**
   * Called when a new submitted entry lands in the store (so the
   * recall picks it up on the next ↑). The new entry is appended and
   * the cursor returns to IDLE.
   */
  push(text: string): void
  /**
   * Called when the user fully resets the buffer (after a submit, or
   * Ctrl+U-on-empty). Equivalent to "the next ↑ should start from the
   * newest entry again".
   */
  resetCursor(): void
  /**
   * Current cursor position. -1 = IDLE; otherwise 0..entries.length-1
   * pointing at the entry currently displayed.
   *
   * @internal — primarily for tests.
   */
  cursor(): number
  /**
   * Total entries known to the recall (post any `push`). Tests use
   * this to assert ingestion of new submits.
   *
   * @internal
   */
  size(): number
}

/**
 * Construct a {@link Recall}. `entries` may be empty.
 *
 * The texts are extracted up-front and frozen — subsequent changes to
 * the source array don't affect the recall. Push new entries via
 * `push()`.
 */
export function createRecall(entries: ReadonlyArray<{ text: string }>): Recall {
  // We store just the texts (oldest-first) to keep the hot path simple.
  // `up()` walks index downward (toward 0 = oldest); `down()` walks
  // upward (toward last = newest).
  const items: string[] = entries.map((e) => e.text)
  let pos = -1
  let draftSnapshot = ""
  /**
   * The text we last wrote into the editor buffer (the last `up`/`down`
   * return value's `buffer` field). When the host calls `up`/`down`
   * with a `currentBuffer` that doesn't match this, the user has been
   * editing the recalled text — we transition to EDITED and pass
   * through future arrow keys until they reset (empty buffer or submit).
   */
  let bufferAtRecall: string | null = null

  function inEditedState(currentBuffer: string): boolean {
    return bufferAtRecall !== null && currentBuffer !== bufferAtRecall
  }

  return {
    up(currentBuffer: string): RecallResult {
      if (items.length === 0) return { halt: false }
      if (inEditedState(currentBuffer)) return { halt: false }
      // First ↑ — snapshot the user's draft so a later overshoot can
      // restore it. We only capture the snapshot ONCE per browsing
      // session; subsequent ↑ keystrokes don't overwrite it.
      if (pos === -1) {
        draftSnapshot = currentBuffer
        pos = items.length // sentinel one past newest
      }
      if (pos <= 0) {
        // Already on the oldest entry — no-op (don't pass through; user
        // pressed ↑ expecting recall to do something, and we already
        // gave them the oldest).
        return { halt: true, buffer: items[0] }
      }
      pos -= 1
      const text = items[pos]
      bufferAtRecall = text
      return { halt: true, buffer: text }
    },

    down(currentBuffer: string): RecallResult {
      if (pos === -1) return { halt: false } // not browsing — pass through
      if (inEditedState(currentBuffer)) return { halt: false }
      if (pos >= items.length - 1) {
        // Overshoot past the newest entry — restore the user's draft
        // and return to IDLE. Halt the key (do NOT pass through to
        // default buffer nav, which would move the cursor inside the
        // recalled text — surprising UX).
        const draft = draftSnapshot
        pos = -1
        draftSnapshot = ""
        bufferAtRecall = null
        return { halt: true, buffer: draft }
      }
      pos += 1
      const text = items[pos]
      bufferAtRecall = text
      return { halt: true, buffer: text }
    },

    push(text: string): void {
      // Skip empty / pure-whitespace text. Same rule as the host's
      // `onSubmit` guard — the recall and the store agree on what
      // counts as a "real" submission.
      if (text.trim().length === 0) return
      // Dedupe: same as last entry → drop. Matches readline's
      // `HISTCONTROL=ignoredups`. We keep this on by default since
      // most "press up, fix typo, submit" interactions otherwise
      // pollute history with adjacent near-dups.
      if (items.length > 0 && items[items.length - 1] === text) {
        // Still reset cursor on submit even when we don't append —
        // semantics should be identical for the user.
        pos = -1
        draftSnapshot = ""
        bufferAtRecall = null
        return
      }
      items.push(text)
      pos = -1
      draftSnapshot = ""
      bufferAtRecall = null
    },

    resetCursor(): void {
      pos = -1
      draftSnapshot = ""
      bufferAtRecall = null
    },

    cursor(): number {
      return pos
    },

    size(): number {
      return items.length
    },
  }
}
