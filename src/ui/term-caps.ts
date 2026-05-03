/**
 * Terminal capability detection — active probes that ask the terminal what
 * it supports and parse the reply, with conservative timeouts and graceful
 * "treat as unsupported" fallback.
 *
 * The only capability we currently detect is **synchronized output**
 * (DEC mode 2026), used by the {@link Compositor} to wrap multi-step
 * redraws in `BSU` / `ESU` so the user sees an atomic frame instead of
 * the intermediate states (erase → write → redraw). Without synchronized
 * output the same redraw is still correct, just visibly flickery on slow
 * paths.
 *
 * **Why active probe instead of an env-var allowlist?** Modern terminal
 * emulators advertise mode 2026 via DECRPM (request mode), which is the
 * canonical way to ask "do you understand this CSI?". An allowlist of
 * `TERM_PROGRAM` values rots — every new terminal that adds support
 * (Ghostty, recent kitty, recent Konsole) has to be added by hand. The
 * DECRPM probe just works.
 *
 * **DECRPM protocol:**
 *   - Send: `CSI ? 2026 $ p`
 *   - Reply: `CSI ? 2026 ; <n> $ y` where `<n>` is one of:
 *     - `0` = mode not recognized → unsupported
 *     - `1` = currently set            ┐
 *     - `2` = currently reset          │ supported
 *     - `3` = permanently set          │ (n ∈ {1,2,3,4})
 *     - `4` = permanently reset        ┘
 *   - No reply within timeout → assume unsupported.
 *
 * **Stdin handling.** This MUST run before any other consumer attaches a
 * `data` listener to stdin (in particular, before `EditorController.start`),
 * because we put stdin into raw mode briefly and read bytes synchronously.
 * Any leftover bytes after the reply (typeahead, partial input the user
 * managed to send during detection) are returned in `unparsed` so the
 * caller can re-emit them to the next consumer.
 *
 * @module ui/term-caps
 */

export interface TermCapsInput {
  isTTY?: boolean
  setRawMode?(mode: boolean): unknown
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown
  resume?(): unknown
  pause?(): unknown
}

export interface TermCapsOutput {
  isTTY?: boolean
  write(chunk: string): boolean | void
}

export interface DetectResult {
  /** True iff the terminal replied with a recognized DECRPM status. */
  syncOutput: boolean
  /**
   * Bytes read from stdin during detection that were NOT part of the
   * DECRPM reply. Callers should feed these to the next stdin consumer
   * (typically the editor) so a typeahead keystroke isn't lost.
   */
  unparsed: string
}

const DECRPM_RE = /\x1b\[\?2026;(\d+)\$y/

/**
 * Probe the terminal for DEC mode 2026 (synchronized output) support.
 *
 * Returns `{ syncOutput: false, unparsed: "" }` immediately when stdin
 * or stdout is not a TTY (CI, pipe, test harness) — there's nothing to
 * probe and synchronized output is moot anyway.
 *
 * @param timeoutMs how long to wait for the reply before giving up.
 *   Default 80ms — long enough for a fast remote SSH session, short
 *   enough that a non-supporting terminal doesn't visibly stall startup.
 */
export async function detectSynchronizedOutput(
  input: TermCapsInput,
  output: TermCapsOutput,
  timeoutMs = 80,
): Promise<DetectResult> {
  if (!input.isTTY || !output.isTTY) {
    return { syncOutput: false, unparsed: "" }
  }

  let buf = ""
  let resolveDone: ((r: DetectResult) => void) | null = null
  const done = new Promise<DetectResult>((r) => {
    resolveDone = r
  })

  const onData = (chunk: Buffer | string): void => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    const m = buf.match(DECRPM_RE)
    if (!m) {
      // Reply not yet complete; keep accumulating.
      return
    }
    const n = Number(m[1])
    const supported = n >= 1 && n <= 4
    // Strip the matched DECRPM reply from `buf`; everything else is typeahead.
    const before = buf.slice(0, m.index ?? 0)
    const after = buf.slice((m.index ?? 0) + m[0].length)
    resolveDone?.({ syncOutput: supported, unparsed: before + after })
  }

  // Put stdin into raw mode so the reply isn't line-buffered, attach the
  // listener, then send the query. Order matters: listener BEFORE write so
  // we don't miss a reply from a very fast terminal.
  const hadRaw = typeof input.setRawMode === "function"
  if (hadRaw) input.setRawMode?.(true)
  input.resume?.()
  input.on("data", onData)

  output.write("\x1b[?2026$p")

  const timer = setTimeout(() => {
    resolveDone?.({ syncOutput: false, unparsed: buf })
  }, timeoutMs)

  const result = await done
  clearTimeout(timer)
  input.off("data", onData)
  // Leave raw mode toggling to the caller — flipping it back to cooked
  // here would race with the editor's own raw-mode setup.
  return result
}
