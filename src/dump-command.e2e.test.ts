import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { SessionStore } from "./session-store.ts"

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
}

function createHomeWithSession(sid: string): string {
  const home = mkdtempSync(join(tmpdir(), "ma-dump-e2e-"))
  const sessionsDir = join(home, ".minimal-agent", "sessions")
  const store = SessionStore.open({
    sid,
    model: "claude-opus-4-7",
    cwd: process.cwd(),
    systemHash: "sys-hash",
    toolsHash: "tools-hash",
    agentVersion: "test",
    dir: sessionsDir,
  })
  store.appendUser("hello")
  store.appendAssistant([{ type: "text", text: "world" }], "end_turn")
  return home
}

describe("dump command architecture", () => {
  it("writes clean dump output without startup/auth stderr noise", async () => {
    const sid = "dump-clean-sid"
    const home = createHomeWithSession(sid)

    try {
      const p = Bun.spawn(["bun", "run", "src/index.ts", "--dump", sid], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
        },
      })
      const [code, stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])

      expect(code).toBe(0)
      expect(stdout).toContain(`# Session: ${sid}`)
      expect(stderr.trim()).toBe("")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("handles downstream pipe close without broken-pipe noise", async () => {
    const sid = "dump-pipe-sid"
    const home = createHomeWithSession(sid)

    try {
      const p = Bun.spawn(
        [
          "bash",
          "-lc",
          `set -o pipefail; bun run src/index.ts --dump ${sid} | head -n 3 >/dev/null`,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: home,
          },
        },
      )
      const [code, stderr] = await Promise.all([p.exited, readStream(p.stderr)])

      expect(code).toBe(0)
      expect(stderr).not.toContain("EPIPE")
      expect(stderr.toLowerCase()).not.toContain("broken pipe")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("--sessions runs without startup/auth stderr noise", async () => {
    const home = mkdtempSync(join(tmpdir(), "ma-sessions-e2e-"))
    try {
      const p = Bun.spawn(["bun", "run", "src/index.ts", "--sessions"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
        },
      })
      const [code, stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])

      expect(code).toBe(0)
      expect(stdout).toContain("no saved sessions yet")
      expect(stderr.trim()).toBe("")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
