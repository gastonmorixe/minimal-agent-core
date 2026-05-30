import { describe, expect, it } from "bun:test"

import { TagScanner, type TagSpan } from "./scanner.ts"

interface CollectedEvents {
  text: string[]
  tags: TagSpan[]
}

function drive(chunks: string[], maxSpanBytes?: number): CollectedEvents {
  const events: CollectedEvents = { text: [], tags: [] }
  const scanner = new TagScanner({
    onText: (t) => events.text.push(t),
    onTag: (s) => events.tags.push(s),
    maxSpanBytes,
  })
  for (const c of chunks) scanner.write(c)
  scanner.end()
  return events
}

describe("TagScanner", () => {
  it("passes plain text through unchanged", () => {
    const e = drive(["hello ", "world"])
    expect(e.text.join("")).toBe("hello world")
    expect(e.tags).toHaveLength(0)
  })

  it("detects a self-closing tag", () => {
    const e = drive(["before ", '<ma::emit::spinner label="build" />', " after"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("spinner")
    expect(e.tags[0].attrs).toEqual({ label: "build" })
    expect(e.tags[0].body).toBe("")
    expect(e.tags[0].self_closing).toBe(true)
    expect(e.text.join("")).toBe("before  after")
  })

  it("detects a self-closing tag with no attrs", () => {
    const e = drive(["x<ma::emit::ping />y"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("ping")
    expect(e.tags[0].attrs).toEqual({})
    expect(e.tags[0].self_closing).toBe(true)
    expect(e.text.join("")).toBe("xy")
  })

  it("detects a tag with body and matching close", () => {
    const e = drive(["<ma::emit::diff>some body</ma::emit::diff>"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("diff")
    expect(e.tags[0].body).toBe("some body")
    expect(e.tags[0].self_closing).toBe(false)
  })

  it("detects an opener that spans two chunks", () => {
    const e = drive(["prefix <ma::emit::cha", 'rt type="bar">payload</ma::emit::chart>!'])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("chart")
    expect(e.tags[0].attrs).toEqual({ type: "bar" })
    expect(e.tags[0].body).toBe("payload")
    expect(e.text.join("")).toBe("prefix !")
  })

  it("detects a close that spans two chunks", () => {
    const e = drive(["<ma::emit::diff>body</ma::em", "it::diff> tail"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].body).toBe("body")
    expect(e.text.join("")).toBe(" tail")
  })

  it("parses single-quoted attributes", () => {
    const e = drive(["<ma::emit::t a='one' b=\"two\" />"])
    expect(e.tags[0].attrs).toEqual({ a: "one", b: "two" })
  })

  it("supports minimal escapes in attribute values", () => {
    const e = drive(['<ma::emit::t a="a\\"b" c=\'d\\nE\' />'])
    expect(e.tags[0].attrs.a).toBe('a"b')
    expect(e.tags[0].attrs.c).toBe("d\nE")
  })

  it("honors the escape form backslash-lt-tui-colon-colon", () => {
    const e = drive(["literal \\<ma::emit::foo /> kept"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("literal <ma::emit::foo /> kept")
  })

  it("flushes plain text before an opener", () => {
    const e = drive(["some text <ma::emit::x />more"])
    expect(e.text.join("")).toBe("some text more")
    expect(e.tags).toHaveLength(1)
  })

  it("falls back to raw text when span exceeds maxSpanBytes", () => {
    const big = "x".repeat(1000)
    const e = drive([`<ma::emit::diff>${big}`], 100)
    expect(e.tags).toHaveLength(0)
    // The raw, un-dispatched text should end up on the text channel.
    expect(e.text.join("")).toContain("<ma::emit::diff>")
    expect(e.text.join("")).toContain(big)
  })

  it("falls back to raw text when the stream ends mid-capture", () => {
    const e = drive(["<ma::emit::diff>unterminated body"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("<ma::emit::diff>unterminated body")
  })

  it("falls back to raw text when the closer name doesn't match the opener", () => {
    // Regression: only `</ma::emit::NAME>` exactly matching the opener closes a
    // capture. A differently-named closer is just more body content, so the
    // capture runs to end-of-stream and falls back to raw flush — same code
    // path as the no-closer-at-all case above, but a distinct authoring
    // mistake worth documenting. Real instance: a memory tag closed with
    // `</thinking>` (the older Anthropic scratchpad pattern) instead of
    // `</ma::emit::memory>` flushed the body to the terminal but skipped the save.
    const e = drive(["<ma::emit::memory>save me</thinking> trailing"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("<ma::emit::memory>save me</thinking> trailing")
  })

  it("handles nested different-name tags by capturing the outer raw body", () => {
    const e = drive(["<ma::emit::outer><ma::emit::inner /></ma::emit::outer>"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("outer")
    expect(e.tags[0].body).toBe("<ma::emit::inner />")
  })

  it("closes on first same-name close (accepted limitation)", () => {
    // Outer has body containing a same-name tag. The scanner does not track
    // nesting depth, so the first </ma::emit::same> closes the outer capture.
    const e = drive(["<ma::emit::same>inner<ma::emit::same/>tail</ma::emit::same>"])
    // The first "<ma::emit::same>" opens. Inside body, another self-closing
    // "<ma::emit::same/>" does not terminate because it has a slash-gt, not a
    // closing tag form. The first "</ma::emit::same>" is the real outer close.
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].body).toBe("inner<ma::emit::same/>tail")
  })

  it("emits multiple tags in a single stream", () => {
    const e = drive(["a<ma::emit::x />b<ma::emit::y>B</ma::emit::y>c"])
    expect(e.tags).toHaveLength(2)
    expect(e.tags[0].name).toBe("x")
    expect(e.tags[1].name).toBe("y")
    expect(e.text.join("")).toBe("abc")
  })

  it("streams text even when a dangling partial-opener prefix is in the tail", () => {
    // After the first chunk ends with '<tu', the scanner must hold it because
    // it could be the start of an opener. When the second chunk arrives as
    // plain text, the tail is flushed intact.
    const e = drive(["plain <tu", "rbulent waters"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("plain <turbulent waters")
  })

  it("preserves body bytes exactly, including whitespace and newlines", () => {
    const body = "\nline one\n  line two\n"
    const e = drive([`<ma::emit::pre>${body}</ma::emit::pre>`])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].body).toBe(body)
  })

  it("raw span on the tag event contains the full opener and closer", () => {
    const e = drive(['<ma::emit::x k="v">body</ma::emit::x>'])
    expect(e.tags[0].raw).toBe('<ma::emit::x k="v">body</ma::emit::x>')
  })

  it("raw span for self-closing tag is the opener alone", () => {
    const e = drive(['<ma::emit::x k="v" />'])
    expect(e.tags[0].raw).toBe('<ma::emit::x k="v" />')
  })

  // ---------------------------------------------------------------------
  // Markdown code-context regression tests
  //
  // The scanner used to greedily match `<ma::emit::NAME>` anywhere in the
  // stream, even inside backticked inline code or fenced blocks. That
  // broke mdstream's table renderer when a row cell contained something
  // like `` `<ma::emit::diff>` `` — the scanner started buffering, mdstream's
  // table state was wrecked, and the rest of the table fell through to
  // raw markdown. Symptom captured in the user's table-rendering report.
  // ---------------------------------------------------------------------

  it("ignores <ma::emit:: openers inside single-backtick inline code", () => {
    const e = drive(["see `<ma::emit::diff>` for details"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("see `<ma::emit::diff>` for details")
  })

  it("ignores <ma::emit:: closers inside inline code too", () => {
    const e = drive(["wraps `</ma::emit::diff>` literally"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("wraps `</ma::emit::diff>` literally")
  })

  it("regression: table cell with backticked tag plus following rows", () => {
    // Mirrors the exact user-reported failure: a table cell containing
    // `<ma::emit::diff>` followed by more table rows. The scanner must not
    // start a capture, so mdstream's table parser sees clean input.
    const md =
      "| Plugin | Notes |\n| --- | --- |\n| diff-view | `<ma::emit::diff>` |\n| memory | tag |\n"
    const e = drive([md])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe(md)
  })

  it("ignores <ma::emit:: openers inside double-backtick inline code", () => {
    const e = drive(["``a `<ma::emit::x />` b``"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("``a `<ma::emit::x />` b``")
  })

  it("re-enables tag detection after an inline code span closes", () => {
    const e = drive(["`<ma::emit::a />` then <ma::emit::b />"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("b")
    expect(e.text.join("")).toBe("`<ma::emit::a />` then ")
  })

  it("ignores <ma::emit:: openers inside a fenced code block (backticks)", () => {
    const md = "```\n<ma::emit::diff>body</ma::emit::diff>\n```\nafter"
    const e = drive([md])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe(md)
  })

  it("ignores <ma::emit:: openers inside a fenced code block (tildes)", () => {
    const md = "~~~\n<ma::emit::diff>body</ma::emit::diff>\n~~~\nafter"
    const e = drive([md])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe(md)
  })

  it("re-enables tag detection after a fenced code block closes", () => {
    const md = "```\n<ma::emit::a />\n```\n<ma::emit::b />"
    const e = drive([md])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("b")
  })

  it("handles inline code split across chunk boundaries", () => {
    // Backtick run at end of chunk is held until classification is known.
    const e = drive(["pre `", "<ma::emit::x />` post"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("pre `<ma::emit::x />` post")
  })

  it("handles fence opener split across chunk boundaries", () => {
    // Three backticks at line start could be a fence; the partial run
    // must be held until the third backtick arrives.
    const e = drive(["``", "`\n<ma::emit::x />\n```\n"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("```\n<ma::emit::x />\n```\n")
  })

  it("a backtick mid-line does NOT open a fence", () => {
    // Fence detection only triggers at line start.
    const e = drive(["text ``` more <ma::emit::x />"])
    // Three backticks mid-line open a 3-tick inline code span; the tag
    // inside is suppressed; the span is unterminated so it stays open
    // until end-of-stream (still text).
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("text ``` more <ma::emit::x />")
  })

  it("a fenced block whose close fence is longer than the open still closes", () => {
    const md = "```\nbody <ma::emit::x />\n````\nafter <ma::emit::y />"
    const e = drive([md])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("y")
  })

  it("does NOT close a 3-backtick fence with a 2-backtick run", () => {
    const md = "```\n``\n<ma::emit::x />\n```\n"
    const e = drive([md])
    expect(e.tags).toHaveLength(0)
  })
})
