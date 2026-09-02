import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  writeArgNotStringResult,
  writeMissingContentResult,
  writeMissingPathResult,
} from "./PROMPTS.ts"
import { executeTool, TOOL_DEFINITIONS } from "./tools.ts"
import {
  aliasedStringAllowEmpty,
  resolveWriteExecArgs,
  writeContentFromInput,
  writePathFromInput,
} from "./write-input.ts"

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

  it("returns PROMPTS error copy for missing or mistyped args", () => {
    expect(resolveWriteExecArgs({})).toEqual({
      ok: false,
      error: writeMissingPathResult(),
    })
    expect(resolveWriteExecArgs({ file_path: "/a" })).toEqual({
      ok: false,
      error: writeMissingContentResult(),
    })
    expect(resolveWriteExecArgs({ file_path: 1, content: "x" })).toEqual({
      ok: false,
      error: writeArgNotStringResult("file_path", "number"),
    })
    expect(resolveWriteExecArgs({ file_path: "/a", content: ["x"] })).toEqual({
      ok: false,
      error: writeArgNotStringResult("content", "array"),
    })
    expect(resolveWriteExecArgs({ file_path: "/a", contents: { body: 1 } })).toEqual({
      ok: false,
      error: writeArgNotStringResult("contents", "object"),
    })
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
    const r = await executeTool("Write", { file_path: path, content: "hello\n" })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toBe(`File written: ${path}`)
    expect(readFileSync(path, "utf8")).toBe("hello\n")
  })

  it("writes with Cursor `contents` alias (Daniela Blob-y regression)", async () => {
    const path = join(dir, "alias.txt")
    const r = await executeTool("Write", { file_path: path, contents: "alias body\n" })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toBe(`File written: ${path}`)
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
    const r = await executeTool("Write", { file_path: path })
    expect(r.is_error).toBe(true)
    expect(r.content).toBe(writeMissingContentResult())
    expect(r.content).not.toMatch(/Blob-y|Bun\.write/i)
  })

  it("does not throw Bun.write when content is not a string", async () => {
    const path = join(dir, "bad-type.txt")
    const r = await executeTool("Write", { file_path: path, content: 42 })
    expect(r.is_error).toBe(true)
    expect(r.content).toBe(writeArgNotStringResult("content", "number"))
    expect(r.content).not.toMatch(/Blob-y|Bun\.write/i)
  })

  it("rejects a missing file_path without writing", async () => {
    const r = await executeTool("Write", { content: "x" })
    expect(r.is_error).toBe(true)
    expect(r.content).toBe(writeMissingPathResult())
  })

  it("creates parent directories as needed", async () => {
    const path = join(dir, "nested", "deep", "file.txt")
    const r = await executeTool("Write", { file_path: path, contents: "nested\n" })
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(path, "utf8")).toBe("nested\n")
  })
})
