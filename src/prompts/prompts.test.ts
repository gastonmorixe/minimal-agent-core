/**
 * Tests for the prompt loader + templating engine.
 *
 * @module prompts.test
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { EMBEDDED_PROMPTS } from "./embedded.ts"
import {
  clearPromptCache,
  findEmbeddedPrompt,
  loadPromptText,
  PromptTemplateError,
  promptPath,
  renderPrompt,
  renderTemplate,
} from "./prompts.ts"

afterEach(() => {
  clearPromptCache()
})

describe("renderTemplate — required placeholders", () => {
  it("substitutes a required %%name%%", () => {
    expect(renderTemplate("hello %%who%%", { who: "world" })).toBe("hello world")
  })

  it("substitutes multiple placeholders, including repeats", () => {
    const out = renderTemplate("%%a%%-%%b%%-%%a%%", { a: "1", b: "2" })
    expect(out).toBe("1-2-1")
  })

  it("coerces number and boolean values to strings", () => {
    expect(renderTemplate("n=%%n%% b=%%b%%", { n: 50, b: true })).toBe("n=50 b=true")
  })

  it("throws PromptTemplateError listing every missing required name", () => {
    let err: unknown
    try {
      renderTemplate("%%x%% %%y%% %%x%%", {})
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PromptTemplateError)
    const pe = err as PromptTemplateError
    expect(pe.missing.sort()).toEqual(["x", "y"])
    expect(pe.message).toContain("x")
    expect(pe.message).toContain("y")
  })

  it("treats null/undefined values as missing (required)", () => {
    expect(() => renderTemplate("%%a%%", { a: null })).toThrow(PromptTemplateError)
    expect(() => renderTemplate("%%a%%", { a: undefined })).toThrow(PromptTemplateError)
  })
})

describe("renderTemplate — optional (yield-like) placeholders", () => {
  it("substitutes %%name?%% when present", () => {
    expect(renderTemplate("a %%x?%% b", { x: "Y" })).toBe("a Y b")
  })

  it("renders empty when an optional value is absent", () => {
    expect(renderTemplate("a%%x?%%b", {})).toBe("ab")
  })

  it("collapses the blank line left by a line-only optional slot", () => {
    const tmpl = "Intro.\n\n%%mid?%%\n\nOutro."
    expect(renderTemplate(tmpl, {})).toBe("Intro.\n\nOutro.")
    expect(renderTemplate(tmpl, { mid: "MIDDLE" })).toBe("Intro.\n\nMIDDLE\n\nOutro.")
  })

  it("optional null/undefined behaves as absent (no throw)", () => {
    expect(renderTemplate("a%%x?%%b", { x: null })).toBe("ab")
    expect(renderTemplate("a%%x?%%b", { x: undefined })).toBe("ab")
  })
})

describe("renderTemplate — whitespace handling", () => {
  it("trims by default", () => {
    expect(renderTemplate("  hi  ")).toBe("hi")
  })

  it("preserves whitespace when trim:false", () => {
    expect(renderTemplate("  hi  ", {}, { trim: false })).toBe("  hi  ")
  })

  it("leaves a placeholder-free template byte-identical (sans trim)", () => {
    // No optional slot emptied → no newline normalization runs. Internal
    // double newlines and 3+ runs are preserved verbatim before the final trim.
    const src = "Para one.\n\nPara two.\n\n\nPara three."
    expect(renderTemplate(src, {}, { trim: false })).toBe(src)
  })

  it("does not mangle internal blank runs when only required vars are filled", () => {
    const src = "A\n\n\nB %%v%%"
    expect(renderTemplate(src, { v: "x" }, { trim: false })).toBe("A\n\n\nB x")
  })
})

describe("loadPromptText / renderPrompt / promptPath", () => {
  it("renderPrompt loads a file and substitutes", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompts-"))
    try {
      const p = join(dir, "billing.tmpl.md")
      writeFileSync(p, "header: v=%%version%%.%%hash%%;\n")
      expect(renderPrompt(p, { version: "2.1.154", hash: "d6e" })).toBe("header: v=2.1.154.d6e;")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("renderPrompt surfaces the source path in the error", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompts-"))
    try {
      const p = join(dir, "x.tmpl.md")
      writeFileSync(p, "need %%missing%%")
      let err: unknown
      try {
        renderPrompt(p, {})
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(PromptTemplateError)
      expect((err as PromptTemplateError).source).toBe(p)
      expect((err as PromptTemplateError).message).toContain(p)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("loadPromptText memoizes by path until cleared", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompts-"))
    try {
      const p = join(dir, "m.md")
      writeFileSync(p, "first")
      expect(loadPromptText(p)).toBe("first")
      writeFileSync(p, "second")
      // Still cached.
      expect(loadPromptText(p)).toBe("first")
      clearPromptCache()
      expect(loadPromptText(p)).toBe("second")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("promptPath resolves relative to the calling module dir", () => {
    // This test file lives in src/prompts/, so "../prompts" resolves under src/.
    const p = promptPath(import.meta, "..", "prompts", "instructions.md")
    expect(p.endsWith(join("src", "prompts", "instructions.md"))).toBe(true)
  })

  it("embeds every prompt .md file on disk, byte for byte", () => {
    const dir = import.meta.dir
    const onDisk = [...new Bun.Glob("**/*.md").scanSync({ cwd: dir })]
      .map((p) => p.replaceAll("\\", "/"))
      .filter((p) => p !== "README.md")
      .sort()
    expect(Object.keys(EMBEDDED_PROMPTS).sort()).toEqual(onDisk)
    for (const key of onDisk) {
      expect(EMBEDDED_PROMPTS[key], key).toBe(readFileSync(join(dir, key), "utf-8"))
    }
  })

  it("serves core prompts from the embedded map, not from disk", () => {
    const key = "tools/bash.md"
    const embedded = EMBEDDED_PROMPTS[key]
    expect(embedded).toBeDefined()
    expect(findEmbeddedPrompt(promptPath(import.meta, key))).toBe(embedded as string)
    // A binary path never exists on disk, so a read would throw ENOENT: only
    // the embedded map can answer it.
    expect(loadPromptText("/$bunfs/prompts/tools/bash.md")).toBe(embedded as string)
  })

  it("serves compiled-binary virtual paths from the embedded map", () => {
    // `promptPath(import.meta, "..", "prompts", ...)` from `/$bunfs/root`.
    expect(findEmbeddedPrompt("/$bunfs/prompts/tools/bash.md")).toBe(
      EMBEDDED_PROMPTS["tools/bash.md"],
    )
    expect(findEmbeddedPrompt("B:\\~BUN\\prompts\\instructions.md")).toBe(
      EMBEDDED_PROMPTS["instructions.md"],
    )
    expect(findEmbeddedPrompt("B:/~BUN/prompts/loop-safety/ack.md")).toBe(
      EMBEDDED_PROMPTS["loop-safety/ack.md"],
    )
  })

  it("never serves core text to a module bundled from another dir", () => {
    expect(findEmbeddedPrompt("/$bunfs/root/plugins/x/tools/read.md")).toBeUndefined()
    expect(findEmbeddedPrompt("/$bunfs/root/prompts/instructions.md")).toBeUndefined()
    expect(findEmbeddedPrompt("/$bunfs/prompts/nope.md")).toBeUndefined()
  })

  it("never shadows a plugin file that shares a core prompt's relative name", () => {
    expect(findEmbeddedPrompt("/tmp/some-external-plugin/PROMPT.md")).toBeUndefined()
    expect(findEmbeddedPrompt("/home/u/.agents/plugins/mine/instructions.md")).toBeUndefined()
    expect(findEmbeddedPrompt("/p/my-plugin/prompts/tools/read.md")).toBeUndefined()
    expect(findEmbeddedPrompt("/p/prompts/tools/read.md")).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), "ma-prompt-shadow-"))
    try {
      const file = join(dir, "instructions.md")
      writeFileSync(file, "plugin instructions")
      expect(loadPromptText(file)).toBe("plugin instructions")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
