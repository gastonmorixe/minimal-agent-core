/**
 * The stream-json `session_started` line and envelope at real CLI stdout.
 *
 * Spawns the real CLI (`src/index.ts`) with the test transport and checks
 * the index.ts wiring end to end for a fresh run: the first line, the
 * envelope keys on every line, and the closing `run_finished` line. A
 * second case checks the failure path with an unknown provider.
 *
 * @module e2e/stream-json-session.e2e.test
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"

// Needs the opencode-go provider plugin from the sibling plugins repo.
const HAVE_PROVIDER = siblingPluginPresent("ma-llm-opencode-go-plugin")
// A skip must be visible in the gate output, never read as a pass.
if (!HAVE_PROVIDER) {
  console.warn("SKIP stream-json-session e2e: sibling ma-llm-opencode-go-plugin missing")
}

// The failure lines are written just before process.exit. Run each failure
// case several times, so a lost write on the pipe shows up. Assumed runtime:
// Bun 1.4.x, where process.exit can drop large queued pipe writes.
const FLUSH_RUNS = 5

const CORE_ROOT = join(import.meta.dir, "..", "..")
const TMP_ROOT = join(CORE_ROOT, "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const HOME_DIR = mkdtempSync(join(TMP_ROOT, "e2e-stream-json-session-"))

afterAll(() => {
  rmSync(HOME_DIR, { recursive: true, force: true })
})

const SID = "3b9d7e21-5c4a-4f8e-b1d2-7a6c5e4f3d2b"
const FAIL_SID = "8e2f4a6c-1b3d-4e5f-a7b9-c0d1e2f3a4b5"

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
}

async function runCli(args: string[], provider = "opencode-go") {
  const p = Bun.spawn(["bun", "run", "src/index.ts", "--skip-quota", ...args], {
    cwd: CORE_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      MINIMAL_AGENT_TEST_AUTH: "1",
      MINIMAL_AGENT_TRANSPORT: "test",
      MINIMAL_AGENT_TEST_RESPONSE: "PONG",
      MINIMAL_AGENT_PROVIDER: provider,
      MINIMAL_AGENT_MODEL: "qwen3.7-plus",
      HOME: HOME_DIR,
      MINIMAL_AGENT_HOME: join(HOME_DIR, ".minimal-agent"),
    },
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    p.exited,
    readStream(p.stdout),
    readStream(p.stderr),
  ])
  return { exitCode, stdout, stderr }
}

/** Parse every non-empty stdout line. Throws when a line is not JSON. */
function parseLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe.skipIf(!HAVE_PROVIDER)("stream-json session wiring at CLI stdout", () => {
  it("fresh run: session_started first, envelope on every line, run_finished completed last", async () => {
    const { exitCode, stdout } = await runCli([
      "--session-id",
      SID,
      "--output-format",
      "stream-json",
      "--prompt",
      "go",
    ])
    expect(exitCode).toBe(0)
    const lines = parseLines(stdout)
    expect(lines.length).toBeGreaterThan(2)

    expect(lines[0]).toMatchObject({
      type: "session_started",
      sessionId: SID,
      resumedFrom: null,
      model: "qwen3.7-plus",
      provider: "opencode-go",
      seq: 0,
    })

    lines.forEach((l, i) => {
      expect(l.sessionId).toBe(SID)
      expect(l.seq).toBe(i)
      expect(typeof l.ts).toBe("number")
    })

    expect(lines.at(-1)).toMatchObject({ type: "run_finished", outcome: "completed" })

    const textDone = lines.filter(
      (l) =>
        l.type === "item_completed" &&
        l.itemType === "text" &&
        typeof l.text === "string" &&
        l.text.includes("PONG"),
    )
    expect(textDone.length).toBeGreaterThan(0)
  })

  it(
    "unknown provider (main().catch): exactly error then run_finished failed, every run",
    async () => {
      // An unknown model id is not a failure under the test transport: the
      // run completes with no text. So this case uses an unknown provider,
      // which fails in provider boot, before the model is known.
      for (let i = 0; i < FLUSH_RUNS; i++) {
        const { exitCode, stdout, stderr } = await runCli(
          ["--session-id", FAIL_SID, "--output-format", "stream-json", "--prompt", "go"],
          "no-such-provider",
        )
        expect(exitCode).toBe(1)
        expect(stderr.length).toBeGreaterThan(0)
        const lines = parseLines(stdout)
        // No session_started: the failure comes before the model is known.
        expect(lines.map((l) => [l.type, l.seq])).toEqual([
          ["error", 0],
          ["run_finished", 1],
        ])
        expect(lines[1]?.outcome).toBe("failed")
        for (const l of lines) expect(l.sessionId).toBe(FAIL_SID)
      }
    },
    FLUSH_RUNS * 25000,
  )

  it(
    "resume of a missing session (direct exit): stdout ends with error then run_finished failed",
    async () => {
      for (let i = 0; i < FLUSH_RUNS; i++) {
        const { exitCode, stdout } = await runCli([
          "--resume",
          "00000000-0000-4000-8000-000000000000",
          "--output-format",
          "stream-json",
          "--prompt",
          "go",
        ])
        expect(exitCode).toBe(1)
        const lines = parseLines(stdout)
        expect(lines.at(-1)).toMatchObject({ type: "run_finished", outcome: "failed" })
        expect(lines.at(-2)?.type).toBe("error")
        expect(lines.map((l) => l.seq)).toEqual(lines.map((_, n) => n))
      }
    },
    FLUSH_RUNS * 25000,
  )
})
