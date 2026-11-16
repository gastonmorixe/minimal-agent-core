/**
 * Unit tests for shared context-compaction helpers (Agent + AgentCore).
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { SyntheticFacts, SyntheticKind } from "../../plugin-api/src/types/synthetic-text.ts"
import type { Message } from "../llm/messages.ts"
import { COMPACT_TEST_TEXT } from "../test-utils/compact-test-text.ts"
import { SIBLING_REPO_ROOT } from "../test-utils/sibling-repo.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import {
  buildLocalCompactMessages,
  buildReplacementHistory,
  buildTailCompactMessages,
  COMPACTION_USER_MARKER,
  compactFocusFacts,
  extractPendingUserText,
  flattenHistoryForSummary,
  replaceMessagesInPlace,
} from "./context-compact.ts"

describe("replaceMessagesInPlace", () => {
  it("clears and repopulates the same array reference", () => {
    const messages: Message[] = [{ role: "user", content: "a" }]
    const next: Message[] = [
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
    ]
    replaceMessagesInPlace(messages, next)
    expect(messages).toEqual(next)
    expect(messages.length).toBe(2)
  })
})

describe("buildReplacementHistory", () => {
  it("maps portable rows to block-shaped Message[]", () => {
    const out = buildReplacementHistory([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ])
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ])
  })
})

describe("buildLocalCompactMessages", () => {
  it("prepends a checkpoint and keeps a short tail", () => {
    const previous: Message[] = []
    for (let i = 0; i < 20; i++) {
      previous.push({ role: "user", content: `u${i}` })
      previous.push({ role: "assistant", content: `a${i}` })
    }
    const next = buildLocalCompactMessages({
      previous,
      summaryText: "Did the thing.",
      keepTail: 4,
      text: COMPACT_TEST_TEXT,
    })
    expect(next.length).toBe(5) // checkpoint + 4
    const first = next[0]
    expect(first.role).toBe("user")
    const text =
      typeof first.content === "string"
        ? first.content
        : first.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(text).toContain(COMPACTION_USER_MARKER)
    expect(text).toContain("Did the thing.")
  })

  it("does not start tail mid unpaired tool_use", () => {
    const previous: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
      { role: "user", content: "later" },
    ]
    const next = buildLocalCompactMessages({ previous, keepTail: 2 })
    // Leading unpaired tool_use assistant is dropped; user remains after checkpoint.
    expect(next.some((m) => m.role === "assistant")).toBe(false)
    expect(next.some((m) => m.role === "user" && JSON.stringify(m.content).includes("later"))).toBe(
      true,
    )
  })

  it("drops a trailing tool_use with no matching tool_result in the tail", () => {
    const previous: Message[] = [
      { role: "user", content: "u0" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "out1" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } }],
      },
    ]
    const next = buildLocalCompactMessages({ previous, keepTail: 1 })
    // Tail is just the dangling call, so only the checkpoint remains.
    expect(next.length).toBe(1)
    expect(next.some((m) => m.role === "assistant")).toBe(false)
  })

  it("shifts a leading orphan tool_result whose call was cut off", () => {
    const previous: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t0", content: "out0" }],
      },
      { role: "user", content: "later" },
    ]
    const next = buildLocalCompactMessages({ previous, keepTail: 2 })
    // Orphan tool_result is shifted; plain user text remains after checkpoint.
    expect(next.some((m) => JSON.stringify(m.content).includes("tool_result"))).toBe(false)
    expect(next.some((m) => m.role === "user" && JSON.stringify(m.content).includes("later"))).toBe(
      true,
    )
  })

  it("keeps intact tool_use/tool_result pairs in the tail", () => {
    const previous: Message[] = [
      { role: "user", content: "u0" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "out1" }],
      },
      { role: "user", content: "later" },
    ]
    const next = buildLocalCompactMessages({ previous, keepTail: 3 })
    expect(next.some((m) => JSON.stringify(m.content).includes('"id":"t1"'))).toBe(true)
    expect(next.some((m) => JSON.stringify(m.content).includes('"tool_use_id":"t1"'))).toBe(true)
    expect(next.some((m) => m.role === "user" && JSON.stringify(m.content).includes("later"))).toBe(
      true,
    )
  })
})

describe("extractPendingUserText", () => {
  it("returns trailing plain user text", () => {
    const messages: Message[] = [
      { role: "assistant", content: "ok" },
      { role: "user", content: "retry me" },
    ]
    expect(extractPendingUserText(messages)).toBe("retry me")
  })

  it("returns null for tool_result tails", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }],
      },
    ]
    expect(extractPendingUserText(messages)).toBeNull()
  })
})

describe("flattenHistoryForSummary", () => {
  it("includes roles and respects maxChars", () => {
    const messages: Message[] = [
      { role: "user", content: "hello world" },
      { role: "assistant", content: "hi" },
    ]
    const flat = flattenHistoryForSummary(messages, 10_000)
    expect(flat).toContain("USER:")
    expect(flat).toContain("hello world")
    const tiny = flattenHistoryForSummary(messages, 20)
    expect(tiny.length).toBeLessThanOrEqual(40)
  })
})

/** The checkpoint text of a rewrite (first message, text blocks joined). */
function checkpointOf(msgs: Message[]): string {
  const first = msgs[0]
  if (typeof first.content === "string") return first.content
  return first.content.map((b) => (b.type === "text" ? b.text : "")).join("")
}

