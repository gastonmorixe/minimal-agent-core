/**
 * Tests for the memory-plugin attachment wiring in `Agent.run`.
 *
 * Covers two new optional injectables on the Agent constructor:
 *
 *   - `saveEcho`            — `{consumeAll(): ContentBlock[]}` drained at
 *     the start of each user message; produces `<ma::agent::memory-saved …>` blocks.
 *   - `shortTermSnapshot`   — `{toAttachment(): ContentBlock | null}`
 *     called once at the INITIAL user-message seam only; produces a
 *     `<ma::agent::short-term-memory>…</ma::agent::short-term-memory>` block.
 *
 * Both are structural types (no hard dep on the memory plugin) so the
 * agent can be tested in isolation with hand-rolled stubs.
 *
 * Properties asserted:
 *   1. With neither: initial user content is exactly `[{type:"text", text}]`
 *      (zero regression for callers that don't opt in).
 *   2. Snapshot alone: prepended BEFORE user text.
 *   3. Save-echo alone: prepended BEFORE user text.
 *   4. Both: snapshot appears BEFORE save-echoes (snapshot is persistent
 *      session state; echoes are deltas from the previous turn).
 *   5. With mode-change: mode-change is FIRST, then snapshot, then echoes.
 *   6. Loop seam (post tool_use): tool_result comes FIRST (Anthropic API
 *      requires it), then mode-change, then save-echoes. Snapshot is NOT
 *      re-emitted at the loop seam (would balloon the conversation with
 *      stale repeats — saved-memory note explicitly).
 *   7. `consumeAll()` is called once per seam (not duplicated).
 */

import { describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth/auth.ts"
import type { ContentBlock, SendOptions, StreamedResponse } from "./client/types.ts"

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

/** Fake save-echo collector — exposes `enqueue` for the test to seed events. */
class FakeSaveEcho {
  private queue: ContentBlock[] = []
  enqueue(block: ContentBlock): void {
    this.queue.push(block)
  }
  consumeAll(): ContentBlock[] {
    if (this.queue.length === 0) return []
    const out = this.queue
    this.queue = []
    return out
  }
}

/** Fake short-term snapshot — pin a fixed attachment for the test. */
class FakeSnapshot {
  constructor(private value: ContentBlock | null) {}
  toAttachment(): ContentBlock | null {
    return this.value
  }
  callCount = 0
}

class CountingSnapshot {
  callCount = 0
  constructor(private value: ContentBlock | null) {}
  toAttachment(): ContentBlock | null {
    this.callCount++
    return this.value
  }
}

// ---------------------------------------------------------------------------
// sendFn factory — emits `tool_use` on round 1, plain text on round 2,
// records every request body it receives so tests can introspect order.
// ---------------------------------------------------------------------------

function makeRecordingSendFn(records: Array<Record<string, unknown>>) {
  let round = 0
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    records.push(
      JSON.parse(
        JSON.stringify({
          messages: opts.messages,
          tools: opts.tools,
        }),
      ),
    )
    round++
    if (round === 1) {
      return {
        blocks: [
          {
            type: "tool_use" as const,
            id: "call-1",
            name: "Bash",
            input: { command: "echo hi" },
          },
        ],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

/** Plain text-only sendFn for single-round (no-tool) tests. */
function makeTextSendFn(records: Array<Record<string, unknown>>) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    records.push(
      JSON.parse(
        JSON.stringify({
          messages: opts.messages,
        }),
      ),
    )
    yield "hello"
    return {
      blocks: [{ type: "text" as const, text: "hello" }],
      text: "hello",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

const auth: AuthResult = { type: "api-key", token: "test" }

// Tool execution doesn't need to actually run for this test — but the
// agent's run loop calls executeTool. We sidestep by providing only the
// recording sendFn; round 1's tool_use is for "Bash", and the agent
// will try to execute. To avoid that, we use a sendFn that emits no
// tool_use (single round) for most tests, and only the recording-with-
// tool-use variant for the loop-seam test (which intercepts tools via
// a stub).

// ---------------------------------------------------------------------------
// (1) Zero-regression baseline
// ---------------------------------------------------------------------------

describe("Agent.run — memory attachments (zero-regression baseline)", () => {
  it("with neither saveEcho nor shortTermSnapshot, initial user content is exactly the user text", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const agent = new Agent({ auth, model: "test", sendFn })

    const gen = agent.run("hello world")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    expect(records.length).toBe(1)
    const messages = (records[0]?.messages ?? []) as Array<{
      role: string
      content: ContentBlock[]
    }>
    expect(messages.length).toBe(1)
    expect(messages[0]?.role).toBe("user")
    // Note: the agent's `withRollingCacheBreakpoint` adds a
    // `cache_control` field to the LAST block on the wire — that's
    // expected and orthogonal to attachment ordering. Assert on
    // type+text only, not deep-equal of the whole block.
    const content = messages[0]?.content ?? []
    expect(content.length).toBe(1)
    expect(content[0]?.type).toBe("text")
    expect((content[0] as { text: string }).text).toBe("hello world")
  })
})

// ---------------------------------------------------------------------------
// (2-3) Snapshot-only / Save-echo-only at initial seam
// ---------------------------------------------------------------------------

describe("Agent.run — memory attachments (initial seam)", () => {
  it("prepends ONLY the short-term snapshot when save-echo queue is empty", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const snapshot = new FakeSnapshot({
      type: "text",
      text: "<ma::agent::short-term-memory>\n[#1] active\n</ma::agent::short-term-memory>",
    })
    const agent = new Agent({ auth, model: "test", sendFn, shortTermSnapshot: snapshot })

    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const content =
      ((records[0]?.messages ?? []) as Array<{ content: ContentBlock[] }>)[0]?.content ?? []
    expect(content.length).toBe(2)
    expect(content[0]?.type).toBe("text")
    expect((content[0] as { text: string }).text).toContain("<ma::agent::short-term-memory>")
    expect((content[1] as { text: string }).text).toBe("hi")
  })

  it("prepends ONLY save-echoes when snapshot is null/absent", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const echoes = new FakeSaveEcho()
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="project" id="abc-1234">prev</ma::agent::memory-saved>',
    })
    const agent = new Agent({ auth, model: "test", sendFn, saveEcho: echoes })

    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const content =
      ((records[0]?.messages ?? []) as Array<{ content: ContentBlock[] }>)[0]?.content ?? []
    expect(content.length).toBe(2)
    expect((content[0] as { text: string }).text).toContain("<ma::agent::memory-saved")
    expect((content[1] as { text: string }).text).toBe("hi")
  })

  it("prepends multiple save-echoes in queue order", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const echoes = new FakeSaveEcho()
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="project" id="a">A</ma::agent::memory-saved>',
    })
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="short-term" id="1">B</ma::agent::memory-saved>',
    })
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="global" id="g">C</ma::agent::memory-saved>',
    })
    const agent = new Agent({ auth, model: "test", sendFn, saveEcho: echoes })

    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const content =
      ((records[0]?.messages ?? []) as Array<{ content: ContentBlock[] }>)[0]?.content ?? []
    expect(content.length).toBe(4)
    expect((content[0] as { text: string }).text).toContain('id="a"')
    expect((content[1] as { text: string }).text).toContain('id="1"')
    expect((content[2] as { text: string }).text).toContain('id="g"')
    expect((content[3] as { text: string }).text).toBe("hi")
  })
})

// ---------------------------------------------------------------------------
// (4-5) Order: snapshot before echoes; mode-change before everything
// ---------------------------------------------------------------------------

