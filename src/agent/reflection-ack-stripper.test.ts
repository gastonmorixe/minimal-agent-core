import { describe, expect, test } from "bun:test"

import { createReflectionAckStripper } from "./reflection-ack-stripper.ts"

/**
 * Helper: feed an array of chunks (simulating SSE deltas) and collect
 * the cleaned output. Always calls `flush()` at the end so we observe
 * any held-back tail.
 */
function feedAll(chunks: string[]): string {
  const s = createReflectionAckStripper()
  let out = ""
  for (const c of chunks) out += s.write(c)
  out += s.flush()
  return out
}

describe("createReflectionAckStripper — passthrough", () => {
  test("empty input → empty output", () => {
    expect(feedAll([""])).toBe("")
  })

  test("no tag → passthrough verbatim", () => {
    expect(feedAll(["hello world"])).toBe("hello world")
  })

  test("multi-chunk plain text → concatenated verbatim", () => {
    expect(feedAll(["hello ", "world", "\nfoo"])).toBe("hello world\nfoo")
  })

  test("`<ma::` substring in unrelated context passes through", () => {
    // A `<ma::tasks>` reference or any non-reflection-ack `<ma::` text
    // must not be touched — the stripper is specifically scoped.
    expect(feedAll(["see <ma::tasks> for tracking"])).toBe("see <ma::tasks> for tracking")
  })

  test("`<ma::emit::` tags are unaffected (handled by the inline-tag scanner elsewhere)", () => {
    expect(feedAll(["<ma::emit::diff>--- a\n+++ b\n</ma::emit::diff>"])).toBe(
      "<ma::emit::diff>--- a\n+++ b\n</ma::emit::diff>",
    )
  })
})

describe("createReflectionAckStripper — single-chunk strips", () => {
  test("bare tag with no attrs", () => {
    expect(feedAll(["<ma::agent::reflection-ack/>"])).toBe("")
  })

  test("tag with silence-for only", () => {
    expect(feedAll(['<ma::agent::reflection-ack silence-for="3" />'])).toBe("")
  })

  test("tag with reason only", () => {
    expect(feedAll(['<ma::agent::reflection-ack reason="batch refactor" />'])).toBe("")
  })

  test("tag with both attrs", () => {
    expect(feedAll(['<ma::agent::reflection-ack silence-for="2" reason="batch ops" />'])).toBe("")
  })

  test("attrs in reversed order", () => {
    expect(feedAll(['<ma::agent::reflection-ack reason="X" silence-for="5" />'])).toBe("")
  })

  test("tag alone on its own line — leaves surrounding newlines for capBlankLines to bound", () => {
    // We deliberately do not consume surrounding `\n`s here. The
    // compositor's `capBlankLines` enforces a max of 2 blank rows in
    // scrollback, so the rendered result is at-most-one-extra blank row.
    // Doing better safely requires cross-chunk lookback both before and
    // after the tag (preserving `prose\n<tag>\nmore` → `prose\n\nmore`).
    expect(feedAll(['prose\n\n<ma::agent::reflection-ack silence-for="2" />\nmore'])).toBe(
      "prose\n\n\nmore",
    )
  })

  test("tag flanked by single newlines does not smash adjacent prose", () => {
    // Regression guard for the alternative-policy hazard: a regex with
    // `\n?` trailing consume would turn this into "prose\nmore"
    // (no blank row between paragraphs). Keep this case clean.
    expect(feedAll(['prose\n<ma::agent::reflection-ack silence-for="1" />\nmore'])).toBe(
      "prose\n\nmore",
    )
  })

  test("tag inline with prose — no trailing newline to consume", () => {
    expect(feedAll(['before <ma::agent::reflection-ack silence-for="1" /> after'])).toBe(
      "before  after",
    )
  })

  test("multiple tags in one chunk both stripped", () => {
    expect(
      feedAll([
        '<ma::agent::reflection-ack silence-for="1" />text<ma::agent::reflection-ack silence-for="2" />',
      ]),
    ).toBe("text")
  })
})

