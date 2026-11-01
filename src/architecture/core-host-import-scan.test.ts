import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import {
  countSitesByFile,
  DEFAULT_EXEMPT,
  DEFAULT_HOST_ROOTS,
  resolveFromSrc,
  resolvesToHostRoot,
  scanCoreHostImports,
  scanSourceForHostImports,
} from "./core-host-import-scan.ts"

describe("resolveFromSrc (path resolution against the importing file's dir)", () => {
  it("resolves ../host/ from a one-deep src file to the src/host tree", () => {
    expect(resolveFromSrc("ui/compositor.ts", "../host/ui/compositor.ts")).toBe(
      "src/host/ui/compositor.ts",
    )
  })

  it("resolves ../../host/ from a two-deep src file to the src/host tree", () => {
    expect(resolveFromSrc("ui/style/ansi.ts", "../../host/ui/style/ansi.ts")).toBe(
      "src/host/ui/style/ansi.ts",
    )
  })

  it("resolves ./host/ from a src-root file to src/host", () => {
    expect(resolveFromSrc("index.ts", "./host/cli/main.ts")).toBe("src/host/cli/main.ts")
  })
})

describe("resolvesToHostRoot (the violation predicate)", () => {
  it("flags ../host/ui/compositor.ts from src/ui/compositor.ts (VIOLATION)", () => {
    expect(resolvesToHostRoot("ui/compositor.ts", "../host/ui/compositor.ts")).toBe(true)
  })

  it("flags ../../host/ deep escapes", () => {
    expect(resolvesToHostRoot("ui/style/ansi.ts", "../../host/ui/style/ansi.ts")).toBe(true)
  })

  it("ignores bare and node:/bun: specifiers", () => {
    expect(resolvesToHostRoot("agent.ts", "node:path")).toBe(false)
    expect(resolvesToHostRoot("agent.ts", "bun:test")).toBe(false)
    expect(resolvesToHostRoot("agent.ts", "some-package")).toBe(false)
    // a bare specifier that merely STARTS with "host" is a package name
    expect(resolvesToHostRoot("agent.ts", "host/whatever")).toBe(false)
  })

  it("does not flag sibling dirs whose name merely starts with the host root", () => {
    expect(resolvesToHostRoot("ui/foo.ts", "../host-utils/x.ts")).toBe(false)
  })

  it("does not flag a non-host relative import (core-internal)", () => {
    expect(resolvesToHostRoot("ui/foo.ts", "../llm/messages.ts")).toBe(false)
    expect(resolvesToHostRoot("agent.ts", "./sdk/ports.ts")).toBe(false)
  })

  it("takes host roots as a parameter (survives the ../minimal-agent-host move)", () => {
    const roots = ["src/host", "../minimal-agent-host"]
    // from src/ui/foo.ts, three `../` escape above the repo root to the sibling
    expect(resolvesToHostRoot("ui/foo.ts", "../../../minimal-agent-host/cli/x.ts", roots)).toBe(
      true,
    )
    // with ONLY the future root configured, today's in-repo tree is not matched
    // (from src/ui/foo.ts, ../host/x.ts lands in src/host, not the future root)
    expect(resolvesToHostRoot("ui/foo.ts", "../host/x.ts", ["../minimal-agent-host"])).toBe(false)
  })
})

