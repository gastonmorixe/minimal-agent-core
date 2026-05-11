#!/usr/bin/env bun
/**
 * tmux demo driver for session restore. Spawns a fake-transport agent loop
 * that:
 *
 *   1. Creates a SessionStore at ~/.minimal-agent/sessions/<sid>.jsonl
 *   2. Drives Agent.run("count to 3") with a canned streamed response
 *   3. Exits cleanly so the on-disk JSONL can be inspected
 *
 * Pair with `--mode resume` to load the session back and append a 2nd turn.
 *
 * Usage:
 *   bun run scripts/session-restore-tmux-demo.ts --mode write --sid demo-1 --dir /tmp/ma-demo
 *   bun run scripts/session-restore-tmux-demo.ts --mode resume --sid demo-1 --dir /tmp/ma-demo
 *   bun run scripts/session-restore-tmux-demo.ts --mode show --sid demo-1 --dir /tmp/ma-demo
 */
import { readFileSync } from "node:fs"
import { Agent } from "../src/agent.ts"
import type { AuthResult } from "../src/auth.ts"
import type { StreamedResponse } from "../src/client.ts"
import { loadSession } from "../src/session-restore.ts"
import { sessionFilePath, SessionStore } from "../src/session-store.ts"

const args = process.argv.slice(2)
function arg(name: string, def?: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : def
}

const mode = arg("mode", "write")
const sid = arg("sid", "demo-1")!
const dir = arg("dir", "/tmp/ma-session-demo")!

const auth: AuthResult = { type: "api-key", token: "test" }

if (mode === "show") {
  const text = readFileSync(sessionFilePath(sid, dir), "utf-8")
  process.stdout.write(text)
  process.exit(0)
}

if (mode === "write") {
  const store = SessionStore.open({
    sid,
    model: "fake-model",
    cwd: process.cwd(),
    systemHash: "h-sys",
    toolsHash: "h-tools",
    agentVersion: "demo",
    dir,
  })

  // Fake sendFn: streams text "1, 2, 3" as 3 chunks then ends.
  const sendFn = async function* () {
    yield "1, "
    yield "2, "
    yield "3"
    return {
      blocks: [{ type: "text" as const, text: "1, 2, 3" }],
      text: "1, 2, 3",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  const agent = new Agent({ auth, model: "fake-model", sendFn, store })

  process.stdout.write(`\x1b[1;36m▸ write run\x1b[0m sid=\x1b[33m${sid}\x1b[0m\n`)
  process.stdout.write(`\x1b[2muser:\x1b[0m count to 3\n\x1b[2massistant:\x1b[0m `)
  const gen = agent.run("count to 3", { onTranscriptLine: (l) => process.stdout.write(`${l}\n`) })
  while (true) {
    const { done, value } = await gen.next()
    if (done) break
    process.stdout.write(value)
  }
  process.stdout.write("\n\n")
  process.stdout.write(`\x1b[32m✓ wrote\x1b[0m ${sessionFilePath(sid, dir)}\n`)
  process.exit(0)
}

if (mode === "resume") {
  process.stdout.write(`\x1b[1;36m▸ resume run\x1b[0m sid=\x1b[33m${sid}\x1b[0m\n`)
  const loaded = loadSession(sid, dir)
  // Visual replay (mirrors the real --resume path).
  const { buildResumeHeader, replayToScrollback } = await import("../src/session-replay.ts")
  process.stdout.write(
    buildResumeHeader({
      sid,
      turns: loaded.messages.length,
      model: "fake-model",
      repaired: loaded.repaired,
      dropped: loaded.dropped.length,
    }),
  )
  await replayToScrollback(loaded.messages, { write: (s) => process.stdout.write(s) })
  process.stdout.write("\n")

  const store = SessionStore.open({
    sid,
    model: "fake-model",
    cwd: process.cwd(),
    systemHash: "h-sys",
    toolsHash: "h-tools",
    agentVersion: "demo",
    dir,
    existsOk: true,
  })

  const sendFn = async function* () {
    yield "yes I remember: 1, 2, 3"
    return {
      blocks: [{ type: "text" as const, text: "yes I remember: 1, 2, 3" }],
      text: "yes I remember: 1, 2, 3",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  const agent = new Agent({
    auth,
    model: "fake-model",
    sendFn,
    store,
    initialMessages: loaded.messages,
  })

  process.stdout.write(`\n\x1b[2muser:\x1b[0m do you remember?\n\x1b[2massistant:\x1b[0m `)
  const gen = agent.run("do you remember?", {
    onTranscriptLine: (l) => process.stdout.write(`${l}\n`),
  })
  while (true) {
    const { done, value } = await gen.next()
    if (done) break
    process.stdout.write(value)
  }
  process.stdout.write("\n\n")
  process.stdout.write(`\x1b[32m✓ resumed\x1b[0m ${sessionFilePath(sid, dir)}\n`)
  process.exit(0)
}

process.stderr.write(`unknown --mode ${mode}\n`)
process.exit(2)