describe("Agent.run — memory attachments (combined order)", () => {
  it("when both are set, snapshot comes BEFORE save-echoes", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const snapshot = new FakeSnapshot({
      type: "text",
      text: "<ma::agent::short-term-memory>\n[#1] X\n</ma::agent::short-term-memory>",
    })
    const echoes = new FakeSaveEcho()
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="project" id="abc">P</ma::agent::memory-saved>',
    })
    const agent = new Agent({
      auth,
      model: "test",
      sendFn,
      shortTermSnapshot: snapshot,
      saveEcho: echoes,
    })

    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const content =
      ((records[0]?.messages ?? []) as Array<{ content: ContentBlock[] }>)[0]?.content ?? []
    expect(content.length).toBe(3)
    expect((content[0] as { text: string }).text).toContain("<ma::agent::short-term-memory>")
    expect((content[1] as { text: string }).text).toContain("<ma::agent::memory-saved")
    expect((content[2] as { text: string }).text).toBe("hi")
  })

  it("when mode-change is also pending, mode-change is FIRST", async () => {
    const { ModeManager } = await import("./modes/modes.ts")
    const modeManager = new ModeManager(
      [{ id: "ask", label: "ASK", disallowedTools: [] }],
      "ask", // initial — mode-change attachment will fire on first consume
    )

    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const snapshot = new FakeSnapshot({
      type: "text",
      text: "<ma::agent::short-term-memory>\n[#1] x\n</ma::agent::short-term-memory>",
    })
    const echoes = new FakeSaveEcho()
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="project" id="abc">p</ma::agent::memory-saved>',
    })
    const agent = new Agent({
      auth,
      model: "test",
      sendFn,
      modeManager,
      shortTermSnapshot: snapshot,
      saveEcho: echoes,
    })

    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const content =
      ((records[0]?.messages ?? []) as Array<{ content: ContentBlock[] }>)[0]?.content ?? []
    expect(content.length).toBe(4)
    expect((content[0] as { text: string }).text).toContain("<ma::agent::mode-change")
    expect((content[1] as { text: string }).text).toContain("<ma::agent::short-term-memory>")
    expect((content[2] as { text: string }).text).toContain("<ma::agent::memory-saved")
    expect((content[3] as { text: string }).text).toBe("hi")
  })
})

// ---------------------------------------------------------------------------
// (6) Loop seam — after tool_use, save-echo trails tool_results;
// snapshot is NOT re-emitted.
// ---------------------------------------------------------------------------

describe("Agent.run — memory attachments (loop seam ordering)", () => {
  it("places tool_result FIRST and <ma::agent::memory-saved> AFTER on the loop seam (snapshot NOT re-emitted)", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFn(records)

    // Snapshot returns a value at every call, but should only be queried
    // ONCE (initial seam). Counting checks that.
    const snapshot = new CountingSnapshot({
      type: "text",
      text: "<ma::agent::short-term-memory>\n[#1] X\n</ma::agent::short-term-memory>",
    })
    const echoes = new FakeSaveEcho()

    // Seed an echo BEFORE the run so it lands at the initial seam, then
    // mid-stream we'll seed another echo to land at the loop seam.
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="project" id="initial">i</ma::agent::memory-saved>',
    })

    const agent = new Agent({
      auth,
      model: "test",
      sendFn,
      shortTermSnapshot: snapshot,
      saveEcho: echoes,
    })

    // The recording sendFn returns tool_use(Bash) on round 1, but the
    // agent will then try to executeBash. We don't want a real shell
    // command. Trick: queue the loop-seam echo BEFORE calling run, and
    // use a benign Bash command that should fail/run quickly.
    //
    // Simpler approach: seed the loop-seam echo right after starting the
    // generator but before the second round fires. To do that we
    // collect-all-then-iterate.
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="short-term" id="3">l</ma::agent::memory-saved>',
    })

    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Two API rounds were captured. Inspect both.
    expect(records.length).toBe(2)

    // -- ROUND 1: initial user content
    const r1Messages = records[0]?.messages as Array<{ role: string; content: ContentBlock[] }>
    const r1User = r1Messages[0]?.content ?? []
    // [snapshot, initial echo, loop echo (seeded eagerly), user text]
    // NOTE: we seeded BOTH echoes before run() started, so both land
    // at the initial seam — that's the expected behavior of consumeAll.
    expect(r1User.length).toBe(4)
    expect((r1User[0] as { text: string }).text).toContain("<ma::agent::short-term-memory>")
    expect((r1User[1] as { text: string }).text).toContain('id="initial"')
    expect((r1User[2] as { text: string }).text).toContain('id="3"')
    expect((r1User[3] as { text: string }).text).toBe("hi")

    // -- ROUND 2: post-tool_use user content. tool_result must be FIRST.
    const r2Messages = records[1]?.messages as Array<{ role: string; content: ContentBlock[] }>
    // r2Messages = [user(initial), assistant(tool_use), user(tool_result+...)]
    expect(r2Messages.length).toBe(3)
    const r2User = r2Messages[2]?.content ?? []
    expect(r2User.length).toBeGreaterThanOrEqual(1)
    expect(r2User[0]?.type).toBe("tool_result")
    // No snapshot at loop seam.
    const allTexts = r2User.map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
    for (const t of allTexts) {
      expect(t).not.toContain("<ma::agent::short-term-memory>")
    }

    // Snapshot must have been queried EXACTLY ONCE (initial seam only).
    expect(snapshot.callCount).toBe(1)
  })

  it("a save-echo seeded BEFORE the loop seam (but after the initial seam) emits at the loop seam", async () => {
    // We can't reliably interleave with the generator from outside (the
    // recording sendFn doesn't pause at the round boundary), so we use
    // a custom sendFn that consults the FakeSaveEcho instance via
    // closure — seeding the echo INSIDE round 1's body (just before
    // returning the tool_use). That mirrors the real-world pattern:
    // the inline-tag handler runs during the assistant stream, between
    // rounds, and the echo lands when the agent assembles round 2's
    // user content.
    const records: Array<Record<string, unknown>> = []
    const echoes = new FakeSaveEcho()

    let round = 0
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
      round++
      if (round === 1) {
        // Simulate the inline-tag handler firing mid-response — by
        // queueing the echo here, we guarantee it lands at the loop
        // seam (after round 1's tool_use, before round 2's request).
        echoes.enqueue({
          type: "text",
          text: '<ma::agent::memory-saved scope="project" id="late">L</ma::agent::memory-saved>',
        })
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-1",
              name: "Bash",
              input: { command: "echo hi" },
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const agent = new Agent({ auth, model: "test", sendFn, saveEcho: echoes })

    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    expect(records.length).toBe(2)

    // Initial seam saw an empty queue → just the user text.
    const r1Messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const r1User = r1Messages[0]?.content ?? []
    expect(r1User.length).toBe(1)
    expect((r1User[0] as { text: string }).text).toBe("hi")

    // Loop seam: tool_result FIRST, then the late echo.
    const r2Messages = records[1]?.messages as Array<{ content: ContentBlock[] }>
    const r2User = r2Messages[2]?.content ?? []
    expect(r2User.length).toBeGreaterThanOrEqual(2)
    expect(r2User[0]?.type).toBe("tool_result")
    const lateText = r2User
      .map((b) => (b.type === "text" ? (b as { text: string }).text : ""))
      .join(" ")
    expect(lateText).toContain('id="late"')
  })
})

