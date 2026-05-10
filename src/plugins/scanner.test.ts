import { describe, it, expect } from "bun:test"
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
    const e = drive(["before ", '<tui::spinner label="build" />', " after"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("spinner")
    expect(e.tags[0].attrs).toEqual({ label: "build" })
    expect(e.tags[0].body).toBe("")
    expect(e.tags[0].self_closing).toBe(true)
    expect(e.text.join("")).toBe("before  after")
  })

  it("detects a self-closing tag with no attrs", () => {
    const e = drive(["x<tui::ping />y"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("ping")
    expect(e.tags[0].attrs).toEqual({})
    expect(e.tags[0].self_closing).toBe(true)
    expect(e.text.join("")).toBe("xy")
  })

  it("detects a tag with body and matching close", () => {
    const e = drive(["<tui::diff>some body</tui::diff>"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("diff")
    expect(e.tags[0].body).toBe("some body")
    expect(e.tags[0].self_closing).toBe(false)
  })

  it("detects an opener that spans two chunks", () => {
    const e = drive(["prefix <tui::cha", 'rt type="bar">payload</tui::chart>!'])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("chart")
    expect(e.tags[0].attrs).toEqual({ type: "bar" })
    expect(e.tags[0].body).toBe("payload")
    expect(e.text.join("")).toBe("prefix !")
  })

  it("detects a close that spans two chunks", () => {
    const e = drive(["<tui::diff>body</tui:", ":diff> tail"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].body).toBe("body")
    expect(e.text.join("")).toBe(" tail")
  })

  it("parses single-quoted attributes", () => {
    const e = drive(["<tui::t a='one' b=\"two\" />"])
    expect(e.tags[0].attrs).toEqual({ a: "one", b: "two" })
  })

  it("supports minimal escapes in attribute values", () => {
    const e = drive(['<tui::t a="a\\"b" c=\'d\\nE\' />'])
    expect(e.tags[0].attrs.a).toBe('a"b')
    expect(e.tags[0].attrs.c).toBe("d\nE")
  })

  it("honors the escape form backslash-lt-tui-colon-colon", () => {
    const e = drive(["literal \\<tui::foo /> kept"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("literal <tui::foo /> kept")
  })

  it("flushes plain text before an opener", () => {
    const e = drive(["some text <tui::x />more"])
    expect(e.text.join("")).toBe("some text more")
    expect(e.tags).toHaveLength(1)
  })

  it("falls back to raw text when span exceeds maxSpanBytes", () => {
    const big = "x".repeat(1000)
    const e = drive([`<tui::diff>${big}`], 100)
    expect(e.tags).toHaveLength(0)
    // The raw, un-dispatched text should end up on the text channel.
    expect(e.text.join("")).toContain("<tui::diff>")
    expect(e.text.join("")).toContain(big)
  })

  it("falls back to raw text when the stream ends mid-capture", () => {
    const e = drive(["<tui::diff>unterminated body"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("<tui::diff>unterminated body")
  })

  it("falls back to raw text when the closer name doesn't match the opener", () => {
    // Regression: only `</tui::NAME>` exactly matching the opener closes a
    // capture. A differently-named closer is just more body content, so the
    // capture runs to end-of-stream and falls back to raw flush — same code
    // path as the no-closer-at-all case above, but a distinct authoring
    // mistake worth documenting. Real instance: a memory tag closed with
    // `</thinking>` (the older Anthropic scratchpad pattern) instead of
    // `</tui::memory>` flushed the body to the terminal but skipped the save.
    const e = drive(["<tui::memory>save me</thinking> trailing"])
    expect(e.tags).toHaveLength(0)
    expect(e.text.join("")).toBe("<tui::memory>save me</thinking> trailing")
  })

  it("handles nested different-name tags by capturing the outer raw body", () => {
    const e = drive(["<tui::outer><tui::inner /></tui::outer>"])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].name).toBe("outer")
    expect(e.tags[0].body).toBe("<tui::inner />")
  })

  it("closes on first same-name close (accepted limitation)", () => {
    // Outer has body containing a same-name tag. The scanner does not track
    // nesting depth, so the first </tui::same> closes the outer capture.
    const e = drive(["<tui::same>inner<tui::same/>tail</tui::same>"])
    // The first "<tui::same>" opens. Inside body, another self-closing
    // "<tui::same/>" does not terminate because it has a slash-gt, not a
    // closing tag form. The first "</tui::same>" is the real outer close.
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].body).toBe("inner<tui::same/>tail")
  })

  it("emits multiple tags in a single stream", () => {
    const e = drive(["a<tui::x />b<tui::y>B</tui::y>c"])
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
    const e = drive([`<tui::pre>${body}</tui::pre>`])
    expect(e.tags).toHaveLength(1)
    expect(e.tags[0].body).toBe(body)
  })

  it("raw span on the tag event contains the full opener and closer", () => {
    const e = drive(['<tui::x k="v">body</tui::x>'])
    expect(e.tags[0].raw).toBe('<tui::x k="v">body</tui::x>')
  })

  it("raw span for self-closing tag is the opener alone", () => {
    const e = drive(['<tui::x k="v" />'])
    expect(e.tags[0].raw).toBe('<tui::x k="v" />')
  })
})
