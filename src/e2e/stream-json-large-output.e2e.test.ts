/**
 * Large stream-json output on a slow pipe reader, at real CLI stdout.
 *
 * Measures if a large stream-json stdout loses its tail when the reader is
 * slow. Bun 1.4.x can drop queued pipe writes when process.exit runs right
 * after them. The test transport always completes, so this covers the
 * success path only. The run then ends by a natural exit (main returns, no
 * process.exit). The exit(1) paths in run-non-interactive.ts need a paused
 * or failed run after streaming, and the test transport has no knob for it.
 *
 * Payload size limit: the payload goes in through the environment, and
 * macOS caps argv plus env near 1 MB (ARG_MAX). So the largest case uses
 * U+0001 control bytes, which JSON writes as 6 bytes each, to make a big stdout from
 * a small payload.
 *
 * @module e2e/stream-json-large-output.e2e.test
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"

// Needs the opencode-go provider plugin from the sibling plugins repo.
const HAVE_PROVIDER = siblingPluginPresent("ma-llm-opencode-go-plugin")
// A skip must be visible in the gate output, never read as a pass.
if (!HAVE_PROVIDER) {
  console.warn("SKIP stream-json-large-output e2e: sibling ma-llm-opencode-go-plugin missing")
}

// Each size runs several times, so a lost write shows up.
const RUNS = 5
// Wait this long between reads, to make a slow pipe reader.
const READ_DELAY_MS = 5

const CORE_ROOT = join(import.meta.dir, "..", "..")
const TMP_ROOT = join(CORE_ROOT, "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const HOME_DIR = mkdtempSync(join(TMP_ROOT, "e2e-stream-json-large-"))

afterAll(() => {
  rmSync(HOME_DIR, { recursive: true, force: true })
})

/** Read the whole stream slowly: sleep between reads. */
async function readSlow(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
    await Bun.sleep(READ_DELAY_MS)
  }
  return out + decoder.decode()
}

async function runCli(payload: string) {
  const p = Bun.spawn(
    [
      "bun",
      "run",
      "src/index.ts",
      "--skip-quota",
      "--output-format",
      "stream-json",
      "--prompt",
      "go",
    ],
    {
      cwd: CORE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        MINIMAL_AGENT_TEST_AUTH: "1",
        MINIMAL_AGENT_TRANSPORT: "test",
        MINIMAL_AGENT_TEST_RESPONSE: payload,
        MINIMAL_AGENT_PROVIDER: "opencode-go",
        MINIMAL_AGENT_MODEL: "qwen3.7-plus",
        HOME: HOME_DIR,
        MINIMAL_AGENT_HOME: join(HOME_DIR, ".minimal-agent"),
      },
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    p.exited,
    readSlow(p.stdout),
    new Response(p.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

/** One measured run: what came out, and how it was lost if it was lost. */
type RunReport = {
  exitCode: number
  stdoutBytes: number
  badLines: number
  lastType: string | null
  deltaChars: number
  completedChars: number
}

function measure(exitCode: number, stdout: string): RunReport {
  let badLines = 0
  let lastType: string | null = null
  let deltaChars = 0
  let completedChars = 0
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      badLines++
      lastType = "<unparsable>"
      continue
    }
    lastType = typeof obj.type === "string" ? obj.type : null
    if (obj.type === "text_delta" && typeof obj.text === "string") deltaChars += obj.text.length
    if (obj.type === "item_completed" && obj.itemType === "text" && typeof obj.text === "string") {
      completedChars += obj.text.length
    }
  }
  return { exitCode, stdoutBytes: stdout.length, badLines, lastType, deltaChars, completedChars }
}

const CASES: Array<{ name: string; payload: string }> = [
  { name: "70 KB ascii", payload: "a".repeat(70 * 1024) },
  // Near the ARG_MAX limit. About 1.8 MB of stdout (text twice).
  { name: "900 KB ascii", payload: "a".repeat(900 * 1000) },
  // JSON writes \x01 as \u0001, so about 8.4 MB of stdout.
  { name: "700 KB \\x01 (about 8 MB stdout)", payload: "\x01".repeat(700 * 1000) },
]

describe.skipIf(!HAVE_PROVIDER)("stream-json large output on a slow reader", () => {
  for (const c of CASES) {
    it(
      `${c.name}: every line JSON, run_finished last, full text, ${RUNS} runs`,
      async () => {
        const reports: RunReport[] = []
        for (let i = 0; i < RUNS; i++) {
          const { exitCode, stdout } = await runCli(c.payload)
          reports.push(measure(exitCode, stdout))
        }
        const lossy = reports.filter(
          (r) =>
            r.badLines > 0 ||
            r.lastType !== "run_finished" ||
            r.deltaChars !== c.payload.length ||
            r.completedChars !== c.payload.length,
        )
        // Print the raw counts, so the measure is in the test output.
        console.warn(`MEASURE ${c.name}: loss ${lossy.length}/${RUNS} ${JSON.stringify(reports)}`)
        for (const r of reports) {
          expect(r.exitCode).toBe(0)
          expect(r.badLines).toBe(0)
          expect(r.lastType).toBe("run_finished")
          expect(r.deltaChars).toBe(c.payload.length)
          expect(r.completedChars).toBe(c.payload.length)
        }
      },
      RUNS * 65000,
    )
  }
})
