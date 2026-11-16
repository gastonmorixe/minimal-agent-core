import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { SyntheticFacts, SyntheticKind } from "../../plugin-api/src/types/synthetic-text.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"

import { executeTool, TOOL_DEFINITIONS } from "./tools.ts"
import {
  aliasedStringAllowEmpty,
  resolveWriteExecArgs,
  writeContentFromInput,
  writePathFromInput,
} from "./write-input.ts"

/** One synthetic text request the code under test made. */
type Call = { kind: SyntheticKind; facts: SyntheticFacts }

/** The marker the recorder returns for a call, so a test can find it in the content. */
function mark(kind: SyntheticKind, facts: SyntheticFacts): string {
  return `<${kind} ${JSON.stringify(facts)}>`
}

/** A resolver that records (kind, facts) and never uses the core fallback. */
function recorder(): SyntheticTextResolver & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    resolve(kind, facts) {
      calls.push({ kind, facts })
      return mark(kind, facts)
    },
  }
}

describe("aliasedStringAllowEmpty", () => {
  it("accepts empty string as a present value", () => {
    expect(aliasedStringAllowEmpty({ content: "" }, ["content", "contents"])).toEqual({
      status: "ok",
      key: "content",
      value: "",
    })
  })

  it("skips null and falls through to the next key", () => {
    expect(
      aliasedStringAllowEmpty({ content: null, contents: "body" }, ["content", "contents"]),
    ).toEqual({
      status: "ok",
      key: "contents",
      value: "body",
    })
  })
})

describe("writeContentFromInput", () => {
  it("reads canonical `content`", () => {
    expect(writeContentFromInput({ content: "hello" })).toEqual({
      status: "ok",
      key: "content",
      value: "hello",
    })
  })

  it("reads Cursor alias `contents`", () => {
    expect(writeContentFromInput({ contents: "from alias" })).toEqual({
      status: "ok",
      key: "contents",
      value: "from alias",
    })
  })

  it("prefers `content` when both are set", () => {
    expect(writeContentFromInput({ content: "canonical", contents: "alias" })).toEqual({
      status: "ok",
      key: "content",
      value: "canonical",
    })
  })

  it("prefers empty canonical `content` over a non-empty alias", () => {
    expect(writeContentFromInput({ content: "", contents: "alias" })).toEqual({
      status: "ok",
      key: "content",
      value: "",
    })
  })

  it("reports missing when neither key is a string", () => {
    expect(writeContentFromInput({})).toEqual({ status: "missing" })
    expect(writeContentFromInput({ content: null })).toEqual({ status: "missing" })
    expect(writeContentFromInput({ contents: null })).toEqual({ status: "missing" })
  })

  it("rejects a non-string at the first listed key without falling through", () => {
    expect(writeContentFromInput({ content: 12, contents: "ok" })).toEqual({
      status: "invalid",
      key: "content",
      got: "number",
    })
  })
})

describe("writePathFromInput", () => {
  it("reads `file_path`", () => {
    expect(writePathFromInput({ file_path: "/tmp/a.txt" })).toEqual({
      status: "ok",
      key: "file_path",
      value: "/tmp/a.txt",
    })
  })

  it("reports missing when file_path is absent", () => {
    expect(writePathFromInput({})).toEqual({ status: "missing" })
  })
})

describe("resolveWriteExecArgs", () => {
  it("resolves canonical and aliased bodies", () => {
    expect(resolveWriteExecArgs({ file_path: "/a", content: "x" })).toEqual({
      ok: true,
      filePath: "/a",
      content: "x",
    })
    expect(resolveWriteExecArgs({ file_path: "/a", contents: "y" })).toEqual({
      ok: true,
      filePath: "/a",
      content: "y",
    })
  })

  it("allows empty content", () => {
    expect(resolveWriteExecArgs({ file_path: "/a", content: "" })).toEqual({
      ok: true,
      filePath: "/a",
      content: "",
    })
  })

  it("asks for the Write error kinds for missing or mistyped args", () => {
    const cases: [Record<string, unknown>, SyntheticKind, SyntheticFacts][] = [
      [{}, "tool_text.Write.missing_path", {}],
      [{ file_path: "/a" }, "tool_text.Write.missing_content", {}],
      [
        { file_path: 1, content: "x" },
        "tool_text.Write.arg_not_string",
        { key: "file_path", got: "number" },
      ],
      [
        { file_path: "/a", content: ["x"] },
        "tool_text.Write.arg_not_string",
        { key: "content", got: "array" },
      ],
      [
        { file_path: "/a", contents: { body: 1 } },
        "tool_text.Write.arg_not_string",
        { key: "contents", got: "object" },
      ],
    ]
    for (const [input, kind, facts] of cases) {
      const text = recorder()
      expect(resolveWriteExecArgs(input, text)).toEqual({ ok: false, error: mark(kind, facts) })
      expect(text.calls).toEqual([{ kind, facts }])
    }
  })

  it("asks for no text on the ok path", () => {
    const text = recorder()
    expect(resolveWriteExecArgs({ file_path: "/a", content: "" }, text).ok).toBe(true)
    expect(text.calls).toEqual([])
  })
})

