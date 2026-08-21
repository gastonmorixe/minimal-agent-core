/**
 * Driver for `paste-pty.e2e.test.ts`.
 *
 * Runs a REAL EditorController + Compositor inside a real terminal (spawned
 * by Bun.Terminal or tmux) and replays a large bracketed paste as multiple
 * stdin chunks. The parent test controls env (notably COLUMNS) so the
 * single-source-of-truth cols contract can be validated against real PTY
 * semantics instead of FakeTerminal emulation.
 *
 * Exit protocol: prints a final line "PASTE-PTY-DONE" followed by a space
 * and the base64 of every byte the compositor wrote, so the parent can
 * replay the byte stream through a FakeTerminal-style DECAWM model and
 * assert on scrollback ghosts.
 */
import { EventEmitter } from "node:events"

import { EditorController } from "../../host/editor-controller.ts"
import { Compositor } from "../../ui/compositor.ts"

let raw = ""
const compositor = new Compositor({
  output: {
    isTTY: process.stdout.isTTY,
    get columns() {
      return process.stdout.columns
    },
    get rows() {
      return process.stdout.rows
    },
    write: (s: string) => {
      raw += s
      return true
    },
  } as any,
})

class FakeStdin extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null

  setEncoding(enc: BufferEncoding): this {
    this.encoding = enc
    return this
  }

  resume(): this {
    return this
  }

  pause(): this {
    return this
  }

  setRawMode(_v: boolean): this {
    return this
  }

  send(chunk: string): void {
    this.emit("data", chunk)
  }
}

const stdin = new FakeStdin()
const editor = new EditorController({
  prompt: "ASK ❯ ",
  continuationPrompt: "  ",
  // Bounded like the real app (live-repl.ts uses rows/2). Without a cap the
  // live area grows past the PTY viewport and every paint legitimately
  // scrolls, committing predecessor frames into scrollback — a driver
  // artifact that masks the actual bug signal.
  maxLiveHeight: 12,
  compositor,
  stdin: stdin as any,
})
compositor.mount()
editor.start()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

void (async () => {
  // Keep the event loop alive even though our stdin is a fake emitter with
  // no OS backing (otherwise Bun exits after the synchronous setup).
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    await run()
  } finally {
    clearInterval(keepAlive)
  }
})()

async function run(): Promise<void> {
  // 80 lines x ~70 visible chars: at any plausible width most lines wrap,
  // which is what makes the erase walk-up sensitive to cols disagreement.
  const payload = Array.from({ length: 80 }, (_, i) => `${"x".repeat(70)} ${i}`).join("\r")

  // Split into 12 chunks WITHOUT the closing terminator so the incremental
  // consumeBracketedPaste path fires once per chunk (the paint-storm lane).
  const chunks: string[] = []
  const per = Math.ceil(payload.length / 12)
  for (let i = 0; i < payload.length; i += per) chunks.push(payload.slice(i, i + per))
  await sleep(150)
  for (const c of chunks) {
    stdin.send(`\x1b[200~${c}`)
    await sleep(10)
  }
  stdin.send("\x1b[201~")
  await sleep(200)

  editor.stop()
  compositor.unmount()
  // Emit the captured byte stream verbatim; the parent decodes and models it.
  process.stdout.write(`\nPASTE-PTY-DONE ${Buffer.from(raw).toString("base64")}\n`)
  process.exit(0)
}
