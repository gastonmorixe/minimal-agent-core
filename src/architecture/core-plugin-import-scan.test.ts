import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import {
  countSitesByFile,
  renderBaseline,
  resolveFromSrc,
  resolvesToPluginRoot,
  scanCorePluginImports,
  scanSourceForPluginImports,
} from "./core-plugin-import-scan.ts"

describe("resolveFromSrc (path resolution against the importing file's dir)", () => {
  it("resolves ../plugins/ from a src-root file to the top-level plugins tree", () => {
    expect(resolveFromSrc("headers.ts", "../plugins/llm-anthropic/beta-gates.ts")).toBe(
      "plugins/llm-anthropic/beta-gates.ts",
    )
  })

  it("resolves ../plugins/ from a one-deep src file to src/plugins (core-internal)", () => {
    expect(resolveFromSrc("llm/provider.ts", "../plugins/types.ts")).toBe("src/plugins/types.ts")
  })

  it("resolves ../../plugins/ from a one-deep src file to the top-level plugins tree", () => {
    expect(resolveFromSrc("agent/foo.ts", "../../plugins/tasks/lib/parse.ts")).toBe(
      "plugins/tasks/lib/parse.ts",
    )
  })

  it("resolves ./plugins/ from a src-root file to src/plugins (core-internal)", () => {
    expect(resolveFromSrc("index.ts", "./plugins/loader.ts")).toBe("src/plugins/loader.ts")
  })

  it("resolves escapes above the repo root (future sibling plugin repo)", () => {
    expect(resolveFromSrc("headers.ts", "../../minimal-agent-plugins/x/y.ts")).toBe(
      "../minimal-agent-plugins/x/y.ts",
    )
  })
})

describe("resolvesToPluginRoot (the I2 violation predicate)", () => {
  // Case (a): ../plugins/ from src root escapes into top-level plugins/.
  it("flags ../plugins/llm-anthropic/beta-gates.ts from src/headers.ts (VIOLATION)", () => {
    expect(resolvesToPluginRoot("headers.ts", "../plugins/llm-anthropic/beta-gates.ts")).toBe(true)
  })

  // Case (b): ../plugins/ from src/llm/ lands in src/plugins/ — loader infra.
  it("does not flag ../plugins/types.ts from src/llm/provider.ts (resolves to src/plugins — LEGAL)", () => {
    expect(resolvesToPluginRoot("llm/provider.ts", "../plugins/types.ts")).toBe(false)
  })

  // Case (c): deeper relative escape still reaches top-level plugins/.
  it("flags ../../plugins/tasks/lib/parse.ts from src/agent/foo.ts (VIOLATION)", () => {
    expect(resolvesToPluginRoot("agent/foo.ts", "../../plugins/tasks/lib/parse.ts")).toBe(true)
  })

  // Case (d): ./plugins/ from src root is src/plugins/ — core-internal.
  it("does not flag ./plugins/loader.ts from src/index.ts (LEGAL)", () => {
    expect(resolvesToPluginRoot("index.ts", "./plugins/loader.ts")).toBe(false)
  })

  it("ignores bare and node:/bun: specifiers", () => {
    expect(resolvesToPluginRoot("headers.ts", "node:path")).toBe(false)
    expect(resolvesToPluginRoot("headers.ts", "bun:test")).toBe(false)
    expect(resolvesToPluginRoot("headers.ts", "some-package")).toBe(false)
    // A bare specifier that merely STARTS with "plugins" is a package name.
    expect(resolvesToPluginRoot("headers.ts", "plugins/whatever")).toBe(false)
  })

  it("does not flag sibling dirs whose name merely starts with a plugin root", () => {
    expect(resolvesToPluginRoot("headers.ts", "../plugins-extra/x.ts")).toBe(false)
  })

  it("takes plugin roots as a parameter (survives the ../minimal-agent-plugins move)", () => {
    const roots = ["plugins", "../minimal-agent-plugins"]
    expect(resolvesToPluginRoot("headers.ts", "../../minimal-agent-plugins/llm/x.ts", roots)).toBe(
      true,
    )
    expect(resolvesToPluginRoot("llm/provider.ts", "../plugins/types.ts", roots)).toBe(false)
    // With ONLY the future root configured, today's tree is not matched.
    expect(
      resolvesToPluginRoot("headers.ts", "../plugins/x.ts", ["../minimal-agent-plugins"]),
    ).toBe(false)
  })
})