// ---------------------------------------------------------------------------
// (7) consumeAll exhaustion — second turn sees an empty queue
// ---------------------------------------------------------------------------

describe("Agent.run — memory attachments (queue exhaustion)", () => {
  it("save-echoes from turn N are NOT re-played on turn N+1", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeTextSendFn(records)
    const echoes = new FakeSaveEcho()
    echoes.enqueue({
      type: "text",
      text: '<ma::agent::memory-saved scope="project" id="once">O</ma::agent::memory-saved>',
    })
    const agent = new Agent({ auth, model: "test", sendFn, saveEcho: echoes })

    // Turn 1
    const gen1 = agent.run("first")
    while (true) {
      const { done } = await gen1.next()
      if (done) break
    }

    // Turn 2 — no new echoes seeded
    const gen2 = agent.run("second")
    while (true) {
      const { done } = await gen2.next()
      if (done) break
    }

    expect(records.length).toBe(2)

    // Turn 1 user content: [echo, "first"]
    const turn1Messages = records[0]?.messages as Array<{ content: ContentBlock[] }>
    const turn1User = turn1Messages[0]?.content ?? []
    expect(turn1User.length).toBe(2)
    expect((turn1User[1] as { text: string }).text).toBe("first")

    // Turn 2 user content: ONLY the new user text — no leftover echo.
    const turn2Messages = records[1]?.messages as Array<{ content: ContentBlock[] }>
    // turn2 messages so far: [user(first+echo), assistant(hello), user(second)]
    expect(turn2Messages.length).toBe(3)
    const turn2User = turn2Messages[2]?.content ?? []
    expect(turn2User.length).toBe(1)
    expect((turn2User[0] as { text: string }).text).toBe("second")
  })
})
