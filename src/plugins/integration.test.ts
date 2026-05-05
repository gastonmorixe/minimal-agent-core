/**
 * End-to-end integration test for the TUI plugin system.
 *
 * Loads the real `diff-view` example plugin from the project-root
 * `tui-plugins/` directory, then drives it through two code paths:
 *
 * 1. `PluginStream`: simulates streamed assistant text that contains an
 *    inline `<tui::diff>` block across multiple chunks, and verifies the
 *    sink receives rendered ANSI in place of the tag span.
 *
 * 2. `PluginLoader.dispatch`: calls the `show_diff` tool directly and
 *    verifies the returned `tool_result` content carries the rendered diff.
 *
 * Also verifies that unknown inline tags pass through to the sink as raw
 * bytes, matching the scanner's fallback behavior.
 */

import { describe, it, expect, beforeAll } from "bun:test"
import { resolve } from "node:path"
import { PluginLoader } from "./loader.ts"
import { PluginStream } from "./stream.ts"

const PROJECT_ROOT = resolve(__dirname, "../..")
const CORE_TOOLS = new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"])

async function feed(stream: PluginStream, chunk: string): Promise<void> {
  const p = stream.feed(chunk)
  if (p) await p
}

describe("plugins: end-to-end integration with diff-view", () => {
  let loader: PluginLoader

  beforeAll(async () => {
    loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: CORE_TOOLS,
    })
  })

  it("discovers the diff-view plugin from the project root", () => {
    // Canonical tool name is now ShowDiff; show_diff is a back-compat alias.
    expect(loader.hasTool("ShowDiff")).toBe(true)
    expect(loader.hasTool("show_diff")).toBe(true) // alias
    expect(loader.hasInlineTag("diff")).toBe(true)
    const tools = loader.getExtraTools()
    expect(tools.map((t) => t.name)).toContain("ShowDiff")
    // Aliases must NOT appear in the model-facing tool list.
    expect(tools.map((t) => t.name)).not.toContain("show_diff")
    // Alias index reflects the back-compat mapping.
    expect(loader.getToolAliases().get("show_diff")).toBe("ShowDiff")
  })

  it("emits a prompt block that mentions diff-view", () => {
    const block = loader.getPromptBlock()
    expect(block).toBeString()
    expect(block).toContain("<tui-plugins>")
    expect(block).toContain('<plugin id="diff-view">')
    // Prompt block reflects the canonical name; alias is invisible to the model.
    expect(block).toContain("ShowDiff")
  })

  it("PluginStream routes inline <tui::diff> through the handler (single chunk)", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, process.cwd())
    const body = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n const z = 4;"
    await feed(stream, `before <tui::diff>${body}</tui::diff> after`)
    await stream.end()

    const full = out.join("")
    expect(full.startsWith("before ")).toBe(true)
    expect(full.endsWith(" after")).toBe(true)
    expect(full).not.toContain("<tui::diff>")
    expect(full).not.toContain("</tui::diff>")
    expect(full).toContain("\x1b[38;5;199m-old\x1b[0m")
    expect(full).toContain("\x1b[38;5;118m+new\x1b[0m")
    expect(full).toContain("\x1b[36m@@ -1,2 +1,2 @@\x1b[0m")
  })

  it("PluginStream handles a tag split across chunk boundaries", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, process.cwd())
    await feed(stream, "prefix <tui::dif")
    await feed(stream, 'f title="hunk">--- a\n+++ b\n@@ -1 +1 @@\n-a')
    await feed(stream, "\n+b\n</tui::diff> tail")
    await stream.end()

    const full = out.join("")
    expect(full).toContain("prefix ")
    expect(full).toContain(" tail")
    expect(full).toContain("\x1b[38;5;118m+b\x1b[0m")
    expect(full).toContain("\x1b[38;5;199m-a\x1b[0m")
    expect(full).toContain("hunk")
  })

  it("PluginStream passes unknown inline tags through as raw text", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, process.cwd())
    await feed(stream, "before <tui::unknown>body</tui::unknown> after")
    await stream.end()
    const full = out.join("")
    expect(full).toBe("before <tui::unknown>body</tui::unknown> after")
  })

  it("PluginStream passes plain text without tags verbatim", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, process.cwd())
    await feed(stream, "hello ")
    await feed(stream, "world\n")
    await stream.end()
    expect(out.join("")).toBe("hello world\n")
  })

  it("dispatches the ShowDiff tool and returns a rendered tool_result", async () => {
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const x = 0;\n+const x = 1;"
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "ShowDiff",
        input: { patch, title: "x.ts" },
        tool_use_id: "toolu_test",
      },
      process.cwd(),
    )
    expect(result.kind).toBe("tool_result")
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.is_error).toBeFalsy()
    // `content` is the raw patch (round-tripped to the model — no ANSI
    // wasted on tokens). `display` is the ANSI-rendered diff shown in
    // the transcript with no truncation. See formatToolPreview in
    // src/agent.ts and the ShowDiff handler.
    expect(result.content).toBe(patch)
    expect(result.display).toBeDefined()
    expect(result.display).toContain("x.ts")
    expect(result.display).toContain("\x1b[38;5;199m-const x = 0;\x1b[0m")
    expect(result.display).toContain("\x1b[38;5;118m+const x = 1;\x1b[0m")
  })

  it("dispatching via the legacy `show_diff` alias produces a byte-identical tool_result", async () => {
    // This is the alias mechanism's ground-truth integration test: the
    // model emits the old name (e.g. resumed history pattern) and gets
    // the same diff back, with no notice mutation, no error, no token
    // overhead.
    const patch = "--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-let y = 0;\n+let y = 2;"
    const inputs = { patch, title: "y.ts" }
    const canonical = await loader.dispatch(
      { type: "tool", name: "ShowDiff", input: inputs, tool_use_id: "u_canon" },
      process.cwd(),
    )
    const alias = await loader.dispatch(
      { type: "tool", name: "show_diff", input: inputs, tool_use_id: "u_alias" },
      process.cwd(),
    )
    if (canonical.kind !== "tool_result" || alias.kind !== "tool_result") {
      throw new Error("wrong kind")
    }
    // Content + display + is_error all match — alias is a transparent route.
    expect(alias.content).toBe(canonical.content)
    expect(alias.display).toBe(canonical.display)
    expect(alias.is_error).toBe(canonical.is_error)
  })

  it("reports is_error when ShowDiff is called without a patch", async () => {
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "ShowDiff",
        input: {},
        tool_use_id: "toolu_test2",
      },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.is_error).toBe(true)
    expect(result.content).toContain("patch")
  })
})