describe("scanSourceForPluginImports (import-site extraction)", () => {
  it("finds a static runtime import that escapes into plugins/ (case a)", () => {
    const sites = scanSourceForPluginImports(
      `import { omitsInterleavedThinking } from "../plugins/llm-anthropic/beta-gates.ts"\n`,
      "headers.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].specifier).toBe("../plugins/llm-anthropic/beta-gates.ts")
    expect(sites[0].typeOnly).toBe(false)
    expect(sites[0].resolved).toBe("plugins/llm-anthropic/beta-gates.ts")
  })

  it("does not flag legal core-internal plugins/ imports (cases b and d)", () => {
    expect(
      scanSourceForPluginImports(
        `import type { ManifestFile } from "../plugins/types.ts"\n`,
        "llm/provider.ts",
      ),
    ).toHaveLength(0)
    expect(
      scanSourceForPluginImports(
        `import { PluginLoader } from "./plugins/loader.ts"\n`,
        "index.ts",
      ),
    ).toHaveLength(0)
  })

  it("flags deeper escapes from nested src dirs (case c)", () => {
    const sites = scanSourceForPluginImports(
      `import { parseFile } from "../../plugins/tasks/lib/parse.ts"\n`,
      "agent/foo.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].resolved).toBe("plugins/tasks/lib/parse.ts")
  })

  // Case (e): the loader's blessed seam — computed dynamic imports are NOT
  // literal specifiers and must not be flagged.
  it("ignores dynamic import with a computed (non-literal) argument", () => {
    expect(
      scanSourceForPluginImports(`const mod = await import(abs)\n`, "plugins/loader.ts"),
    ).toHaveLength(0)
    expect(
      scanSourceForPluginImports(`const mod = await import("../plugins/" + name)\n`, "headers.ts"),
    ).toHaveLength(0)
    expect(
      scanSourceForPluginImports(
        "const mod = await import(`../plugins/${name}/index.ts`)\n",
        "headers.ts",
      ),
    ).toHaveLength(0)
  })

  it("flags dynamic import with a LITERAL specifier into plugins/", () => {
    const sites = scanSourceForPluginImports(
      `const mod = await import("../plugins/tasks/lib/parse.ts")\n`,
      "index.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(false)
  })

  it("flags the inline import(...).Type type-position form", () => {
    const sites = scanSourceForPluginImports(
      `let sidecarTasks: import("../plugins/tasks/lib/parse.ts").Task[] = []\n`,
      "index.ts",
    )
    expect(sites).toHaveLength(1)
  })

  // Case (f): type-only still flagged, reported with typeOnly:true.
  it("flags export type ... from into plugins/ with typeOnly:true (case f)", () => {
    const sites = scanSourceForPluginImports(
      `export type { Task } from "../plugins/tasks/lib/parse.ts"\n`,
      "session-replay.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(true)
  })

  it("flags import type ... from into plugins/ with typeOnly:true", () => {
    const sites = scanSourceForPluginImports(
      `import type { Task } from "../plugins/tasks/lib/parse.ts"\n`,
      "session-replay.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(true)
  })

  it("flags runtime export-from re-exports with typeOnly:false", () => {
    const sites = scanSourceForPluginImports(
      `export { renderUnifiedDiff } from "../plugins/diff-view/handlers/render.ts"\n`,
      "diff.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(false)
  })

  it("finds MULTI-LINE static imports (specifier on a later line)", () => {
    const source = [
      `import {`,
      `  SaveEchoCollector,`,
      `  type EchoOpts,`,
      `} from "../plugins/memory/lib/save-echo.ts"`,
      ``,
    ].join("\n")
    const sites = scanSourceForPluginImports(source, "index.ts")
    expect(sites).toHaveLength(1)
    expect(sites[0].specifier).toBe("../plugins/memory/lib/save-echo.ts")
  })

  it("does not bleed a type alias declaration into a following import (no cross-statement match)", () => {
    const source = [
      `export type Foo = number`,
      `import { x } from "../plugins/tasks/lib/parse.ts"`,
      ``,
    ].join("\n")
    const sites = scanSourceForPluginImports(source, "index.ts")
    expect(sites).toHaveLength(1)
    // The import is a RUNTIME site; the preceding `export type` alias must
    // not make the lazy matcher classify it as type-only.
    expect(sites[0].typeOnly).toBe(false)
  })

  // m1 (phase1 review): bun supports CommonJS require() in .ts files, so a
  // literal require specifier is a real evasion channel for I2 — the lint
  // rule does not see it either. The scanner must flag it.
  it('flags CommonJS require("literal") into plugins/ (m1)', () => {
    const sites = scanSourceForPluginImports(
      `const x = require("../plugins/foo/bar.ts")\n`,
      "index.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].specifier).toBe("../plugins/foo/bar.ts")
    expect(sites[0].typeOnly).toBe(false)
    expect(sites[0].resolved).toBe("plugins/foo/bar.ts")
  })

  it("ignores require with a computed (non-literal) argument", () => {
    expect(scanSourceForPluginImports(`const x = require(abs)\n`, "index.ts")).toHaveLength(0)
    expect(
      scanSourceForPluginImports(`const x = require("../plugins/" + name)\n`, "index.ts"),
    ).toHaveLength(0)
  })

  // m2 (phase1 review): a NO-substitution template literal is a fully
  // static specifier at runtime — backticks are just a third quote
  // delimiter there. The blessed-seam carve-out is for genuinely COMPUTED
  // specifiers only, so the substitution-free form must be flagged.
  it("flags dynamic import with a no-substitution template-literal specifier (m2)", () => {
    const sites = scanSourceForPluginImports(
      "const mod = await import(`../plugins/x`)\n",
      "index.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].specifier).toBe("../plugins/x")
    expect(sites[0].resolved).toBe("plugins/x")
    expect(sites[0].typeOnly).toBe(false)
  })

  // Negative: template literals WITH ${…} substitutions stay unflagged —
  // that is the loader's blessed computed seam.
  it("still ignores template-literal dynamic imports WITH substitutions (blessed seam)", () => {
    expect(
      scanSourceForPluginImports(
        "const mod = await import(`../plugins/${name}/index.ts`)\n",
        "index.ts",
      ),
    ).toHaveLength(0)
  })

  it('finds side-effect imports (import "spec")', () => {
    const sites = scanSourceForPluginImports(`import "../plugins/tasks/lib/parse.ts"\n`, "index.ts")
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(false)
  })

  it("ignores imports inside comments", () => {
    const sites = scanSourceForPluginImports(
      `// import { x } from "../plugins/dead.ts"\n/* import { y } from "../plugins/dead2.ts" */\n`,
      "headers.ts",
    )
    expect(sites).toHaveLength(0)
  })

  it("respects a custom plugin-roots parameter", () => {
    const sites = scanSourceForPluginImports(
      `import { x } from "../../minimal-agent-plugins/llm/x.ts"\n`,
      "headers.ts",
      ["../minimal-agent-plugins"],
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].resolved).toBe("../minimal-agent-plugins/llm/x.ts")
  })
})

// m3 (phase1 review): TRIPWIRE, not a behavior test. The scanner's
// violation predicate ignores non-relative specifiers (a bare specifier is
// assumed to be a package), and the I2 lint rule's globs match `../plugins`
// ladders only. Both assumptions hold ONLY while tsconfig has no path
// aliases: a future `"paths": {"@plugins/*": ["plugins/*"]}` would let
// `import "@plugins/x"` resolve into the plugins tree while looking like a
// bare package specifier — blinding the scanner AND the lint rule
// simultaneously, with no failure anywhere. This test makes that hole
// self-announcing. It passes today (red is impossible: the repo has no
// `paths`); it exists to fail loudly the moment one appears, pointing
// whoever added it at the scanner work that must accompany it.
describe("tsconfig alias tripwire (m3)", () => {
  it("tsconfig.json declares NO compilerOptions.paths (aliases would blind the I2 scanner + lint globs)", () => {
    const raw = readFileSync(join(import.meta.dir, "..", "..", "tsconfig.json"), "utf8")
    const tsconfig = JSON.parse(raw) as {
      compilerOptions?: { paths?: unknown; baseUrl?: unknown }
    }
    expect(
      tsconfig.compilerOptions?.paths,
      "tsconfig.json gained compilerOptions.paths. Path aliases can map bare-looking " +
        "specifiers into plugins/, which the I2 scanner (relative-only resolution in " +
        "core-plugin-import-scan.ts) and the no-restricted-imports lint globs CANNOT see. " +
        "Before adding aliases, teach resolvesToPluginRoot() to expand them and extend the " +
        "lint rule. See private/decoupling-refactor-work/reports/phase1-review.md (m3).",
    ).toBeUndefined()
    expect(
      tsconfig.compilerOptions?.baseUrl,
      "tsconfig.json gained compilerOptions.baseUrl — the prerequisite for paths aliases. " +
        "Same risk as paths: see phase1-review.md (m3) before proceeding.",
    ).toBeUndefined()
  })
})

describe("scanCorePluginImports (filesystem walk)", () => {
  const root = mkdtempSync(join(tmpdir(), "core-plugin-scan-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("walks nested dirs and resolves each file's imports against its own dir", () => {
    mkdirSync(join(root, "agent"), { recursive: true })
    mkdirSync(join(root, "llm"), { recursive: true })
    // src-root file: ../plugins escapes → violation; ./plugins is internal.
    writeFileSync(
      join(root, "headers.ts"),
      `import { g } from "../plugins/llm-anthropic/beta-gates.ts"\nimport { l } from "./plugins/loader.ts"\n`,
    )
    // nested file: ../plugins resolves to src/plugins → legal.
    writeFileSync(
      join(root, "llm", "provider.ts"),
      `import type { T } from "../plugins/types.ts"\n`,
    )
    // nested file: ../../plugins escapes → violation (two sites in one file).
    writeFileSync(
      join(root, "agent", "foo.ts"),
      `import { a } from "../../plugins/tasks/lib/parse.ts"\nexport type { B } from "../../plugins/tasks/lib/render.ts"\n`,
    )

    const sites = scanCorePluginImports(root)
    expect(sites).toHaveLength(3)
    expect(sites.map((s) => s.file)).toEqual(["agent/foo.ts", "agent/foo.ts", "headers.ts"])

    const counts = countSitesByFile(sites)
    expect(counts.get("agent/foo.ts")).toBe(2)
    expect(counts.get("headers.ts")).toBe(1)
    expect(counts.has("llm/provider.ts")).toBe(false)
  })

  it("renderBaseline emits a paste-ready frozen literal", () => {
    const text = renderBaseline(scanCorePluginImports(root))
    expect(text).toStartWith("const BASELINE = new Map<string, number>([")
    expect(text).toContain('["agent/foo.ts", 2],')
    expect(text).toContain('["headers.ts", 1],')
  })
})
