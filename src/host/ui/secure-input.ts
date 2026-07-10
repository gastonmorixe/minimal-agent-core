/**
 * Secure terminal input: reads a single line without echoing the actual
 * characters, while showing masked feedback (dots) so the user knows
 * keystrokes are being received.
 *
 * Reusable across login, API-key prompts, and any future secret-entry
 * surface. Lives in `host/ui/` because it owns raw-mode terminal I/O;
 * it is NOT coupled to any provider or auth strategy.
 *
 * @module ui/secure-input
 */

/**
 * Read one line of secret input with masked visual feedback.
 *
 * Takes over stdin in raw mode, renders a prompt followed by a mask
 * character for each typed byte, and returns the plaintext value on
 * Enter. Ctrl+C cancels (returns `null`). Backspace removes the last
 * character and its mask dot.
 *
 * Restores the terminal's previous raw-mode state on completion,
 * including on cancellation and errors.
 */
export async function readSecureInput(
  promptText: string,
  opts: {
    /** Character rendered for each typed byte. Default `"•"`. */
    mask?: string
    /** Input stream. Defaults to `process.stdin`. */
    input?: NodeJS.ReadableStream & {
      isTTY?: boolean
      isRaw?: boolean
      setRawMode?: (mode: boolean) => void
    }
    /** Output stream. Defaults to `process.stderr` (keeps stdout clean). */
    output?: Pick<NodeJS.WriteStream, "write">
  } = {},
): Promise<string | null> {
  const mask = opts.mask ?? "•"
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stderr

  if (!input.isTTY) {
    // Non-TTY: fall back to a single readline read (no masking, but at
    // least the caller gets a value). This is the same contract as the
    // old `readSecretLine` — non-TTY stdin is a scripted edge case.
    return readFallback(promptText, input, output)
  }

  const wasRaw = input.isRaw ?? false
  const maskLen = displayWidth(mask)

  return new Promise<string | null>((resolve) => {
    let value = ""
    let settled = false
    let rendered = 0 // number of mask chars currently on screen

    const settle = (next: string | null) => {
      if (settled) return
      settled = true
      cleanup()
      output.write("\n")
      resolve(next)
    }

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      for (const ch of text) {
        const code = ch.charCodeAt(0)
        if (ch === "\r" || ch === "\n") {
          settle(value)
          return
        }
        if (code === 3) {
          // Ctrl+C
          settle(null)
          return
        }
        if (code === 127 || code === 8) {
          // Backspace / Delete
          if (value.length > 0) {
            value = value.slice(0, -1)
            eraseLastMask()
          }
          continue
        }
        // Printable-ish: accept any non-control byte. This is intentionally
        // permissive — API keys can contain any printable ASCII, and some
        // providers use base64-ish tokens with `+`, `/`, `=`, etc.
        if (code >= 32) {
          value += ch
          renderMask()
        }
      }
    }

    const renderMask = () => {
      output.write(mask)
      rendered++
    }

    const eraseLastMask = () => {
      if (rendered <= 0) return
      // Move cursor left by the mask's display width, overwrite with
      // space, then move left again so the next mask lands in the same
      // column.
      output.write(`\x1b[${maskLen}D`)
      output.write(" ".repeat(maskLen))
      output.write(`\x1b[${maskLen}D`)
      rendered--
    }

    const cleanup = () => {
      ;(input as unknown as { off: (e: string, fn: (chunk: Buffer | string) => void) => void }).off(
        "data",
        onData,
      )
      input.pause()
      if (input.setRawMode) input.setRawMode(wasRaw)
    }

    // Render the prompt before entering raw mode so it appears at the
    // current cursor position.
    output.write(promptText)

    if (input.setRawMode) input.setRawMode(true)
    input.resume()
    ;(input as unknown as { on: (e: string, fn: (chunk: Buffer | string) => void) => void }).on(
      "data",
      onData,
    )
  })
}

/**
 * Non-TTY fallback: read one line via `readline`. No masking (the
 * terminal isn't interactive), but the caller still gets a value.
 */
async function readFallback(
  promptText: string,
  input: NodeJS.ReadableStream,
  output: Pick<NodeJS.WriteStream, "write">,
): Promise<string | null> {
  const { createInterface } = await import("node:readline")
  return new Promise<string | null>((resolve) => {
    output.write(promptText)
    const rl = createInterface({ input, terminal: false })
    let settled = false
    rl.once("line", (line) => {
      settled = true
      resolve(line)
      rl.close()
    })
    rl.once("close", () => {
      if (!settled) resolve(null)
    })
  })
}

/**
 * Display-width in terminal cells. Strips ANSI escape sequences and
 * accounts for wide / zero-width code points. Inlined to avoid pulling
 * the full `term-width.ts` dependency tree (which imports plugin-api).
 */
function displayWidth(text: string): number {
  // Strip ANSI escape sequences
  const stripped = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
  let width = 0
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0) continue
    // Zero-width characters
    if (
      cp === 0x200b || // ZWSP
      cp === 0x200c || // ZWNJ
      cp === 0x200d || // ZWJ
      cp === 0xfeff || // BOM
      (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
      (cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritics extended
      (cp >= 0x20d0 && cp <= 0x20ff) || // combining diacritics for symbols
      (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
    ) {
      continue
    }
    // Wide characters (CJK, emoji, etc.)
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      cp === 0x2329 ||
      cp === 0x232a || // angle brackets
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals → Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
      (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
      (cp >= 0x1f300 && cp <= 0x1f64f) || // misc symbols / emoticons
      (cp >= 0x1f680 && cp <= 0x1f6ff) || // transport / map
      (cp >= 0x1f900 && cp <= 0x1f9ff) || // supplemental symbols
      (cp >= 0x20000 && cp <= 0x2fffd) || // CJK ext B+
      (cp >= 0x30000 && cp <= 0x3fffd) // CJK ext G+
    ) {
      width += 2
    } else {
      width += 1
    }
  }
  return width
}
