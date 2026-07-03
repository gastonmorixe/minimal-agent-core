import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { describe, expect, it } from "bun:test"

import { RawInput } from "./input.ts"

class FakeTTYInput extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null
  resumed = false
  rawModes: boolean[] = []

  setEncoding(encoding: BufferEncoding): this {
    this.encoding = encoding
    return this
  }

  resume(): this {
    this.resumed = true
    return this
  }

  pause(): this {
    this.resumed = false
    return this
  }

  setRawMode(value: boolean): this {
    this.rawModes.push(value)
    return this
  }

  send(chunk: string): void {
    this.emit("data", chunk)
  }
}

class FakeOutput {
  readonly chunks: string[] = []

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }

  text(): string {
    return this.chunks.join("")
  }
}

function countLineFeeds(text: string): number {
  return Array.from(text).filter((char) => char === "\n").length
}

type RawInputInternals = {
  stdin: NodeJS.ReadStream
  output: Pick<NodeJS.WriteStream, "write">
}

function makeTTYInput(
  prompt = "> ",
  continuationPrompt = "... ",
): {
  input: RawInput
  stdin: FakeTTYInput
  output: FakeOutput
} {
  const input = new RawInput(prompt, continuationPrompt)
  const stdin = new FakeTTYInput()
  const output = new FakeOutput()
  const injected = input as unknown as RawInputInternals
  injected.stdin = stdin as unknown as NodeJS.ReadStream
  injected.output = output
  return { input, stdin, output }
}

async function readFromTTY(chunks: string[]): Promise<{
  result: string | null
  stdin: FakeTTYInput
  output: FakeOutput
}> {
  const { input, stdin, output } = makeTTYInput()
  const pending = input.read()
  for (const chunk of chunks) {
    stdin.send(chunk)
  }
  const result = await pending
  return { result, stdin, output }
}

async function readFromTTYWithPrompts(
  chunks: string[],
  prompt: string,
  continuationPrompt: string,
): Promise<{
  result: string | null
  stdin: FakeTTYInput
  output: FakeOutput
}> {
  const { input, stdin, output } = makeTTYInput(prompt, continuationPrompt)
  const pending = input.read()
  for (const chunk of chunks) {
    stdin.send(chunk)
  }
  const result = await pending
  return { result, stdin, output }
}

