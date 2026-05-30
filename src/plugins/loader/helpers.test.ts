import { describe, expect, it } from "bun:test"

import type { LoadedPlugin, ManifestFile } from "../types.ts"

import {
  classifyPluginPrompt,
  escapeTagAttr,
  leadingHeadingText,
  PROMPT_ROLE_ORDER,
  slugify,
} from "./helpers.ts"

/**
 * Unit coverage for the prompt-composition helpers introduced with the
 * `<ma::sys::ROLE>` system-prompt refactor. These functions decide WHAT
 * semantic wrapper each plugin's prompt text composes into, purely from
 * manifest shape (no manifest field, no plugin id leaked to the model).
 */

/** Build a minimal {@link LoadedPlugin} for classify (only manifest + prompt are read). */
function mkPlugin(manifest: Partial<ManifestFile>, prompt: string | null): LoadedPlugin {
  const m: ManifestFile = {
    id: "test-id",
    name: "Test Plugin",
    version: "0.0.0",
    description: "d",
    ...manifest,
  } as ManifestFile
  return { manifest: m, prompt } as unknown as LoadedPlugin
}

const toolTui = (name: string) => ({
  id: "t",
  trigger: {
    type: "tool" as const,
    tool: { name, description: "d", input_schema: { type: "object", properties: {} } },
  },
  handler: { type: "module" as const, path: "./h.ts", export: "default" },
  interactive: false,
})

const tagTui = (tag: string) => ({
  id: "t",
  trigger: { type: "inline_tag" as const, tag },
  handler: { type: "module" as const, path: "./h.ts", export: "default" },
  interactive: false,
})

const frag = () => ({
  id: "f",
  handler: { type: "module" as const, path: "./f.ts", export: "default" },
})

describe("classifyPluginPrompt", () => {
  it("modes → mode role, name = first mode id", () => {
    const p = mkPlugin({ modes: [{ id: "ask", label: "ASK" }] as never }, "body")
    expect(classifyPluginPrompt(p)).toEqual({ role: "mode", name: "ask" })
  })

  it("a tool tui → tool role, name = tool name", () => {
    const p = mkPlugin({ tuis: [toolTui("WebSearch")] as never }, "body")
    expect(classifyPluginPrompt(p)).toEqual({ role: "tool", name: "WebSearch" })
  })

  it("inline-tag-only → emit role, name = tag", () => {
    const p = mkPlugin({ tuis: [tagTui("interleave-thinking")] as never }, "body")
    expect(classifyPluginPrompt(p)).toEqual({ role: "emit", name: "interleave-thinking" })
  })

  it("a tool wins over an inline tag in the same plugin (tool framing covers both)", () => {
    const p = mkPlugin({ tuis: [tagTui("diff"), toolTui("ShowDiff")] as never }, "body")
    expect(classifyPluginPrompt(p)).toEqual({ role: "tool", name: "ShowDiff" })
  })

  it("modes win over tools (a mode plugin frames as mode even if it also has a tool)", () => {
    const p = mkPlugin(
      { modes: [{ id: "ask", label: "ASK" }] as never, tuis: [toolTui("X")] as never },
      "body",
    )
    expect(classifyPluginPrompt(p).role).toBe("mode")
  })

  it("PROMPT.md only, no fragments → behavior role, name = slug of H1", () => {
    const p = mkPlugin({ id: "ma-agent-writing-style" }, "# Writing style\n\nYou write for humans.")
    expect(classifyPluginPrompt(p)).toEqual({ role: "behavior", name: "writing-style" })
  })

  it("PROMPT.md + a prompt fragment → context role, name = slug of H1", () => {
    const p = mkPlugin(
      { id: "env-info", promptFragments: [frag()] as never },
      "# Environment\n\nSnapshot.",
    )
    expect(classifyPluginPrompt(p)).toEqual({ role: "context", name: "environment" })
  })

  it("behavior with no H1 falls back to a slug of the manifest display name", () => {
    const p = mkPlugin({ name: "Coding Conventions" }, "No leading heading here.")
    expect(classifyPluginPrompt(p)).toEqual({ role: "behavior", name: "coding-conventions" })
  })
})

describe("leadingHeadingText", () => {
  it("extracts a leading H1", () => {
    expect(leadingHeadingText("# Writing style\n\nbody")).toBe("Writing style")
  })
  it("tolerates a trailing # run and a BOM", () => {
    expect(leadingHeadingText("\uFEFF# Title #\nbody")).toBe("Title")
  })
  it("returns null when the body does not open with an H1", () => {
    expect(leadingHeadingText("No heading.\n# later\n")).toBeNull()
    expect(leadingHeadingText("## Subheading\n")).toBeNull()
  })
})

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Agent Writing Style")).toBe("agent-writing-style")
  })
  it("collapses non-alphanumerics and trims ends", () => {
    expect(slugify("  Hello,  World!! ")).toBe("hello-world")
  })
})

describe("escapeTagAttr", () => {
  it("escapes XML attribute metacharacters", () => {
    expect(escapeTagAttr('a"<>&b')).toBe("a&quot;&lt;&gt;&amp;b")
  })
})

describe("PROMPT_ROLE_ORDER", () => {
  it("orders behavior < tool < emit < mode < context", () => {
    const { behavior, tool, emit, mode, context } = PROMPT_ROLE_ORDER
    expect(behavior).toBeLessThan(tool)
    expect(tool).toBeLessThan(emit)
    expect(emit).toBeLessThan(mode)
    expect(mode).toBeLessThan(context)
  })
})
