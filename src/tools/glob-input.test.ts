import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  globPathFromInput,
  globPatternFromInput,
  jsonTypeName,
  resolveGlobExecArgs,
} from "./glob-input.ts"
import { globArgNotStringResult, globMissingPatternResult } from "./PROMPTS.ts"
import { executeTool, TOOL_DEFINITIONS } from "./tools.ts"

describe("jsonTypeName", () => {
  it("names null and arrays distinctly from object", () => {
    expect(jsonTypeName(null)).toBe("null")
    expect(jsonTypeName([])).toBe("array")
    expect(jsonTypeName({})).toBe("object")
    expect(jsonTypeName(1)).toBe("number")
    expect(jsonTypeName("x")).toBe("string")
  })
})

describe("globPatternFromInput", () => {
  it("reads canonical `pattern`", () => {
    expect(globPatternFromInput({ pattern: "**/*.ts" })).toEqual({
      status: "ok",
      key: "pattern",
      value: "**/*.ts",
    })
  })

  it("reads Cursor alias `glob_pattern`", () => {
    expect(globPatternFromInput({ glob_pattern: "src/lib/*.test.ts" })).toEqual({
      status: "ok",
      key: "glob_pattern",
      value: "src/lib/*.test.ts",
    })
  })

  it("prefers `pattern` when both are set", () => {
    expect(globPatternFromInput({ pattern: "canonical/*.ts", glob_pattern: "alias/*.ts" })).toEqual(
      {
        status: "ok",
        key: "pattern",
        value: "canonical/*.ts",
      },
    )
  })

  it("skips empty `pattern` and uses the alias", () => {
    expect(globPatternFromInput({ pattern: "", glob_pattern: "*.md" })).toEqual({
      status: "ok",
      key: "glob_pattern",
      value: "*.md",
    })
  })

  it("reports missing when neither key is a non-empty string", () => {
    expect(globPatternFromInput({})).toEqual({ status: "missing" })
    expect(globPatternFromInput({ pattern: "" })).toEqual({ status: "missing" })
    expect(globPatternFromInput({ pattern: null })).toEqual({ status: "missing" })
  })

  it("rejects a non-string at the first listed key without falling through", () => {
    expect(globPatternFromInput({ pattern: 12, glob_pattern: "*.ts" })).toEqual({
      status: "invalid",
      key: "pattern",
      got: "number",
    })
  })
})

describe("globPathFromInput", () => {
  it("reads canonical `path` and alias `target_directory`", () => {
    expect(globPathFromInput({ path: "/src" })).toEqual({
      status: "ok",
      key: "path",
      value: "/src",
    })
    expect(globPathFromInput({ target_directory: "/tmp" })).toEqual({
      status: "ok",
      key: "target_directory",
      value: "/tmp",
    })
  })

  it("prefers `path` when both are set", () => {
    expect(globPathFromInput({ path: "/canonical", target_directory: "/alias" })).toEqual({
      status: "ok",
      key: "path",
      value: "/canonical",
    })
  })
})

describe("resolveGlobExecArgs", () => {
  it("fills searchPath from the alias and default cwd", () => {
    expect(resolveGlobExecArgs({ glob_pattern: "*.ts", target_directory: "/src" }, "/cwd")).toEqual(
      {
        ok: true,
        pattern: "*.ts",
        searchPath: "/src",
      },
    )
    expect(resolveGlobExecArgs({ pattern: "*.md" }, "/cwd")).toEqual({
      ok: true,
      pattern: "*.md",
      searchPath: "/cwd",
    })
  })

  it("returns the PROMPTS error copy for missing or mistyped args", () => {
    expect(resolveGlobExecArgs({}, "/cwd")).toEqual({
      ok: false,
      error: globMissingPatternResult(),
    })
    expect(resolveGlobExecArgs({ pattern: 1 }, "/cwd")).toEqual({
      ok: false,
      error: globArgNotStringResult("pattern", "number"),
    })
  })
})

describe("GLOB_TOOL schema", () => {
  const glob = TOOL_DEFINITIONS.find((t) => t.name === "Glob")
  if (!glob) throw new Error("Glob tool missing from TOOL_DEFINITIONS")
  const props = glob.input_schema.properties as Record<
    string,
    { type?: string; description?: string }
  >

  it("documents pattern plus Cursor aliases, and keeps additionalProperties false", () => {
    expect(Object.keys(props)).toEqual(["pattern", "glob_pattern", "path", "target_directory"])
    expect(props.pattern?.type).toBe("string")
    expect(props.glob_pattern?.type).toBe("string")
    expect(props.path?.type).toBe("string")
    expect(props.target_directory?.type).toBe("string")
    expect(props.pattern?.description).toMatch(/glob_pattern/)
    expect(props.glob_pattern?.description).toMatch(/alias/i)
    expect(props.path?.description).toMatch(/target_directory/)
    expect(props.target_directory?.description).toMatch(/alias/i)
    expect(glob.input_schema.required).toEqual(["pattern"])
    expect(glob.input_schema.additionalProperties).toBe(false)
  })
})

describe("executeTool Glob", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tools-glob-"))
    mkdirSync(join(dir, "src", "lib"), { recursive: true })
    writeFileSync(join(dir, "src", "lib", "a.test.ts"), "export {}\n")
    writeFileSync(join(dir, "src", "lib", "b.ts"), "export {}\n")
    writeFileSync(join(dir, "README.md"), "# hi\n")
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("matches with canonical `pattern` + `path`", async () => {
    const r = await executeTool("Glob", { pattern: "src/lib/*.ts", path: dir })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("src/lib/a.test.ts")
    expect(r.content).toContain("src/lib/b.ts")
    expect(r.content).not.toContain("README.md")
  })

  it("matches with Cursor `glob_pattern` + `target_directory`", async () => {
    const r = await executeTool("Glob", {
      glob_pattern: "src/lib/*.test.ts",
      target_directory: dir,
    })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toBe("src/lib/a.test.ts")
  })

  it("does not throw Glob.constructor when pattern is missing", async () => {
    const r = await executeTool("Glob", {})
    expect(r.is_error).toBe(true)
    expect(r.content).toBe(globMissingPatternResult())
    expect(r.content).not.toMatch(/constructor/i)
  })

  it("does not throw Glob.constructor when pattern is not a string", async () => {
    const r = await executeTool("Glob", { pattern: ["**/*.ts"] })
    expect(r.is_error).toBe(true)
    expect(r.content).toBe(globArgNotStringResult("pattern", "array"))
    expect(r.content).not.toMatch(/constructor/i)
  })

  it("rejects a non-string path alias without scanning", async () => {
    const r = await executeTool("Glob", { pattern: "*.ts", target_directory: 1 })
    expect(r.is_error).toBe(true)
    expect(r.content).toBe(globArgNotStringResult("target_directory", "number"))
  })

  it("returns the no-match copy for a valid pattern with no hits", async () => {
    const r = await executeTool("Glob", { pattern: "does-not-exist-*.xyz", path: dir })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toBe("No files matched the pattern.")
  })
})
