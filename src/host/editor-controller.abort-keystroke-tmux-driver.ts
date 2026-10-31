/**
 * Driver for `src/bus/abort-keystroke-tmux.test.ts`.
 *
 * Wires a REAL `EditorController` (reading the pane's stdin) into
 * `runReplLiveArea`, with the compositor + stdio interceptor pairing from
 * `startup/live-repl.ts`. Only the agent is fake: each turn prints
 * `working on: <prompt>` and then waits for the turn's abort signal, so the
 * keystrokes the test sends land while the FSM is `working`.
 *
 * Tracked so the smoke test does not depend on ignored local files under
 * `tmp/`. It lives in the host package, not `test-utils/fixtures/`, because
 * it wires host-shell modules that core files may not import (see
 * `architecture/core-host-import-scan.test.ts`).
 */
import type { StreamedResponse } from "../client/types.ts"

import { EditorController } from "./editor-controller.ts"
import { type ReplAgentLike, runRepl } from "./repl.ts"
import { Compositor } from "./ui/compositor.ts"
import { StdioInterceptor } from "./ui/stdio-interceptor.ts"

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

const editor = new EditorController({
  prompt: "❯ ",
  continuationPrompt: "  ",
  compositor,
})

const agent: ReplAgentLike = {
  pluginLoader: () => null,
  async *run(text, opts) {
    yield `working on: ${text}\n`
    // Hold the turn open until the user aborts it (Esc / Ctrl+C).
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      if (opts?.signal?.aborted) abort()
      else opts?.signal?.addEventListener("abort", abort, { once: true })
    })
    return { blocks: [], text: "", stopReason: "end_turn" } as unknown as StreamedResponse
  },
}

interceptor.install()
try {
  await runRepl(agent, { useLiveArea: true, compositor, editor })
} finally {
  interceptor.uninstall()
}
