/**
 * Phase 4 end-to-end tests for the non-interactive output modes, driving the
 * real CLI (src/index.ts) as a subprocess with the test transport
 * (MINIMAL_AGENT_TRANSPORT=test + MINIMAL_AGENT_TEST_RESPONSE).
 *
 * Covers the binding P4 exit gate:
 *   e1  --output-schema + conforming answer        → exit 0, JSON on stdout
 *   e2  --output-schema + non-conforming JSON       → exit 1, stdout EMPTY
 *   e3  --output-schema + non-JSON answer           → exit 1, stdout EMPTY
 *   e4  --output-schema (no --json) + non-conforming → exit 1, stdout EMPTY (no leak)
 *   j1  --json + plain answer                       → exit 0, final answer as one JSONL line
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
}

function tmpSchema(schema: object): string {
  const dir = mkdtempSync(join(tmpdir(), "ma-schema-"))
  const p = join(dir, "schema.json")
  writeFileSync(p, JSON.stringify(schema))
  return p
}

async function runCli(args: string[], response: string) {
  const p = Bun.spawn(["bun", "run", "src/index.ts", "--skip-quota", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 8000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      MINIMAL_AGENT_TEST_AUTH: "1",
      MINIMAL_AGENT_TRANSPORT: "test",
      MINIMAL_AGENT_TEST_RESPONSE: response,
    },
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    p.exited,
    readStream(p.stdout),
    readStream(p.stderr),
  ])
  return { exitCode, stdout, stderr }
}

const objSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
}

describe("--output-schema enforcement (e2e)", () => {
  it("e1: conforming JSON answer → exit 0, answer on stdout", async () => {
    const schemaPath = tmpSchema(objSchema)
    const { exitCode, stdout } = await runCli(
      ["--output-schema", schemaPath, "--prompt", "go"],
      '{"answer": "hello"}',
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('"answer"')
    expect(JSON.parse(stdout.trim())).toEqual({ answer: "hello" })
  })

  it("e2: well-formed JSON that violates the schema → exit 1, stdout empty", async () => {
    const schemaPath = tmpSchema(objSchema)
    const { exitCode, stdout, stderr } = await runCli(
      ["--output-schema", schemaPath, "--prompt", "go"],
      '{"wrong": 1}',
    )
    expect(exitCode).toBe(1)
    expect(stdout.trim()).toBe("")
    expect(stderr).toContain("--output-schema")
  })

  it("e3: non-JSON answer → exit 1, stdout empty", async () => {
    const schemaPath = tmpSchema(objSchema)
    const { exitCode, stdout } = await runCli(
      ["--output-schema", schemaPath, "--prompt", "go"],
      "just some prose, not json",
    )
    expect(exitCode).toBe(1)
    expect(stdout.trim()).toBe("")
  })

  it("e4: --output-schema WITHOUT --json + non-conforming → exit 1, stdout EMPTY (no leak)", async () => {
    const schemaPath = tmpSchema(objSchema)
    const { exitCode, stdout } = await runCli(
      ["--output-schema", schemaPath, "--prompt", "go"],
      "leaky prose answer that must not reach stdout",
    )
    expect(exitCode).toBe(1)
    // The whole point of buffering: a non-conforming answer never reaches stdout.
    expect(stdout).not.toContain("leaky prose")
    expect(stdout.trim()).toBe("")
  })
})

describe("--json final-answer JSONL (e2e)", () => {
  it("j1: --json emits the final answer as one JSONL item_completed line, exit 0", async () => {
    const { exitCode, stdout } = await runCli(["--json", "--prompt", "go"], "the answer")
    expect(exitCode).toBe(0)
    const lines = stdout.trim().split("\n").filter(Boolean)
    // The final answer is the terminal item_completed event.
    const last = JSON.parse(lines[lines.length - 1])
    expect(last.type).toBe("item_completed")
    expect(last.itemType).toBe("text")
    expect(last.text).toContain("the answer")
  })
})
