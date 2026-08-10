import { describe, expect, it } from "bun:test"

import type {
  CodeHighlighter,
  CodeHighlightRequest,
} from "../formatter/mdstream-code-highlighter.ts"

import { highlightReadBody, highlightUnifiedDiff } from "./code-highlight-render.ts"

const highlighter: CodeHighlighter = {
  warmup: async () => true,
  async highlight({ code }: CodeHighlightRequest) {
    return code
      .split("\n")
      .map((line) => `\x1b[38;2;10;20;30m${line}\x1b[0m`)
      .join("\n")
  },
  close: async () => {},
}

describe("tool code highlight composition", () => {
  it("preserves Read line numbers outside syntax foregrounds", async () => {
    const out = await highlightReadBody("41\tconst x = 1\n42\treturn x", "typescript", highlighter)
    expect(out).toContain("\x1b[2m41\x1b[22m\t\x1b[38;2;10;20;30mconst x = 1")
    expect(out).toContain("\x1b[2m42\x1b[22m\t\x1b[38;2;10;20;30mreturn x")
  })

  it("preserves a final empty Read row for files ending in a newline", async () => {
    const out = await highlightReadBody("1\tconst x = 1\n2\t", "typescript", highlighter)
    expect(out).not.toBeNull()
    expect(out).toContain("\x1b[2m1\x1b[22m\t\x1b[38;2;10;20;30mconst x = 1")
    expect(out).toEndWith("\x1b[2m2\x1b[22m\t\x1b[38;2;10;20;30m\x1b[0m")
  })

  it("prefers native unified-diff mode and forwards palette colors", async () => {
    let request: unknown
    const native: CodeHighlighter = {
      warmup: async () => true,
      highlight: async () => null,
      async highlightUnifiedDiff(value) {
        request = value
        return "NATIVE-DIFF"
      },
      close: async () => {},
    }
    const previous = process.env.MINIMAL_AGENT_PALETTE
    process.env.MINIMAL_AGENT_PALETTE = JSON.stringify({
      addition: "\x1b[38;5;118m",
      removal: "\x1b[38;5;199m",
    })
    try {
      const out = await highlightUnifiedDiff("-old\n+new", "typescript", native, "Edit")
      expect(out).toContain("NATIVE-DIFF")
      expect(request).toEqual({
        language: "typescript",
        code: "-old\n+new",
        diffStyle: "bg-wash",
        colors: { inserted: "#87ff00", deleted: "#ff00af" },
      })
    } finally {
      if (previous === undefined) delete process.env.MINIMAL_AGENT_PALETTE
      else process.env.MINIMAL_AGENT_PALETTE = previous
    }
  })

  it("sends bright native marker colors and keeps syntax foregrounds over soft fallback washes", async () => {
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n const x = 1\n-old()\n+newCall()"
    const out = await highlightUnifiedDiff(patch, "typescript", highlighter)
    expect(out).toContain("\x1b[48;2;56;0;38m\x1b[38;5;199m-")
    expect(out).toContain("\x1b[48;2;29;56;0m\x1b[38;5;118m+")
    expect(out).toContain("\x1b[38;2;10;20;30mold()")
    expect(out).toContain("\x1b[38;2;10;20;30mnewCall()")
    expect(out).toContain(" \x1b[38;2;10;20;30mconst x = 1")
  })

  it("fails closed when row counts do not match", async () => {
    const broken: CodeHighlighter = {
      warmup: async () => true,
      highlight: async () => "one-line",
      close: async () => {},
    }
    expect(await highlightReadBody("1\ta\n2\tb", "text", broken)).toBeNull()
  })
})
