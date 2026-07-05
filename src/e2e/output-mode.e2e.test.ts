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
      // Pin a provider + model satisfying ALL THREE coupled constraints the
      // e2e harness imposes (each one was discovered the hard way — do not
      // change this pair without re-checking all three):
      //  1. REGISTERED: an unknown provider id is fatal at startup
      //     (index.ts:671), so "test" does NOT work. llm-opencode is a real
      //     registered provider plugin.
      //  2. ANTHROPIC-MESSAGES PROTOCOL: MINIMAL_AGENT_TRANSPORT=test emits
      //     Anthropic SSE wire format, so the provider must speak the
      //     `anthropic-messages` surface to DECODE it. opencode (adapter
      //     surface "anthropic-messages") + qwen3.7-plus (anthropic-messages
      //     surfaceId) decode correctly; ollama/deepseek is "custom" protocol
      //     and yields an empty answer ("Unexpected EOF") → e1 would fail.
      //  3. TOKEN-CLEAN: the provider-decoupling ratchet (provider-scan.ts)
      //     forbids anthropic/claude/openai/gpt/gemini/mistral/... literals in
      //     core code, so a real vendor name reds test:arch. Neither "opencode"
      //     nor "qwen3.7-plus" matches the forbidden regex.
      // Without a pinned pair, the gate's `env -u MINIMAL_AGENT_PROVIDER -u
      // MINIMAL_AGENT_MODEL` on a multi-credential machine dies "multiple
      // provider credentials found" before schema logic runs — false-greening
      // e3/e4 (cred-fatal exit 1, not schema exit 1).
      MINIMAL_AGENT_PROVIDER: "opencode",
      MINIMAL_AGENT_MODEL: "qwen3.7-plus",
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
  it("j1: --json emits the AgentCore event stream; the answer is a text item_completed, exit 0", async () => {
    // Post agent-loop-refactor integration, `--json` drives AgentCore and emits
    // the full structured event stream (turn_started → item_started →
    // item_completed → turn_completed), not a single synthetic final-answer
    // line. The answer arrives as the `item_completed` (itemType text) event;
    // the stream settles on `turn_completed`.
    const { exitCode, stdout } = await runCli(["--json", "--prompt", "go"], "the answer")
    expect(exitCode).toBe(0)
    const events = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const answer = events.find((e) => e.type === "item_completed" && e.itemType === "text")
    expect(answer).toBeDefined()
    expect(answer.text).toContain("the answer")
    expect(events[events.length - 1].type).toBe("turn_completed")
  })
})
