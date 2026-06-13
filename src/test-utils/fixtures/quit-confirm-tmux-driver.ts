/**
 * Driver for `quit-confirm-tmux.test.ts`.
 *
 * Runs a real EditorController + Compositor through the abort/quit flow inside
 * tmux. Kept under tracked test fixtures so the smoke test does not depend on
 * ignored local files under `tmp/`.
 */
import { EventEmitter } from "node:events"

import { EditorController } from "../../editor-controller.ts"
import { printGoodbye } from "../../ui/chrome/goodbye-banner.ts"
import { Compositor } from "../../ui/compositor.ts"
import { StdioInterceptor } from "../../ui/stdio-interceptor.ts"

let interceptorRef: StdioInterceptor | null = null
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
      if (interceptorRef) return interceptorRef.rawStdoutWrite(s) as boolean
      return process.stdout.write(s)
    },
  } as any,
})
const interceptor = new StdioInterceptor(compositor)
interceptorRef = interceptor

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
  prompt: "❯ ",
  continuationPrompt: "  ",
  compositor,
  stdin: stdin as any,
  quitFsm: { armedDurationMs: 1_000 },
  armedTickMs: 50,
})

const SID = "d5e415fb-bc89-4bfd-aba7-c41512830175"
let quitFired: string | null = null
editor.on("quit", (reason: any) => {
  quitFired = String(reason)
})

interceptor.install()
compositor.writeStream("\n  smoke: abort-quit-fsm three scenarios\n\n")
editor.start()

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

void (async () => {
  compositor.writeStream("\n  [1] press Ctrl+C once on empty buffer\n")
  await sleep(80)
  stdin.send("\x03")
  await sleep(120)

  compositor.writeStream("\n  [2] press Esc to dismiss\n")
  await sleep(800)
  stdin.send("\x1b")
  await sleep(80)
  if (editor.fsmStateForTest().kind !== "idle") {
    compositor.writeStream(`  [2] FAIL: state=${editor.fsmStateForTest().kind}\n`)
  } else {
    compositor.writeStream("  [2] OK: state=idle\n")
  }
  await sleep(200)

  compositor.writeStream("\n  [3] Ctrl+C, wait 600ms (armed footer visible), Ctrl+C\n")
  await sleep(80)
  stdin.send("\x03")
  await sleep(600)
  stdin.send("\x03")
  await sleep(200)

  editor.stop()
  compositor.unmount()
  printGoodbye(
    { sessionId: SID, reason: (quitFired as any) ?? "confirmed" },
    { write: (s) => process.stdout.write(s) },
  )
  interceptor.uninstall()
  process.exit(0)
})()
