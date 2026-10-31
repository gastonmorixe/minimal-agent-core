/**
 * Driver for `quit-confirm-tmux.test.ts`.
 *
 * Runs a real EditorController + Compositor through the abort/quit flow inside
 * tmux. Kept under tracked test fixtures so the smoke test does not depend on
 * ignored local files under `tmp/`.
 */
import { EventEmitter } from "node:events"

import type { QuitReason } from "../../bus/abort-quit-fsm.ts"
import { EditorController } from "../../host/editor-controller.ts"
import { printGoodbye } from "../../host/ui/chrome/goodbye-banner.ts"
import { StdioInterceptor } from "../../host/ui/stdio-interceptor.ts"
import { Compositor } from "../../ui/compositor.ts"

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

const SID = "30a088be-0000-4000-8000-82cd27e6b341"
// Mirror runReplLiveArea: its `cancel` listener wakes the REPL loop, whose
// `finally` tears down and prints the goodbye banner in microtasks. That
// lands before the editor's hard exit (`setImmediate` → process.exit).
editor.on("quit", (reason: QuitReason) => {
  queueMicrotask(() => {
    editor.stop()
    compositor.unmount()
    printGoodbye({ sessionId: SID, reason }, { write: (s) => process.stdout.write(s) })
    interceptor.uninstall()
  })
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

  // Reached only when the second Ctrl+C did not quit: a confirmed quit ends
  // the process through the editor's hard exit before this timer fires.
  const state = editor.fsmStateForTest().kind
  editor.stop()
  compositor.unmount()
  interceptor.uninstall()
  process.stdout.write(`  [3] FAIL: no quit, state=${state}\n`)
  process.exit(1)
})()