describe("createReflectionAckStripper — cross-chunk splits", () => {
  test("split inside opener prefix", () => {
    // `<ma::agent::ref` arrives in chunk 1, rest of tag in chunk 2. The
    // trailing `\n` passes through per the no-consume policy.
    expect(feedAll(["prose <ma::agent::ref", 'lection-ack silence-for="2" />\n'])).toBe("prose \n")
  })

  test("split at the very start of opener", () => {
    expect(feedAll(["x<", 'ma::agent::reflection-ack silence-for="2" />'])).toBe("x")
  })

  test("split between opener and attrs", () => {
    expect(feedAll(["<ma::agent::reflection-ack", ' silence-for="2" />\n'])).toBe("\n")
  })

  test("split mid-attribute", () => {
    expect(feedAll(['<ma::agent::reflection-ack silence-for="', '2" reason="x" />'])).toBe("")
  })

  test("split between attrs and self-close", () => {
    expect(feedAll(['<ma::agent::reflection-ack silence-for="2"', " />\n"])).toBe("\n")
  })

  test("split right before trailing newline — trailing newline passes through", () => {
    // Per the no-consume policy: the trailing `\n` arriving in the next
    // chunk passes through unchanged. Combined with whatever leading
    // newlines preceded the tag, the compositor caps any excess at 2
    // blank rows in scrollback.
    expect(feedAll(['<ma::agent::reflection-ack silence-for="2" />', "\nmore"])).toBe("\nmore")
  })

  test("split per-byte through the whole tag (worst case)", () => {
    // Simulate the most adversarial delta granularity: one byte per
    // chunk. The stripper must still correctly elide the tag and
    // preserve the surrounding newlines (no smash).
    const full = 'prose\n<ma::agent::reflection-ack silence-for="2" reason="x" />\nmore'
    const chunks = Array.from(full, (ch) => ch)
    expect(feedAll(chunks)).toBe("prose\n\nmore")
  })

  test("partial opener at end of stream → flushed verbatim", () => {
    // A model that emits `<ma::agent::reflection-ack` and then ends the stream
    // without closing the tag should not have its bytes silently dropped.
    // Flush emits whatever's held in the tail.
    const s = createReflectionAckStripper()
    let out = s.write("prose <ma::ref")
    out += s.flush()
    expect(out).toBe("prose <ma::ref")
  })

  test("incomplete tag at end of stream → flushed verbatim", () => {
    // Held a full opener but no `/>` ever arrived.
    expect(feedAll(['prose <ma::agent::reflection-ack silence-for="2"'])).toBe(
      'prose <ma::agent::reflection-ack silence-for="2"',
    )
  })

  test("complete tag exactly at end-of-stream is stripped by flush pass", () => {
    // The final chunk completes the tag with no trailing whitespace.
    // flush() runs one last replace pass to catch this.
    const s = createReflectionAckStripper()
    let out = s.write("hello ")
    out += s.write('<ma::agent::reflection-ack silence-for="2"')
    out += s.write(" />")
    out += s.flush()
    expect(out).toBe("hello ")
  })
})

describe("createReflectionAckStripper — bounded buffer", () => {
  test("held tail beyond MAX_BUFFER flushes verbatim", () => {
    // Build a chunk that starts with an opener and then a very long
    // unclosed runaway. The stripper should give up holding and emit.
    const runaway = "<ma::agent::reflection-ack " + "x".repeat(8192)
    const out = feedAll([runaway])
    // The full runaway should appear in output (bounded-buffer fallback).
    // We don't pin the exact size; just verify it's not silently swallowed
    // and that no `<ma::` prefix is left hanging.
    expect(out.length).toBeGreaterThan(4096)
    expect(out).toContain("<ma::agent::reflection-ack")
    expect(out).toContain("xxx")
  })
})

describe("createReflectionAckStripper — stateful reuse", () => {
  test("instance retains buf state across writes within one stream", () => {
    const s = createReflectionAckStripper()
    expect(s.write("<ma::agent::")).toBe("")
    expect(s.write("reflection-ack ")).toBe("")
    expect(s.write('silence-for="2"')).toBe("")
    // Per the no-consume policy, the trailing `\n` passes through.
    expect(s.write(" />\n")).toBe("\n")
    expect(s.write("done")).toBe("done")
    expect(s.flush()).toBe("")
  })

  test("a fresh instance is independent of any prior one", () => {
    const s1 = createReflectionAckStripper()
    s1.write("<ma::ref") // hold
    const s2 = createReflectionAckStripper()
    // s2 should not see s1's held bytes
    expect(s2.write("hello")).toBe("hello")
  })

  test("write returning empty does not break subsequent writes", () => {
    const s = createReflectionAckStripper()
    expect(s.write("")).toBe("")
    expect(s.write("hello")).toBe("hello")
    expect(s.write("")).toBe("")
    expect(s.flush()).toBe("")
  })
})

describe("createReflectionAckStripper — matches the agent's parser regex", () => {
  // Sanity guard: every tag shape that parseReflectionAck (in agent.ts)
  // matches should also be stripped here. If these two regexes ever drift,
  // the user will see the raw tag in scrollback.
  const samples = [
    "<ma::agent::reflection-ack/>",
    '<ma::agent::reflection-ack silence-for="0" />',
    '<ma::agent::reflection-ack silence-for="99" />',
    '<ma::agent::reflection-ack reason="" />',
    '<ma::agent::reflection-ack reason="a b c — d" />',
    '<ma::agent::reflection-ack silence-for="2" reason="hello" />',
    '<ma::agent::reflection-ack reason="hello" silence-for="2" />',
  ]
  for (const sample of samples) {
    test(`strips ${JSON.stringify(sample)}`, () => {
      expect(feedAll([`a ${sample} b`])).toBe("a  b")
    })
  }
})
