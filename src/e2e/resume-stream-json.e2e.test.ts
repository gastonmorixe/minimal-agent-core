/**
 * Resume with `--output-format stream-json` at real CLI stdout.
 *
 * A non-interactive resume must not print the human resume header or the
 * history replay. Every stdout line of a stream-json run is JSON. The first
 * line names the source session in `resumedFrom`, and its `sessionId` is the
 * new forked id.
 *
 * The test first spawns one fresh `-p` run with a fixed session id in an
 * isolated home, so a real saved session exists. Then it resumes that
 * session with `-p` (the short flag the old argv check missed).
 *
 * @module e2e/resume-stream-json.e2e.test
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"

// Needs the opencode-go provider plugin from the sibling plugins repo.
const HAVE_PROVIDER = siblingPluginPresent("ma-llm-opencode-go-plugin")

const CORE_ROOT = join(import.meta.dir, "..", "..")
const TMP_ROOT = join(CORE_ROOT, "tmp")
mkdirSync(TMP_ROOT, { recursive: true })
const HOME_DIR = mkdtempSync(join(TMP_ROOT, "e2e-resume-stream-json-"))

afterAll(() => {
  rmSync(HOME_DIR, { recursive: true, force: true })
})

const SOURCE_SID = "6f1c2a4e-8b3d-4c5e-9a7f-1d2e3f4a5b6c"

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
}

async function runCli(args: string[]) {
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
      MINIMAL_AGENT_PROVIDER: "opencode-go",
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

describe.skipIf(!HAVE_PROVIDER)("resume + stream-json at CLI stdout", () => {
  it("--resume <sid> -p go: every stdout line is JSON, resumedFrom names the source", async () => {
    const first = await runCli(["--session-id", SOURCE_SID, "--prompt", "hello"])
    expect(first.exitCode).toBe(0)

    const { exitCode, stdout, stderr } = await runCli([
      "--resume",
      SOURCE_SID,
      "-p",
      "go",
      "--output-format",
      "stream-json",
    ])
    expect(stderr).not.toContain("fatal:")
    expect(exitCode).toBe(0)

    const raw = stdout.split("\n").filter((l) => l.length > 0)
    expect(raw.length).toBeGreaterThan(1)
    const lines = raw.map((l) => JSON.parse(l) as Record<string, unknown>)
    const head = lines[0] as Record<string, unknown>
    expect(head.type).toBe("session_started")
    expect(head.resumedFrom).toBe(SOURCE_SID)
    expect(typeof head.sessionId).toBe("string")
    expect(head.sessionId).not.toBe(SOURCE_SID)
  })

  it("--resume <sid> with a positional prompt: no resume header or replay on stdout", async () => {
    // The saved session comes from the test above (same isolated home).
    // A positional prompt never matched the old `--prompt` argv check.
    const { exitCode, stdout } = await runCli([
      "--resume",
      SOURCE_SID,
      "--output-format",
      "stream-json",
      "go",
    ])
    expect(exitCode).toBe(0)
    const raw = stdout.split("\n").filter((l) => l.length > 0)
    expect(raw.length).toBeGreaterThan(1)
    const lines = raw.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines[0]?.type).toBe("session_started")
    expect(lines[0]?.resumedFrom).toBe(SOURCE_SID)
  })
})
