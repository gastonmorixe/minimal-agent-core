import { describe, expect, test } from "bun:test"

import type { SidebandDisplay, SidebandDisplaySegment } from "../types/sideband.ts"

import { displayMarkdown, displayXml, fenceFor, openFence, xmlSafe } from "./display-format.ts"

/**
 * A small CommonMark check, for fenced code only: for each line, `true` when
 * the line is inside a fenced code block (the fence lines count as code).
 * It is a second, separate copy of the rules, so the test does not trust
 * `openFence`. No dependency.
 */
function codeLines(md: string): boolean[] {
  const out: boolean[] = []
  let char = ""
  let len = 0
  for (const line of md.split("\n")) {
    const indent = line.length - line.trimStart().length
    const t = line.trimStart()
    const runOf = (c: string): number => {
      let n = 0
      while (t[n] === c) n++
      return n
    }
    if (char === "") {
      const c = t[0] ?? ""
      const n = c === "`" || c === "~" ? runOf(c) : 0
      const info = t.slice(n)
      if (indent <= 3 && n >= 3 && !(c === "`" && info.includes("`"))) {
        char = c
        len = n
        out.push(true)
        continue
      }
      out.push(false)
      continue
    }
    out.push(true)
    const n = runOf(char)
    if (indent <= 3 && n >= len && t.slice(n).trim() === "") char = ""
  }
  return out
}

const node = (display: SidebandDisplay, kind = "fake"): SidebandDisplaySegment => ({
  type: "node",
  kind,
  display,
  node: { kind, attrs: {}, selfClosing: true, form: "v2", span: { start: 0, end: 1 } },
  cp: { start: 0, end: 1 },
})
const text = (t: string): SidebandDisplaySegment => ({ type: "text", text: t })

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

describe("display-format", () => {
  test("fence longer than a fence in the body", () => {
    expect(fenceFor("plain")).toBe("```")
    expect(fenceFor("a\n````\nb")).toBe("`````")
    expect(fenceFor("x", 5)).toBe("``````")
    const md = displayMarkdown([node({ label: "[L]", text: "```js\nx\n```" })])
    expect(md).toBe("[L]\n````\n```js\nx\n```\n````")
  })

  test("fenceFor with a tilde char", () => {
    expect(fenceFor("a ~~~~ b", 0, "~")).toBe("~~~~~")
    expect(fenceFor("```` only backticks", 0, "~")).toBe("~~~")
  })

  test("openFence follows the CommonMark open and close rules", () => {
    expect(openFence("plain")).toBeNull()
    expect(openFence("```\nx")).toEqual({ char: "`", length: 3 })
    expect(openFence("```\nx\n````")).toBeNull()
    expect(openFence("````\nx\n```")).toEqual({ char: "`", length: 4 })
    expect(openFence("~~~\nx\n```")).toEqual({ char: "~", length: 3 })
    expect(openFence("~~~\nx\n   ~~~~  \nafter")).toBeNull()
    expect(openFence("    ```\nx")).toBeNull()
    expect(openFence("``` a`b\nx")).toBeNull()
    expect(openFence("```\nx\n``` not a close")).toEqual({ char: "`", length: 3 })
  })

  test("inside a user backtick fence the node fence uses tildes", () => {
    const md = displayMarkdown([
      text("````\nuser fence\n"),
      node({ label: "[L]", text: "a ~~~ b\n````` x" }),
      text("\n````"),
    ])
    expect(md).toBe("````\nuser fence\n[L]\n~~~~\na ~~~ b\n````` x\n~~~~\n````")
  })

  test("inside a user tilde fence the node fence uses backticks", () => {
    const md = displayMarkdown([
      text("~~~\n"),
      node({ label: "[L]", text: "x ``` y" }),
      text("\n~~~"),
    ])
    expect(md).toBe("~~~\n[L]\n````\nx ``` y\n````\n~~~")
  })

  test("after a closed user fence the node fence uses backticks", () => {
    const md = displayMarkdown([text("```\nx\n```\n"), node({ label: "[L]", text: "b" })])
    expect(md).toBe("```\nx\n```\n[L]\n```\nb\n```")
  })

  test("a dump heading after a user fence is not inside a code block", () => {
    // A user types ``` and pastes. The review repro (A12 #1).
    const md = `${displayMarkdown([
      text("```\n"),
      node({ label: "[Paste]", text: "body" }),
      text("\n```"),
    ])}\n\n## Assistant\n\nreply`
    const code = codeLines(md)
    const lines = md.split("\n")
    expect(code[lines.indexOf("## Assistant")]).toBe(false)
    expect(code[lines.indexOf("reply")]).toBe(false)
    expect(code[lines.indexOf("body")]).toBe(true)
  })

  test("label on its own line before the fence", () => {
    const md = displayMarkdown([
      text("see "),
      node({ label: "[L]", text: "one\ntwo\n" }),
      text("after"),
    ])
    expect(md).toBe("see \n[L]\n```\none\ntwo\n```\nafter")
  })

  test("a node with no text gives the label in place", () => {
    expect(displayMarkdown([text("a "), node({ label: "[L]" }), text(" b")])).toBe("a [L] b")
  })

  test("xml escapes and removes control chars", () => {
    expect(xmlSafe("a\u0000b\u0007c\td\ne\rf\uFFFE\uD800g")).toBe("abc\td\ne\rfg")
    expect(xmlSafe("ok \u{1F600}")).toBe("ok \u{1F600}")
    const xml = displayXml(
      [text("<a>\u0001"), node({ label: 'q"\u0002', text: "x & y\u001F" }, "k<")],
      escapeXml,
    )
    expect(xml).toBe(
      '&lt;a&gt;<display kind="k&lt;" label="q&quot;">x &amp; y</display>',
    )
  })

  test("truncated attr", () => {
    const xml = displayXml([node({ label: "L", text: "t", truncated: true })], escapeXml)
    expect(xml).toBe('<display kind="fake" label="L" truncated="true">t</display>')
  })

  test("missing attr", () => {
    const xml = displayXml([node({ label: "L", missing: true })], escapeXml)
    expect(xml).toBe('<display kind="fake" label="L" missing="true"/>')
  })

  test("no text gives a self-closing element", () => {
    expect(displayXml([node({ label: "L" })], escapeXml)).toBe('<display kind="fake" label="L"/>')
  })
})
