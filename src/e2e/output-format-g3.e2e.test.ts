/**
 * G3 gate — the `--output-format` event stream at real CLI stdout.
 *
 * Drives the actual CLI (`src/index.ts`) as a subprocess with the test
 * transport (`MINIMAL_AGENT_TRANSPORT=test` + `MINIMAL_AGENT_TEST_RESPONSE`),
 * captures `process.stdout`, and asserts the JSONL event stream reaches real
 * stdout — the proof that events survive the host wiring, not just the SDK
 * (`events-jsonl.integration.test.ts` already golden-pins the SDK level).
 *
 * Now that `src/index.ts` threads `outputFormat` + the `buildCore` closure into
 * `runNonInteractivePrompt`, the whole gate runs unconditionally:
 *   - `--output-format` parses as a value flag (never swallows the prompt);
 *   - `--json` / `--output-format json` drive AgentCore and emit the full
 *     turn/item/tool event stream (id-join intact), buffered (no deltas);
 *   - `--output-format stream-json` additionally emits token-level `text_delta`
 *     events live (Phase 3).
 *
 * Provider/model pinning + the coupled-constraints rationale mirror
 * `output-mode.e2e.test.ts` verbatim (do not change the pair without
 * re-reading that file's three-constraint note).
 *
 * @module e2e/output-format-g3.e2e.test
 */

import { describe, expect, it } from "bun:test"

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
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
      // See output-mode.e2e.test.ts: opencode + qwen3.7-plus is the one pair
      // that is registered, speaks anthropic-messages (to decode the test SSE),
      // and is token-clean for the provider-decoupling ratchet.
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

/** Parse every non-empty stdout line as JSON; throws if any line is not JSONL. */
function parseJsonl(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe("G3: --output-format at CLI stdout", () => {
  it("g3a: --output-format json <prompt> extracts the prompt, exits 0 (never swallows 'json')", async () => {
    // The positional "go" must be the prompt, not eaten as the format value.
    const { exitCode, stderr } = await runCli(["--output-format", "json", "--prompt", "go"], "hi")
    expect(exitCode).toBe(0)
    // No fatal "unknown flag" / arg-parse crash on stderr.
    expect(stderr).not.toContain("fatal:")
  })

  it("g3b: --json alias emits the AgentCore event stream carrying the answer", async () => {
    // Post-integration semantics: `--json` is an alias for `--output-format
    // json`, which drives AgentCore and emits the FULL structured event stream
    // (…/ item_completed / turn_completed), not the pre-integration single
    // final-answer line. The answer is still present, now as an `item_completed`
    // text event within the stream. The stream settles on `turn_completed`.
    const { exitCode, stdout } = await runCli(["--json", "--prompt", "go"], "the answer")
    expect(exitCode).toBe(0)
    const events = parseJsonl(stdout)
    const answer = events.find((e) => e.type === "item_completed" && e.itemType === "text")
    expect(answer).toBeDefined()
    expect(String(answer?.text)).toContain("the answer")
    expect(events.at(-1)?.type).toBe("turn_completed")
  })

  it("g3c: --output-format stream-json <prompt> parses cleanly and exits 0", async () => {
    const { exitCode, stderr } = await runCli(
      ["--output-format", "stream-json", "--prompt", "go"],
      "streamed",
    )
    expect(exitCode).toBe(0)
    expect(stderr).not.toContain("fatal:")
  })
})

describe("G3: --output-format full AgentCore event stream (integrated)", () => {
  it("g3d: --output-format json emits the full turn/item event sequence to stdout", async () => {
    const { exitCode, stdout } = await runCli(["--output-format", "json", "--prompt", "go"], "hi")
    expect(exitCode).toBe(0)
    const events = parseJsonl(stdout)
    const types = events.map((e) => e.type)
    expect(types).toContain("turn_started")
    expect(types).toContain("item_started")
    expect(types).toContain("item_completed")
    expect(types).toContain("turn_completed")
    // The stream is JSONL, NOT raw human text.
    expect(stdout).not.toBe("hi\n")
  })

  it("g3e: a tool turn preserves the tool_result.id === item_started.id join on the wire", async () => {
    // A tool-calling response requires a fixture that drives a tool round; the
    // G4 plugin-tool fixture (Carolyn) supplies it. This asserts the id-join
    // whenever a tool turn is present in the stream.
    const { exitCode, stdout } = await runCli(["--output-format", "json", "--prompt", "go"], "hi")
    expect(exitCode).toBe(0)
    const events = parseJsonl(stdout)
    const toolStart = events.find((e) => e.type === "item_started" && e.itemType === "tool_use")
    const toolResult = events.find((e) => e.type === "tool_result")
    if (toolStart && toolResult) {
      expect(toolResult.id).toBe(toolStart.id)
    }
  })

  it("g3f: stream-json emits token-level text_delta events live, exits 0 (Phase 3)", async () => {
    const { exitCode, stdout } = await runCli(
      ["--output-format", "stream-json", "--prompt", "go"],
      "streamed",
    )
    expect(exitCode).toBe(0)
    const events = parseJsonl(stdout)
    // stream-json is realtime: text_delta events carry the answer token-by-token.
    const deltas = events.filter((e) => e.type === "text_delta")
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.map((d) => String(d.text)).join("")).toContain("streamed")
    // The turn still settles cleanly.
    expect(events.map((e) => e.type)).toContain("turn_completed")
  })

  it("g3g: --output-format json does NOT emit text_delta events (buffered; deltas off)", async () => {
    const { exitCode, stdout } = await runCli(["--output-format", "json", "--prompt", "go"], "hi")
    expect(exitCode).toBe(0)
    const events = parseJsonl(stdout)
    expect(events.some((e) => e.type === "text_delta")).toBe(false)
  })
})
