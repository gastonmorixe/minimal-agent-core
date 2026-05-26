/**
 * InputCaptureStack — LIFO transient input captures, sits in FRONT of
 * the priority-based `editor.key` hook chain.
 *
 * Why this exists (and why it's not the hook chain)
 * ------------------------------------------------
 * The `editor.key` hook chain is the right shape for **durable**
 * subscribers: plugins whose lifetime spans the session and whose
 * relative ordering can be declared once at registration via a static
 * `priority`. History recall, slash-menu, autocomplete: that's the
 * chain's job.
 *
 * Some captures don't fit:
 *
 *  - The reflection cooldown opens for ~60s mid-turn, then closes. It
 *    isn't a plugin; it has no manifest entry; it has no stable
 *    priority relative to whatever plugins happen to be loaded. It
 *    just wants to say "while I'm visible, Esc means ME, not abort".
 *  - A future confirm modal ("save changes? [y/N]") is the same shape:
 *    transient, no manifest, "Esc means me first".
 *  - Two overlays may be open at once. The one that opened LAST should
 *    close FIRST. A priority chain can't express "most recently
 *    pushed" without ad-hoc fiddling.
 *
 * The stack is the smallest abstraction that gets all three right:
 * push when the overlay activates, pop when it dismisses (or when the
 * disposer returned from `push` is called), top-of-stack claims the
 * key first.
 *
 * Dispatch order (the {@link EditorController} two-layer pipeline)
 * ---------------------------------------------------------------
 *
 *   ESC byte
 *     │
 *     ▼
 *   InputCaptureStack.dispatch     ← LIFO, transient (this file)
 *     │ no one claimed
 *     ▼
 *   editor.key hook chain          ← priority, durable (plugins)
 *     │ no one halted
 *     ▼
 *   abort-quit FSM                 ← only place that aborts the turn
 *
 * The two-layer split keeps the existing plugin contract untouched
 * while giving agent-side / host-side overlays a place to live.
 *
 * Safety contract
 * ---------------
 *  - **Single source of truth**: a module-level {@link inputCaptureStack}
 *    singleton is shared by `EditorController` (consumer) and any
 *    push-side caller (reflection cooldown, future confirm modals,
 *    plugins that opt in). Tests can construct a fresh
 *    {@link InputCaptureStack} and inject it explicitly.
 *  - **Out-of-order release is safe**: removing a capture from the
 *    middle of the stack does not disturb the others. This is needed
 *    when, say, the slash-menu was below the reflection cooldown but
 *    the user pressed Enter on the menu (closing it) before the
 *    cooldown elapsed.
 *  - **Handler errors are absorbed**: a throwing handler is logged
 *    (best-effort) and treated as "did not claim", so a buggy capture
 *    cannot trap subsequent ones or wedge the dispatch loop.
 *  - **Idempotent disposers**: calling the returned dispose twice is a
 *    no-op the second time.
 *  - **The escape hatch is untouched**: rapid double-Ctrl+C
 *    (`EscapeHatch`, abort-quit spec rule 5) bypasses both the stack
 *    AND the FSM, so a wedged capture can never trap the user.
 *
 * When to push onto this vs. register an `editor.key` hook
 * --------------------------------------------------------
 *
 *  | Concern                          | Push to stack | `editor.key` hook |
 *  |----------------------------------|---------------|-------------------|
 *  | Lifetime spans session           |               | ✔                 |
 *  | Lifetime is transient (one open) | ✔             |                   |
 *  | Owns "ESC means me first"        | ✔             |                   |
 *  | Wants priority relative to peers |               | ✔                 |
 *  | Lives in a plugin manifest       |               | ✔                 |
 *  | Lives in agent loop / host code  | ✔             |                   |
 *  | LIFO "last opened, first closed" | ✔             |                   |
 *
 * If both apply (a plugin whose overlay needs LIFO precedence over
 * other plugins), the plugin can do both: keep its declarative hook
 * for non-overlay keys, AND push onto the stack while its overlay is
 * open. The two layers compose; neither blocks the other.
 *
 * @module input-capture-stack
 */

/**
 * Opaque-ish identifier for a capture. Used for diagnostics and for
 * {@link InputCaptureStack.has} checks. NOT required to be unique: two
 * captures with the same id are tracked independently (push twice =
 * two entries on the stack).
 */