describe("RawInput", () => {
  it("enables and disables terminal input modes around each TTY read", async () => {
    const { input, stdin, output } = makeTTYInput()
    const pending = input.read()

    expect(output.text()).toContain("\x1b[?2004h")
    expect(output.text()).toContain("\x1b[>31u")
    expect(output.text()).toContain("\x1b[>4;1f")
    expect(output.text()).toContain("\x1b[>4;2m")

    stdin.send("ok")
    stdin.send("\r")

    await expect(pending).resolves.toBe("ok")
    expect(output.text()).toContain("\x1b[>4m")
    expect(output.text()).toContain("\x1b[>4f")
    expect(output.text()).toContain("\x1b[<u")
    expect(output.text()).toContain("\x1b[?2004l")
  })

  it("renders the initial prompt immediately and restores cooked mode after submit", async () => {
    const { input, stdin, output } = makeTTYInput()
    const pending = input.read()

    expect(output.text()).toContain("> ")
    expect(stdin.encoding).toBe("utf8")
    expect(stdin.resumed).toBe(true)
    expect(stdin.rawModes).toEqual([true])

    stdin.send("hello")
    stdin.send("\r")

    await expect(pending).resolves.toBe("hello")
    expect(stdin.rawModes).toEqual([true, false])
    expect(output.text()).toContain("\n")
  })

  it("positions the cursor using visible prompt width when prompts contain ANSI", async () => {
    const prompt = "\x1b[1;36m❯\x1b[22;39m "
    const continuationPrompt = "\x1b[2m·\x1b[22m "
    const { input, stdin, output } = makeTTYInput(prompt, continuationPrompt)
    const pending = input.read()

    expect(output.text()).toContain(prompt)
    expect(output.text()).toContain("\x1b[2C")

    stdin.send("hi")
    stdin.send("\r")

    await expect(pending).resolves.toBe("hi")
  })

  it("submits a single line on Enter", async () => {
    const { result } = await readFromTTY(["hello", "\r"])
    expect(result).toBe("hello")
  })

  it("inserts a newline on Option+Enter", async () => {
    const { result } = await readFromTTY(["hello", "\x1b\r", "world", "\r"])
    expect(result).toBe("hello\nworld")
  })

  it("inserts a newline on kitty Shift+Enter even when split across chunks", async () => {
    const { result } = await readFromTTY(["hello", "\x1b[13;", "2u", "world", "\r"])
    expect(result).toBe("hello\nworld")
  })

  it("inserts a newline on kitty Shift+Enter in full report-all mode", async () => {
    const { result } = await readFromTTY(["hello", "\x1b[13;2;13u", "world", "\x1b[13;1;13u"])
    expect(result).toBe("hello\nworld")
  })

  it("inserts a newline on kitty Alt+Enter", async () => {
    const { result } = await readFromTTY(["hello", "\x1b[13;3u", "world", "\r"])
    expect(result).toBe("hello\nworld")
  })

  it("inserts a newline on xterm modified Shift+Enter", async () => {
    const { result } = await readFromTTY(["hello", "\x1b[27;2;13~", "world", "\r"])
    expect(result).toBe("hello\nworld")
  })

  it("inserts a newline on xterm modified Alt+Enter", async () => {
    const { result } = await readFromTTY(["hello", "\x1b[27;3;13~", "world", "\r"])
    expect(result).toBe("hello\nworld")
  })

  it("submits on kitty plain Enter in full report-all mode", async () => {
    const { result } = await readFromTTY(["hello", "\x1b[13;1;13u"])
    expect(result).toBe("hello")
  })

  it("inserts printable text from kitty full report-all sequences", async () => {
    const { result } = await readFromTTY(["\x1b[104;1;104u", "\x1b[105;1;105u", "\x1b[13;1;13u"])
    expect(result).toBe("hi")
  })

  it("ignores empty Enter without submitting or adding blank lines", async () => {
    const { result, output } = await readFromTTY(["\r", "ok", "\r"])
    expect(result).toBe("ok")
    expect(countLineFeeds(output.text())).toBe(1)
  })

  it("uses Ctrl+D as a no-op on an empty buffer", async () => {
    const { result } = await readFromTTY(["\x04", "ok", "\r"])
    expect(result).toBe("ok")
  })

  it("uses kitty Ctrl+D as a no-op on an empty buffer", async () => {
    const { result } = await readFromTTY(["\x1b[100;5u", "ok", "\r"])
    expect(result).toBe("ok")
  })

  it("uses Ctrl+D as forward delete when the buffer is not empty", async () => {
    const { result } = await readFromTTY(["abc", "\x1b[D", "\x04", "\r"])
    expect(result).toBe("ab")
  })

  it("uses kitty Ctrl+D as forward delete when the buffer is not empty", async () => {
    const { result } = await readFromTTY(["abc", "\x1b[D", "\x1b[100;5u", "\r"])
    expect(result).toBe("ab")
  })

  it("returns null on Ctrl+C", async () => {
    const { result } = await readFromTTY(["abc", "\x03"])
    expect(result).toBeNull()
  })

  it("returns null on kitty Ctrl+C", async () => {
    const { result } = await readFromTTY(["abc", "\x1b[99;5u"])
    expect(result).toBeNull()
  })

  it("deletes backward with Backspace and merges lines at column zero", async () => {
    const { result } = await readFromTTY([
      "ab",
      "\x1b\r",
      "cd",
      "\x1b[A",
      "\x05",
      "\x1b[B",
      "\x01",
      "\x7f",
      "\r",
    ])
    expect(result).toBe("abcd")
  })

  it("deletes forward with Delete and merges the next line at end of line", async () => {
    const { result } = await readFromTTY(["ab", "\x1b\r", "cd", "\x1b[A", "\x05", "\x1b[3~", "\r"])
    expect(result).toBe("abcd")
  })

  it("moves left across a line boundary", async () => {
    const { result } = await readFromTTY([
      "ab",
      "\x1b\r",
      "cd",
      "\x1b[D",
      "\x1b[D",
      "\x1b[D",
      "X",
      "\r",
    ])
    expect(result).toBe("abX\ncd")
  })

  it("moves right across a line boundary", async () => {
    const { result } = await readFromTTY([
      "ab",
      "\x1b\r",
      "cd",
      "\x1b[A",
      "\x05",
      "\x1b[C",
      "X",
      "\r",
    ])
    expect(result).toBe("ab\nXcd")
  })

  it("moves up with column clamping", async () => {
    const { result } = await readFromTTY(["a", "\x1b\r", "long", "\x1b[A", "X", "\r"])
    expect(result).toBe("aX\nlong")
  })

  it("moves down with column clamping", async () => {
    const { result } = await readFromTTY([
      "long",
      "\x1b\r",
      "a",
      "\x1b[A",
      "\x05",
      "\x1b[B",
      "X",
      "\r",
    ])
    expect(result).toBe("long\naX")
  })

  for (const sequence of ["\x1bb", "\x1b[1;3D"]) {
    it(`moves one word left for ${JSON.stringify(sequence)}`, async () => {
      const { result } = await readFromTTY(["one two", sequence, "X", "\r"])
      expect(result).toBe("one Xtwo")
    })
  }

  for (const sequence of ["\x1bf", "\x1b[1;3C"]) {
    it(`moves one word right for ${JSON.stringify(sequence)}`, async () => {
      const { result } = await readFromTTY(["one two", "\x01", sequence, "X", "\r"])
      expect(result).toBe("oneX two")
    })
  }

  it("moves to the start of the line on Ctrl+A", async () => {
    const { result } = await readFromTTY(["abc", "\x01", "X", "\r"])
    expect(result).toBe("Xabc")
  })

  it("moves to the start of the line on kitty Ctrl+A", async () => {
    const { result } = await readFromTTY(["abc", "\x1b[97;5u", "X", "\r"])
    expect(result).toBe("Xabc")
  })

  it("moves to the end of the line on Ctrl+E", async () => {
    const { result } = await readFromTTY(["abc", "\x01", "\x05", "X", "\r"])
    expect(result).toBe("abcX")
  })

  it("moves to the end of the line on kitty Ctrl+E", async () => {
    const { result } = await readFromTTY(["abc", "\x1b[97;5u", "\x1b[101;5u", "X", "\r"])
    expect(result).toBe("abcX")
  })

  it("kills to the end of the line on Ctrl+K and merges the next line when already at end", async () => {
    const first = await readFromTTY(["abc", "\x1b[D", "\x0b", "\r"])
    expect(first.result).toBe("ab")

    const second = await readFromTTY(["ab", "\x1b\r", "cd", "\x1b[A", "\x05", "\x0b", "\r"])
    expect(second.result).toBe("abcd")
  })

  it("kills to the end of the line on kitty Ctrl+K and merges the next line when already at end", async () => {
    const first = await readFromTTY(["abc", "\x1b[D", "\x1b[107;5u", "\r"])
    expect(first.result).toBe("ab")

    const second = await readFromTTY([
      "ab",
      "\x1b[13;2u",
      "cd",
      "\x1b[A",
      "\x1b[101;5u",
      "\x1b[107;5u",
      "\r",
    ])
    expect(second.result).toBe("abcd")
  })

  it("kills to the start of the line on Ctrl+U", async () => {
    const { result } = await readFromTTY(["abc", "\x1b[D", "\x15", "\r"])
    expect(result).toBe("c")
  })

  it("deletes the word before the cursor on Ctrl+W", async () => {
    const { result } = await readFromTTY(["one two", "\x17", "\r"])
    expect(result).toBe("one ")
  })

  it("supports kitty Alt+B and Alt+F word motion", async () => {
    const left = await readFromTTY(["one two", "\x1b[98;3u", "X", "\r"])
    expect(left.result).toBe("one Xtwo")

    const right = await readFromTTY(["one two", "\x01", "\x1b[102;3u", "X", "\r"])
    expect(right.result).toBe("oneX two")
  })

  for (const sequence of ["\x1b[H", "\x1b[1~"]) {
    it(`moves to the start of the line for ${JSON.stringify(sequence)}`, async () => {
      const { result } = await readFromTTY(["abc", sequence, "X", "\r"])
      expect(result).toBe("Xabc")
    })
  }

  for (const sequence of ["\x1b[F", "\x1b[4~"]) {
    it(`moves to the end of the line for ${JSON.stringify(sequence)}`, async () => {
      const { result } = await readFromTTY(["abc", "\x01", sequence, "X", "\r"])
      expect(result).toBe("abcX")
    })
  }

  it("inserts printable multi-byte UTF-8 text", async () => {
    const { result } = await readFromTTY(["hi🙂é", "\r"])
    expect(result).toBe("hi🙂é")
  })

  it("ignores unknown escape sequences", async () => {
    const { result } = await readFromTTY(["ab", "\x1b[99~", "cd", "\r"])
    expect(result).toBe("abcd")
  })

  it("renders continuation prompts for multiline content", async () => {
    const { output } = await readFromTTY(["hello", "\x1b\r", "world", "\r"])
    expect(output.text()).toContain("... world")
  })

  it("renders no continuation prompt when the continuation prompt is empty", async () => {
    const { output } = await readFromTTYWithPrompts(
      ["hello", "\x1b[13;2u", "world", "\r"],
      "> ",
      "",
    )
    expect(output.text()).toContain("\r\nworld")
    expect(output.text()).not.toContain("\r\n> world")
  })

  it("renders an opt-in continuation guide when provided", async () => {
    const { output } = await readFromTTYWithPrompts(
      ["hello", "\x1b[13;2u", "world", "\r"],
      "> ",
      "| ",
    )
    expect(output.text()).toContain("| world")
  })

  it("inserts a newline on a lone LF (Shift+Enter via terminal keymap, or Ctrl+J)", async () => {
    // Bare `\n` without a `\r` partner means the terminal distinguished
    // Shift+Enter from Enter (or the user pressed Ctrl+J). Insert a
    // newline so multi-line editing works with Shift+Enter just like
    // with Alt/Option+Enter (`\x1b\r`). To recover real submit, follow
    // with `\r`.
    const { result } = await readFromTTY(["hello", "\n", "world", "\r"])
    expect(result).toBe("hello\nworld")
  })

  it("still submits on CRLF (\\r\\n) coalesced as a single Enter press", async () => {
    const { result } = await readFromTTY(["hello", "\r\n"])
    expect(result).toBe("hello")
  })

  it("still submits on LFCR (\\n\\r) coalesced as a single Enter press", async () => {
    const { result } = await readFromTTY(["hello", "\n\r"])
    expect(result).toBe("hello")
  })

  it("inserts a newline on lone LF split across chunks (still bare LF)", async () => {
    const { result } = await readFromTTY(["hello", "\n", "world", "\r"])
    expect(result).toBe("hello\nworld")
  })

  it("bare LF on an EMPTY buffer inserts a blank-line newline (matches Alt+Enter)", async () => {
    // Regression: an earlier ordering let the isBlankBuffer() no-op
    // swallow bare LF, so Shift+Enter via terminal keymap did nothing
    // on an empty prompt — but Alt+Enter (`\x1b\r`) bypassed it and
    // inserted a blank-line newline. Both newline-insert keys must
    // agree on empty buffers.
    const a = await readFromTTY(["\n", "hello", "\r"])
    const b = await readFromTTY(["\x1b\r", "hello", "\r"])
    expect(a.result).toBe(b.result)
    expect(a.result).toBe("\nhello")
  })

  it("real Enter (\\r) on an empty buffer stays a no-op (existing shell convention)", async () => {
    // Counter-test: my reordering must NOT change the long-standing
    // "press Enter on empty line = no-op, don't submit" behavior. The
    // three leading `\r`s should be eaten as no-ops, only the final
    // submit after `hello` should land.
    const { result } = await readFromTTY(["\r", "\r", "\r", "hello", "\r"])
    expect(result).toBe("hello")
  })

  it("treats embedded line endings in one chunk as pasted multiline text", async () => {
    const { result } = await readFromTTY(["line1\rline2\r"])
    expect(result).toBe("line1\nline2")
  })

  it("accepts bracketed paste with multiline content", async () => {
    const { result } = await readFromTTY([
      "before ",
      "\x1b[200~line1\r\nline2\tindented\x1b[201~",
      "\r",
    ])
    expect(result).toBe("before line1\nline2\tindented")
  })

  it("accepts bracketed paste when the closing sequence is split across chunks", async () => {
    const { result } = await readFromTTY(["\x1b[200~line1\rline2\x1b[20", "1~", "\r"])
    expect(result).toBe("line1\nline2")
  })

  it("falls back to readline for non-TTY stdin and returns one line", async () => {
    const input = new RawInput("> ", "... ")
    const stdin = new PassThrough()
    const injected = input as unknown as RawInputInternals
    ;(stdin as PassThrough & { isTTY: boolean }).isTTY = false
    injected.stdin = stdin as unknown as NodeJS.ReadStream
    injected.output = new FakeOutput()

    const pending = input.read()
    stdin.end("hello\n")

    await expect(pending).resolves.toBe("hello")
  })

  it("submits a real Enter even when an arrow key is coalesced into the same chunk", async () => {
    // Regression: the old heuristic treated *any* trailing data as a paste
    // newline, which could silently swallow Enter under load. Now an ESC
    // immediately after \r means the Enter is real and the rest stays in
    // the pending buffer.
    const { result } = await readFromTTY(["hello\r\x1b[A"])
    expect(result).toBe("hello")
  })

  it("preserves a multi-line whitespace buffer instead of wiping it on Enter", async () => {
    // ["abc", Alt+Enter, "  ", Ctrl+A, Backspace x3 to leave just the blank
    // continuation line and a leading blank line, then Enter] — should
    // submit the composed content, not clear the buffer.
    const { result } = await readFromTTY([
      " ", // row 0: " "
      "\x1b\r", // newline
      " ", // row 1: " "
      "\r", // submit
    ])
    expect(result).toBe(" \n ")
  })

  it("inserts a literal newline when pasted-without-brackets multiline arrives", async () => {
    const { result } = await readFromTTY(["line1\rline2\r"])
    expect(result).toBe("line1\nline2")
  })

  it("respects display width: emoji counts as two cells when positioning the cursor", async () => {
    const { input, stdin, output } = makeTTYInput("> ", "  ")
    const pending = input.read()
    stdin.send("🙂x")
    stdin.send("\r")
    await expect(pending).resolves.toBe("🙂x")
    // After rendering "> 🙂x", cursor should be 5 cells in (prompt 2 + emoji
    // 2 + 'x' 1). The render emits a CSI CUF with that column.
    expect(output.text()).toContain("\x1b[5C")
  })

  it("clears the previous frame from the top before redrawing (no ghost rows)", async () => {
    const { input, stdin, output } = makeTTYInput()
    const pending = input.read()
    stdin.send("abc")
    stdin.send("\x1b\r") // newline
    stdin.send("def")
    // At this point we have a 2-row frame. Now collapse with backspaces.
    output.chunks.length = 0
    stdin.send("\x7f\x7f\x7f\x7f") // delete 'def' + the newline
    // Each render after the first must move up to the top of the previous
    // frame and emit \x1b[J to wipe it before drawing the new content.
    expect(output.text()).toContain("\x1b[J")
    stdin.send("\r")
    await expect(pending).resolves.toBe("abc")
  })

  it("returns null on non-TTY EOF without a line", async () => {
    const input = new RawInput("> ", "... ")
    const stdin = new PassThrough()
    const injected = input as unknown as RawInputInternals
    ;(stdin as PassThrough & { isTTY: boolean }).isTTY = false
    injected.stdin = stdin as unknown as NodeJS.ReadStream
    injected.output = new FakeOutput()

    const pending = input.read()
    stdin.end()

    await expect(pending).resolves.toBeNull()
  })
})