describe("scanSourceForHostImports (import-site extraction)", () => {
  it("finds a static re-export shim that escapes into src/host (the P3 shims)", () => {
    const sites = scanSourceForHostImports(
      `export * from "../host/ui/compositor.ts"\n`,
      "ui/compositor.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].specifier).toBe("../host/ui/compositor.ts")
    expect(sites[0].resolved).toBe("src/host/ui/compositor.ts")
    expect(sites[0].typeOnly).toBe(false)
  })

  it("flags imports into each deleted host folder", () => {
    for (const folder of ["host", "cli", "ui", "input", "terminal", "e2e"]) {
      const sites = scanSourceForHostImports(`import "../${folder}/x.ts"\n`, "agent/a.ts")
      expect(sites.map((x) => x.resolved)).toEqual([`src/${folder}/x.ts`])
    }
  })

  it("flags type-only imports with typeOnly:true", () => {
    const sites = scanSourceForHostImports(
      `import type { EditorKeyPayload } from "../host/editor-controller.ts"\n`,
      "agent/turn-attachments.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(true)
  })

  it("flags export type ... from with typeOnly:true", () => {
    const sites = scanSourceForHostImports(
      `export type { ReplaySidecarTask } from "../host/session-replay-derivers.ts"\n`,
      "agent/turn-attachments.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(true)
  })

  it("finds MULTI-LINE static imports (specifier on a later line)", () => {
    const source = [
      `import {`,
      `  type ReplayToolRenderer,`,
      `  registerReplayRenderer,`,
      `} from "../../host/session-replay-derivers.ts"`,
      ``,
    ].join("\n")
    const sites = scanSourceForHostImports(source, "plugins/loader/replay-renderers.ts")
    expect(sites).toHaveLength(1)
    expect(sites[0].specifier).toBe("../../host/session-replay-derivers.ts")
  })

  it("flags dynamic import with a LITERAL specifier into host", () => {
    // src-root file → `./host/` is the in-repo host tree
    const sites = scanSourceForHostImports(
      `const m = await import("./host/cli/main.ts")\n`,
      "agent.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(false)
  })

  it("ignores dynamic import with a computed (non-literal) argument", () => {
    expect(scanSourceForHostImports(`const m = await import(abs)\n`, "agent.ts")).toHaveLength(0)
    expect(
      scanSourceForHostImports(`const m = await import("./host/" + name)\n`, "agent.ts"),
    ).toHaveLength(0)
  })

  it('flags CommonJS require("literal") into host', () => {
    const sites = scanSourceForHostImports(`const x = require("./host/foo.ts")\n`, "agent.ts")
    expect(sites).toHaveLength(1)
    expect(sites[0].resolved).toBe("src/host/foo.ts")
  })

  it("ignores imports inside comments", () => {
    expect(
      scanSourceForHostImports(
        `// export * from "../host/dead.ts"\n/* import "../host/dead2.ts" */\n`,
        "ui/foo.ts",
      ),
    ).toHaveLength(0)
  })
})

describe("scanCoreHostImports (filesystem walk on a fixture tree)", () => {
  const root = mkdtempSync(join(tmpdir(), "core-host-scan-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("walks nested dirs and counts sites per file", () => {
    mkdirSync(join(root, "ui"), { recursive: true })
    mkdirSync(join(root, "llm"), { recursive: true })
    writeFileSync(join(root, "ui", "compositor.ts"), `export * from "../host/ui/compositor.ts"\n`)
    writeFileSync(join(root, "llm", "clean.ts"), `import { x } from "./other.ts"\n`)
    writeFileSync(
      join(root, "agent.ts"),
      `import { c } from "./host/ui/style/ansi.ts"\nimport type { T } from "./cli/parse-argv.ts"\n`,
    )

    const sites = scanCoreHostImports(root)
    expect(sites.map((s) => s.file)).toEqual(["agent.ts", "agent.ts", "ui/compositor.ts"])

    const counts = countSitesByFile(sites)
    expect(counts.get("agent.ts")).toBe(2)
    expect(counts.get("ui/compositor.ts")).toBe(1)
    expect(counts.has("llm/clean.ts")).toBe(false)
  })

  it("skips excluded files", () => {
    const sites = scanCoreHostImports(root, DEFAULT_HOST_ROOTS, new Set(["agent.ts"]))
    expect(sites.map((s) => s.file)).toEqual(["ui/compositor.ts"])
  })
})

// ---------------------------------------------------------------------------
// THE RATCHET: the repo-wide invariant. S34 moved the terminal host to
// minimal-agent-cli and deleted it from core. The baseline went 56 -> 34
// (P4-A, P4-B) -> 0 (P4-D). No core file may import a deleted host folder,
// and the folders must not come back.
// ---------------------------------------------------------------------------
describe("core→host import ratchet (repo invariant)", () => {
  const repoRoot = join(import.meta.dirname, "..", "..")
  const sites = scanCoreHostImports(join(repoRoot, "src"), DEFAULT_HOST_ROOTS, DEFAULT_EXEMPT)

  it("no core file imports a deleted host folder", () => {
    const lines = sites.map((x) => `  ${x.file}: ${x.specifier}`)
    expect(
      lines,
      lines.length > 0
        ? "Core imports the terminal host. The host lives in minimal-agent-cli.\n" +
            "Move the shared code behind a port in core.\n" +
            lines.join("\n")
        : "",
    ).toEqual([])
  })

  it("the deleted host folders do not exist", () => {
    const present = DEFAULT_HOST_ROOTS.filter((root) => existsSync(join(repoRoot, root)))
    expect(present).toEqual([])
  })
})