export type CaptureId = string

/**
 * The handler a caller registers on push. Receives the canonical key
 * name (same alphabet as `editor.key`: "Escape", "Enter", "Tab",
 * "ArrowUp", "ArrowDown", "Ctrl+R", …) and returns `true` if it
 * consumed the keystroke (the stack stops walking, the editor stops
 * default handling). Returns `false` (or any falsy) to let propagation
 * continue down to the next capture, then the hook chain, then the
 * FSM.
 *
 * Async handlers are not supported: the editor's keystroke pump is
 * synchronous and the decision to halt must be made inline. If you
 * need to kick off async work on the captured key, do it from the
 * handler body (fire-and-forget) and return `true` synchronously.
 */
export type CaptureHandler = (key: string) => boolean

/**
 * Disposer returned from {@link InputCaptureStack.push}. Idempotent:
 * calling it twice removes the entry the first time and is a no-op
 * the second time. Safe to call from any context (including from
 * inside the handler that's about to claim the key).
 */
export type CaptureDisposer = () => void

interface Entry {
  readonly id: CaptureId
  readonly handler: CaptureHandler
  /** Monotone sequence number; ties the entry to a specific push call. */
  readonly seq: number
}

/**
 * LIFO input capture stack. See module docstring for the design
 * rationale and the two-layer dispatch pipeline.
 */
export class InputCaptureStack {
  private entries: Entry[] = []
  private seqCounter = 0

  /**
   * Push a capture onto the top of the stack. Returns a disposer that
   * removes THIS capture (matched by sequence number, not by id, so
   * duplicate ids behave correctly).
   *
   * The handler runs synchronously on every dispatched key while it
   * remains on the stack. It is invoked top-down: if your push lands
   * at the top, you get the next dispatched key first.
   */
  push(id: CaptureId, handler: CaptureHandler): CaptureDisposer {
    const entry: Entry = { id, handler, seq: ++this.seqCounter }
    this.entries.push(entry)
    let released = false
    return () => {
      if (released) return
      released = true
      this.entries = this.entries.filter((e) => e.seq !== entry.seq)
    }
  }

  /**
   * Walk the stack top-down; the first handler to return truthy claims
   * the key (returns `true` from `dispatch`). Walks ALL entries if
   * nobody claims (returns `false`). A throwing handler is treated as
   * "did not claim" (logged best-effort, propagation continues).
   *
   * The handler set is snapshotted at entry so that releases happening
   * during dispatch (e.g. a handler calls its own disposer and then
   * returns true) don't perturb the walk for the current dispatch.
   */
  dispatch(key: string): boolean {
    if (this.entries.length === 0) return false
    const snapshot = this.entries.slice()
    for (let i = snapshot.length - 1; i >= 0; i--) {
      const entry = snapshot[i]
      if (!entry) continue
      let claimed = false
      try {
        claimed = entry.handler(key) === true
      } catch (e) {
        process.stderr.write(
          `[input-capture-stack] capture "${entry.id}" threw on key "${key}": ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        )
        claimed = false
      }
      if (claimed) return true
    }
    return false
  }

  /** Current stack depth. Useful for tests and diagnostics. */
  depth(): number {
    return this.entries.length
  }

  /** `true` iff any entry on the stack has this id. */
  has(id: CaptureId): boolean {
    return this.entries.some((e) => e.id === id)
  }

  /**
   * Id at the top of the stack, or `null` if the stack is empty. Used
   * by diagnostics; do NOT branch dispatch on this — the handler's
   * `(key) => boolean` is the contract.
   */
  topId(): CaptureId | null {
    const top = this.entries[this.entries.length - 1]
    return top ? top.id : null
  }

  /**
   * Drop every capture. Reserved for full-reset paths (test teardown,
   * session end). Production code should rely on disposers.
   */
  clear(): void {
    this.entries = []
  }
}

/**
 * Process-wide singleton, mirroring {@link abortBus}. Both
 * {@link EditorController} (consumer) and push-side callers (the
 * reflection cooldown, future confirm modals, plugins that opt in)
 * resolve to this instance by default. Tests construct a fresh
 * {@link InputCaptureStack} and pass it explicitly.
 */
export const inputCaptureStack: InputCaptureStack = new InputCaptureStack()