/** A resolver that records each call and answers with the stub tag. */
function recordingResolver() {
  const calls: Array<{ kind: SyntheticKind; facts: SyntheticFacts }> = []
  return {
    calls,
    resolve(kind: SyntheticKind, facts: SyntheticFacts) {
      calls.push({ kind, facts })
      return COMPACT_TEST_TEXT.resolve(kind, facts)
    },
  }
}

function plainHistory(n: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` })
  }
  return out
}

describe("compaction checkpoints use the synthetic text resolver (15d.3b)", () => {
  it("no text: the checkpoint is the tag line only (tail and local)", () => {
    const prev = plainHistory(3)
    expect(checkpointOf(buildTailCompactMessages(prev, 1))).toBe(
      `${COMPACTION_USER_MARKER} kind="tail" />`,
    )
    expect(checkpointOf(buildLocalCompactMessages({ previous: prev, keepTail: 1 }))).toBe(
      `${COMPACTION_USER_MARKER} kind="local" />`,
    )
  })

  it("R1: retained is the actual tail length, not keepTail", () => {
    const r = recordingResolver()
    const next = buildTailCompactMessages(plainHistory(5), 10, r)
    expect(next.length).toBe(6)
    expect(r.calls).toEqual([{ kind: "compact.tail_checkpoint", facts: { retained: 5 } }])
    // A tool-pair trim shrinks the tail below keepTail too.
    const r2 = recordingResolver()
    const dangling: Message[] = [
      { role: "user", content: "u0" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } }],
      },
    ]
    buildTailCompactMessages(dangling, 2, r2)
    expect(r2.calls[0]?.facts).toEqual({ retained: 1 })
  })

  it("R2: summary and focus reach the plugin trimmed, and blank values are absent", () => {
    const r = recordingResolver()
    const prev = plainHistory(5)
    buildLocalCompactMessages({ previous: prev, summaryText: " SUM \n", focus: " f ", text: r })
    buildLocalCompactMessages({ previous: prev, summaryText: " ", focus: " f ", text: r })
    buildLocalCompactMessages({ previous: prev, summaryText: " SUM \n", focus: "   ", text: r })
    expect(r.calls).toEqual([
      { kind: "compact.local_checkpoint", facts: { focus: "f", summary: "SUM" } },
      { kind: "compact.local_checkpoint", facts: { focus: "f" } },
      { kind: "compact.local_checkpoint", facts: { summary: "SUM" } },
    ])
    expect(compactFocusFacts(" f ")).toEqual({ focus: "f" })
    expect(compactFocusFacts("   ")).toEqual({})
    expect(compactFocusFacts(undefined)).toEqual({})
  })
})

/** The plugins' parity fixture: today's (pre-15d.3b) core bytes for every case. */
interface CompactFixture {
  marker: string
  entries: Array<{
    proposedKind: SyntheticKind
    cases: Array<{ args: unknown; facts: SyntheticFacts; text?: string; fullText?: string }>
  }>
}
const FIXTURE_PATH = join(SIBLING_REPO_ROOT, "tests", "text-parity", "fixtures", "compact.json")

describe.skipIf(!textFixturesPresent() || !existsSync(FIXTURE_PATH))(
  "compaction text bytes through the real provider (ma-turn-recovery-plugin)",
  () => {
    const marker = COMPACTION_USER_MARKER
    const stub =
      "The harness compacted the prior conversation locally. Continue from the retained recent turns below."

    it("R2 bytes: padded summary/focus and a blank summary equal the pre-15d.3b output", () => {
      const text = fixtureSyntheticTextResolver()
      const prev = plainHistory(5)
      const padded = buildLocalCompactMessages({
        previous: prev,
        summaryText: " SUM \n",
        focus: " f ",
        keepTail: 2,
        text,
      })
      expect(checkpointOf(padded)).toBe(
        `${marker} kind="local" />\n## Context checkpoint\n\nFocus (verbatim): f\n\nSUM`,
      )
      const blank = buildLocalCompactMessages({
        previous: prev,
        summaryText: " ",
        focus: " f ",
        keepTail: 2,
        text,
      })
      expect(checkpointOf(blank)).toBe(
        `${marker} kind="local" />\n## Context checkpoint\n\nFocus (verbatim): f\n\n${stub}`,
      )
      const blankFocus = buildLocalCompactMessages({
        previous: prev,
        summaryText: " SUM \n",
        focus: "   ",
        text,
      })
      expect(checkpointOf(blankFocus)).toBe(
        `${marker} kind="local" />\n## Context checkpoint\n\nSUM`,
      )
      const summarySystem = (focus: string | undefined) =>
        text.resolve("compact.summary_system", compactFocusFacts(focus))
      expect(summarySystem(" f ")).toBe(
        `${summarySystem(undefined)}\n\nFocus for this compaction (verbatim): f`,
      )
      expect(summarySystem("   ")).toBe(summarySystem(undefined))
    })

    it("R1 bytes: keepTail=10 on a 5-message history says 5", () => {
      const next = buildTailCompactMessages(plainHistory(5), 10, fixtureSyntheticTextResolver())
      expect(checkpointOf(next)).toBe(
        `${marker} kind="tail" />\n## Context checkpoint\n\nThe harness kept the last 5 message(s) verbatim. It dropped the older history.`,
      )
    })

    it("every parity fixture case is byte-equal through the core builders", () => {
      const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as CompactFixture
      expect(fixture.marker).toBe(marker)
      const text = fixtureSyntheticTextResolver()
      let checked = 0
      for (const entry of fixture.entries) {
        for (const c of entry.cases) {
          if (entry.proposedKind === "compact.summary_system") {
            const [focus] = c.args as [string?]
            expect(text.resolve(entry.proposedKind, compactFocusFacts(focus))).toBe(
              c.text as string,
            )
          } else if (entry.proposedKind === "compact.tail_checkpoint") {
            const a = c.args as { previousLength: number; keepTail: number }
            const got = buildTailCompactMessages(plainHistory(a.previousLength), a.keepTail, text)
            expect(checkpointOf(got)).toBe(c.fullText as string)
          } else {
            const a = c.args as { summaryText?: string; focus?: string }
            const got = buildLocalCompactMessages({ previous: plainHistory(2), ...a, text })
            expect(checkpointOf(got)).toBe(c.fullText as string)
          }
          checked++
        }
      }
      expect(checked).toBe(12)
    })
  },
)
