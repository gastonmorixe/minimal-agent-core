/**
 * End-to-end integration test for the Plugin system.
 *
 * Loads the real `diff-view` example plugin from the project-root
 * `plugins/` directory, then drives it through two code paths:
 *
 * 1. `PluginStream`: simulates streamed assistant text that contains an
 *    inline `<ma::emit::diff>` block across multiple chunks, and verifies the
 *    sink receives rendered ANSI in place of the tag span.
 *
 * 2. `PluginLoader.dispatch`: calls the `show_diff` tool directly and
 *    verifies the returned `tool_result` content carries the rendered diff.
 *
 * Also verifies that unknown inline tags pass through to the sink as raw
 * bytes, matching the scanner's fallback behavior.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

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
    // Canonical tool name is now DiffViewerShowDiff; show_diff is a back-compat alias.
    expect(loader.hasTool("DiffViewerShowDiff")).toBe(true)
    expect(loader.hasTool("show_diff")).toBe(true) // alias
    expect(loader.hasInlineTag("diff")).toBe(true)
    const tools = loader.getExtraTools()
    expect(tools.map((t) => t.name)).toContain("DiffViewerShowDiff")
    // Aliases must NOT appear in the model-facing tool list.
    expect(tools.map((t) => t.name)).not.toContain("show_diff")
    // Alias index reflects the back-compat mapping.
    expect(loader.getToolAliases().get("show_diff")).toBe("DiffViewerShowDiff")
  })

  it("composes diff-view into a role-named tool section (no plugin framing)", () => {
    const block = loader.getPromptBlock()
    expect(block).toBeString()
    // diff-view contributes a tool (DiffViewerShowDiff) + an inline tag (diff); the
    // tool framing wins and the section is keyed by the tool name. The word
    // "plugin" and the plugin id never reach the model.
    expect(block).toContain('<ma::sys::tool name="DiffViewerShowDiff">')
    expect(block).toContain("</ma::sys::tool>")
    // The old structural wrappers are gone: no outer <ma::plugins> envelope,
    // no per-plugin <ma::plugin id="..."> block, no overview boilerplate.
    expect(block).not.toContain("<ma::plugins>")
    expect(block).not.toContain("<ma::plugin id=")
  })

  it("PluginStream routes inline <ma::emit::diff> through the handler (single chunk)", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, process.cwd())
    const body = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n const z = 4;"
    await feed(stream, `before <ma::emit::diff>${body}</ma::emit::diff> after`)
    await stream.end()

    const full = out.join("")
    expect(full.startsWith("before ")).toBe(true)
    expect(full.endsWith(" after")).toBe(true)
    expect(full).not.toContain("<ma::emit::diff>")
    expect(full).not.toContain("</ma::emit::diff>")
    expect(full).toContain("\x1b[38;5;199m-old\x1b[0m")
    expect(full).toContain("\x1b[38;5;118m+new\x1b[0m")
    expect(full).toContain("\x1b[36m@@ -1,2 +1,2 @@\x1b[0m")
  })

  it("PluginStream handles a tag split across chunk boundaries", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, process.cwd())
    await feed(stream, "prefix <ma::emit::dif")
    await feed(stream, 'f title="hunk">--- a\n+++ b\n@@ -1 +1 @@\n-a')
    await feed(stream, "\n+b\n</ma::emit::diff> tail")
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
    await feed(stream, "before <ma::emit::unknown>body</ma::emit::unknown> after")
    await stream.end()
    const full = out.join("")
    expect(full).toBe("before <ma::emit::unknown>body</ma::emit::unknown> after")
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

// ---------------------------------------------------------------------------
// emit-output plugin: inline rendering of a tool's raw-output blob or a safe
// filesystem path, with the bytes never round-tripping through the model.
//
// These exercise the real plugin loaded from PROJECT_ROOT (same as diff-view
// above), driven through PluginStream. The `tool=` mode needs the blob store
// wired, so this block loads its OWN loader with a temp `sessionsDir` (via
// hostOptions) and a fixed `sessionId`, then plants a blob fixture on disk at
// the convention `<sessionsDir>/<sid>.blobs/<tool_use_id>.raw`.
// ---------------------------------------------------------------------------

describe("plugins: end-to-end integration with emit-output", () => {
  const SID = "emit-output-itest-session"
  // ANSI + box-drawing content that would be mangled if the model hand-copied
  // it — the exact thing the tag exists to protect.
  const BLOB_BODY =
    "\x1b[36m┌─────────┐\x1b[0m\n\x1b[36m│ hello   │\x1b[0m\n\x1b[36m└─────────┘\x1b[0m"

  let sessionsDir: string
  let workDir: string
  let loader: PluginLoader

  beforeAll(async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "emit-output-sessions-"))
    workDir = mkdtempSync(join(tmpdir(), "emit-output-cwd-"))

    // Plant the blob fixture at the documented convention.
    const blobsDir = join(sessionsDir, `${SID}.blobs`)
    mkdirSync(blobsDir, { recursive: true })
    writeFileSync(join(blobsDir, "toolu_01render.raw"), BLOB_BODY)
    // A blob larger than the handler's 256 KiB cap so the clipped note fires.
    writeFileSync(join(blobsDir, "toolu_01big.raw"), "x".repeat(300 * 1024))

    loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: CORE_TOOLS,
      sessionId: SID,
      hostOptions: { sessionsDir },
    })
  })

  afterAll(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
  })

  it("discovers the emit-output plugin and registers the inline tag", () => {
    expect(loader.hasInlineTag("output")).toBe(true)
    // Inline-tag-only plugin: it contributes NO model-facing tool.
    expect(loader.getExtraTools().map((t) => t.name)).not.toContain("output")
  })

  it("renders a tool= blob inline with ANSI bytes intact, tag consumed", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, workDir)
    await feed(stream, 'rendered:\n<ma::emit::output tool="toolu_01render" />\ndone')
    await stream.end()

    const full = out.join("")
    expect(full).toContain("rendered:")
    expect(full).toContain("done")
    // The raw tag must NOT survive to output.
    expect(full).not.toContain("<ma::emit::output")
    // The blob's ANSI + box-drawing bytes pass through verbatim.
    expect(full).toContain(BLOB_BODY)
  })

  it("renders a title= heading above tool= content", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, workDir)
    await feed(stream, '<ma::emit::output tool="toolu_01render" title="Tree view" />')
    await stream.end()
    const full = out.join("")
    expect(full).toContain("Tree view")
    expect(full).toContain(BLOB_BODY)
  })

  it("appends a [clipped N bytes] note when the blob exceeds the cap", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, workDir)
    await feed(stream, '<ma::emit::output tool="toolu_01big" />')
    await stream.end()
    const full = out.join("")
    expect(full).toContain("[clipped")
    // Some of the actual content is still present (it's not all dropped).
    expect(full).toContain("xxxxxxxx")
  })

  it("renders a graceful placeholder (no crash, no raw leak) for a missing blob", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, workDir)
    await feed(stream, 'pre <ma::emit::output tool="toolu_doesnotexist" /> post')
    await stream.end()
    const full = out.join("")
    expect(full).toContain("pre ")
    expect(full).toContain(" post")
    // A dim placeholder, not the raw tag passed through.
    expect(full).not.toContain("<ma::emit::output")
    expect(full.toLowerCase()).toContain("not found")
  })

  it("renders a path= file under the agent cwd", async () => {
    const filePath = join(workDir, "render.txt")
    writeFileSync(filePath, BLOB_BODY)
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, workDir)
    await feed(stream, `<ma::emit::output path="${filePath}" />`)
    await stream.end()
    const full = out.join("")
    expect(full).not.toContain("<ma::emit::output")
    expect(full).toContain(BLOB_BODY)
  })

  it("renders a path= file under /tmp (real ascii-renderer case, needs realpath-roots fix)", async () => {
    // ascii-renderer writes to /tmp, which is a symlink to /private/tmp on
    // macOS. The handler must realpath its ALLOWED ROOTS (not just the target)
    // before the prefix check, or every /tmp file is wrongly refused. This is
    // the regression guard for that fix.
    const dir = mkdtempSync(join("/tmp", "emit-output-tmp-"))
    try {
      const filePath = join(dir, "render.txt")
      writeFileSync(filePath, BLOB_BODY)
      const out: string[] = []
      const stream = new PluginStream((s) => out.push(s), loader, workDir)
      await feed(stream, `<ma::emit::output path="${filePath}" />`)
      await stream.end()
      const full = out.join("")
      expect(full).not.toContain("<ma::emit::output")
      expect(full).toContain(BLOB_BODY)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a path= outside /tmp and the agent cwd", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, workDir)
    await feed(stream, '<ma::emit::output path="/etc/hosts" />')
    await stream.end()
    const full = out.join("")
    // No file contents leak; a dim refusal placeholder instead of the raw tag.
    expect(full).not.toContain("<ma::emit::output")
    expect(full.toLowerCase()).toMatch(/not in|refus|project dir|not found/)
  })

  it("renders a placeholder when neither tool= nor path= is given", async () => {
    const out: string[] = []
    const stream = new PluginStream((s) => out.push(s), loader, workDir)
    await feed(stream, "<ma::emit::output />")
    await stream.end()
    const full = out.join("")
    expect(full).not.toContain("<ma::emit::output />")
    expect(full.toLowerCase()).toContain("exactly one")
  })
})
