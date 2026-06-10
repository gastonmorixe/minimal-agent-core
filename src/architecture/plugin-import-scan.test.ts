import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import {
  countByFile,
  isSrcImport,
  renderBaseline,
  scanPluginSrcImports,
  scanSourceForSrcImports,
} from "./plugin-import-scan.ts"

describe("isSrcImport", () => {
  it("flags relative escapes into src/ at any depth", () => {
    expect(isSrcImport("../../src/session-tokens.ts")).toBe(true)
    expect(isSrcImport("../../../src/plugins/types.ts")).toBe(true)
    expect(isSrcImport("../../../../src/x.ts")).toBe(true)
  })

  it("ignores intra-plugin relative imports", () => {
    expect(isSrcImport("./render.ts")).toBe(false)
    expect(isSrcImport("../lib/store.ts")).toBe(false)
    expect(isSrcImport("../../other-plugin/lib.ts")).toBe(false)
  })

  it("ignores bare and node: specifiers", () => {
    expect(isSrcImport("node:fs")).toBe(false)
    expect(isSrcImport("bun:test")).toBe(false)
    expect(isSrcImport("some-package")).toBe(false)
  })
})

describe("scanSourceForSrcImports", () => {
  it("finds runtime value imports", () => {
    const sites = scanSourceForSrcImports(
      `import { getSessionTokens } from "../../src/session-tokens.ts"\n`,
      "p/f.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(false)
    expect(sites[0].specifier).toBe("../../src/session-tokens.ts")
  })

  it("finds and classifies type-only imports", () => {
    const sites = scanSourceForSrcImports(
      `import type { TUIContext } from "../../../src/plugins/types.ts"\n`,
      "p/f.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(true)
  })

  it("finds export-from re-exports", () => {
    const sites = scanSourceForSrcImports(
      `export { x } from "../../src/util.ts"\nexport type { Y } from "../../src/types.ts"\n`,
      "p/f.ts",
    )
    expect(sites).toHaveLength(2)
  })

  it("finds dynamic import()", () => {
    const sites = scanSourceForSrcImports(`await import("../../src/lazy.ts")\n`, "p/f.ts")
    expect(sites).toHaveLength(1)
  })

  it("ignores imports inside comments", () => {
    const sites = scanSourceForSrcImports(
      `// import { x } from "../../src/dead.ts"\n/* import y from "../../src/dead2.ts" */\n`,
      "p/f.ts",
    )
    expect(sites).toHaveLength(0)
  })

  it("ignores clean files", () => {
    const sites = scanSourceForSrcImports(
      `import { z } from "./local.ts"\nimport { readFileSync } from "node:fs"\n`,
      "p/f.ts",
    )
    expect(sites).toHaveLength(0)
  })
})

describe("scanPluginSrcImports (filesystem walk)", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-scan-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("walks nested dirs, skips node_modules and dotdirs, sorts deterministically", () => {
    mkdirSync(join(root, "good-plugin", "lib"), { recursive: true })
    mkdirSync(join(root, "bad-plugin", "handlers"), { recursive: true })
    mkdirSync(join(root, "bad-plugin", "node_modules", "x"), { recursive: true })
    mkdirSync(join(root, ".hidden"), { recursive: true })
    writeFileSync(join(root, "good-plugin", "lib", "a.ts"), `import { x } from "./b.ts"\n`)
    writeFileSync(
      join(root, "bad-plugin", "handlers", "h.ts"),
      `import type { T } from "../../../src/plugins/types.ts"\nimport { f } from "../../../src/util.ts"\n`,
    )
    writeFileSync(
      join(root, "bad-plugin", "node_modules", "x", "ignored.ts"),
      `import { y } from "../../src/should-not-count.ts"\n`,
    )
    writeFileSync(join(root, ".hidden", "ignored.ts"), `import { y } from "../src/nope.ts"\n`)

    const sites = scanPluginSrcImports(root)
    expect(sites).toHaveLength(2)
    expect(sites.every((s) => s.file === "bad-plugin/handlers/h.ts")).toBe(true)

    const counts = countByFile(sites)
    expect(counts.get("bad-plugin/handlers/h.ts")).toBe(2)
    expect(counts.has("good-plugin/lib/a.ts")).toBe(false)
  })

  it("renderBaseline emits a paste-ready frozen literal", () => {
    const text = renderBaseline(scanPluginSrcImports(root))
    expect(text).toContain('["bad-plugin/handlers/h.ts", 2],')
    expect(text).toStartWith("const BASELINE = new Map<string, number>([")
  })
})