describe("WRITE_TOOL schema", () => {
  const write = TOOL_DEFINITIONS.find((t) => t.name === "Write")
  if (!write) throw new Error("Write tool missing from TOOL_DEFINITIONS")
  const props = write.input_schema.properties as Record<
    string,
    { type?: string; description?: string }
  >

  it("documents content plus Cursor contents alias, and keeps additionalProperties false", () => {
    expect(Object.keys(props)).toEqual(["file_path", "content", "contents"])
    expect(props.file_path?.type).toBe("string")
    expect(props.content?.type).toBe("string")
    expect(props.contents?.type).toBe("string")
    expect(props.content?.description).toMatch(/contents/)
    expect(props.contents?.description).toMatch(/alias/i)
    expect(write.input_schema.required).toEqual(["file_path", "content"])
    expect(write.input_schema.additionalProperties).toBe(false)
  })
})

describe("executeTool Write", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tools-write-"))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("writes with canonical `content`", async () => {
    const path = join(dir, "canonical.txt")
    const text = recorder()
    const r = await executeTool("Write", { file_path: path, content: "hello\n" }, { text })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toBe(mark("tool_text.Write.written", { path }))
    expect(text.calls).toEqual([{ kind: "tool_text.Write.written", facts: { path } }])
    expect(readFileSync(path, "utf8")).toBe("hello\n")
  })

  it("writes with Cursor `contents` alias (Daniela Blob-y regression)", async () => {
    const path = join(dir, "alias.txt")
    const text = recorder()
    const r = await executeTool("Write", { file_path: path, contents: "alias body\n" }, { text })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toBe(mark("tool_text.Write.written", { path }))
    expect(readFileSync(path, "utf8")).toBe("alias body\n")
    expect(r.content).not.toMatch(/Blob-y|Bun\.write/i)
  })

  it("prefers `content` when both keys are set", async () => {
    const path = join(dir, "prefer.txt")
    const r = await executeTool("Write", {
      file_path: path,
      content: "canonical\n",
      contents: "alias\n",
    })
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(path, "utf8")).toBe("canonical\n")
  })

  it("writes an empty file when content is empty string", async () => {
    const path = join(dir, "empty.txt")
    const r = await executeTool("Write", { file_path: path, content: "" })
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(path, "utf8")).toBe("")
  })

  it("does not throw Bun.write when content is missing", async () => {
    const path = join(dir, "missing-body.txt")
    const text = recorder()
    const r = await executeTool("Write", { file_path: path }, { text })
    expect(r.is_error).toBe(true)
    expect(text.calls).toEqual([{ kind: "tool_text.Write.missing_content", facts: {} }])
    expect(r.content).toBe(mark("tool_text.Write.missing_content", {}))
    expect(r.content).not.toMatch(/Blob-y|Bun\.write/i)
  })

  it("does not throw Bun.write when content is not a string", async () => {
    const path = join(dir, "bad-type.txt")
    const text = recorder()
    const r = await executeTool("Write", { file_path: path, content: 42 }, { text })
    expect(r.is_error).toBe(true)
    const facts = { key: "content", got: "number" }
    expect(text.calls).toEqual([{ kind: "tool_text.Write.arg_not_string", facts }])
    expect(r.content).toBe(mark("tool_text.Write.arg_not_string", facts))
    expect(r.content).not.toMatch(/Blob-y|Bun\.write/i)
  })

  it("rejects a missing file_path without writing", async () => {
    const text = recorder()
    const r = await executeTool("Write", { content: "x" }, { text })
    expect(r.is_error).toBe(true)
    expect(text.calls).toEqual([{ kind: "tool_text.Write.missing_path", facts: {} }])
    expect(r.content).toBe(mark("tool_text.Write.missing_path", {}))
  })

  it("creates parent directories as needed", async () => {
    const path = join(dir, "nested", "deep", "file.txt")
    const r = await executeTool("Write", { file_path: path, contents: "nested\n" })
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(path, "utf8")).toBe("nested\n")
  })
})
