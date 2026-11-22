/**
 * The core import guard (spec S2). Core source may not import the terminal
 * host folders (`cli`, `host`, `ui`, `input`, `terminal`). The rule covers
 * `import type`, type-position `import()`, literal dynamic `import()`, and
 * the config, logging, and network paths. Each fixture below is a
 * violation, and the guard must flag it. The repo scan itself is in
 * `core-host-import-scan.test.ts` and `zero-baselines.test.ts`.
 *
 * Paste plugin v3 (A4): the paste and clipboard code moved to the CLI
 * (`src/paste/`). A scan of all non-test `src/**` bans the old media file
 * imports and the clipboard tokens, with a planted-fixture self-test.
 *
 * @module architecture/core-boundary-guard.test
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { DEFAULT_HOST_ROOTS, scanSourceForHostImports } from "./core-host-import-scan.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..")

/** One violation fixture: a core file and a source line that the guard must flag. */
interface Fixture {
  readonly name: string
  readonly file: string
  readonly source: string
  readonly typeOnly: boolean
}

const FIXTURES: readonly Fixture[] = [
  {
    name: "import type into cli",
    file: "sdk/agent-core.ts",
    source: 'import type { Flags } from "../cli/flags.ts"',
    typeOnly: true,
  },
  {
    name: "export type from host",
    file: "sdk/events.ts",
    source: 'export type { Host } from "../host/host.ts"',
    typeOnly: true,
  },
  {
    name: "type-position import() into ui",
    file: "runtime/session.ts",
    source: 'let view: import("../ui/compositor.ts").Compositor | undefined',
    typeOnly: false,
  },
  {
    name: "literal dynamic import() into terminal",
    file: "tools/tools.ts",
    source: 'const mod = await import("../terminal/size.ts")',
    typeOnly: false,
  },
  {
    name: "config path imports cli",
    file: "config/config.ts",
    source: 'import { readFlags } from "../cli/flags.ts"',
    typeOnly: false,
  },
  {
    name: "logging path imports input",
    file: "logging/net-dbg.ts",
    source: 'import type { KeyEvent } from "../input/keys.ts"',
    typeOnly: true,
  },
  {
    name: "network path imports host",
    file: "network/client.ts",
    source: 'import { hostAgent } from "../host/agent.ts"',
    typeOnly: false,
  },
  {
    name: "multi-line import into ui",
    file: "llm/preflight.ts",
    source: 'import {\n  render,\n} from "../ui/render.ts"',
    typeOnly: false,
  },
]

describe("core import guard (S2)", () => {
  for (const fx of FIXTURES) {
    it(`flags ${fx.name}`, () => {
      const sites = scanSourceForHostImports(fx.source, fx.file, DEFAULT_HOST_ROOTS)
      expect(sites).toHaveLength(1)
      expect(sites[0]?.typeOnly).toBe(fx.typeOnly)
    })
  }

  it("does not flag a core-internal import", () => {
    const sites = scanSourceForHostImports(
      'import type { AgentEvent } from "../sdk/events.ts"',
      "runtime/session.ts",
      DEFAULT_HOST_ROOTS,
    )
    expect(sites).toEqual([])
  })

  it("covers every terminal host folder", () => {
    for (const folder of ["cli", "host", "ui", "input", "terminal"]) {
      expect(DEFAULT_HOST_ROOTS).toContain(`src/${folder}`)
    }
  })

  it("the plugin-api terminal modules are gone from core", () => {
    // S41 moved ansi, palette, and unified-diff to the CLI terminal-kit.
    const present = ["ansi", "palette", "unified-diff"].filter((name) =>
      existsSync(join(REPO_ROOT, "plugin-api", "src", "utils", `${name}.ts`)),
    )
    expect(present).toEqual([])
  })
})

/** Paste plugin v3 (A4): the host owns the paste and clipboard code. */
const PASTE_IMPORT_RE = /media\/(paste-intercept|clipboard|clipboard-token|detect)(\.ts)?["']/
const PASTE_TOKENS = [
  "fromClipboard",
  "readClipboardImage",
  "hasClipboardImage",
  "clipboardChangeCount",
  "pbpaste",
  "wl-paste",
  "xclip",
  "Get-Clipboard",
  "bracketedPaste",
] as const

/** Each paste-code violation in `source`, as `<rule>: <line>`. */
function pasteViolations(source: string): string[] {
  const out: string[] = []
  for (const line of source.split("\n")) {
    if (PASTE_IMPORT_RE.test(line)) out.push(`import: ${line.trim()}`)
    for (const tok of PASTE_TOKENS) if (line.includes(tok)) out.push(`${tok}: ${line.trim()}`)
  }
  return out
}

/** Every non-test `.ts` file under `dir`, recursively. */
function nonTestSources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...nonTestSources(p))
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p)
  }
  return out
}

describe("core has no paste or clipboard code (paste plugin v3, A4)", () => {
  it("no non-test src/** file imports the moved media files or uses a clipboard token", () => {
    const src = join(REPO_ROOT, "src")
    const hits = nonTestSources(src).flatMap((p) =>
      pasteViolations(readFileSync(p, "utf8")).map((v) => `${p.slice(src.length + 1)}: ${v}`),
    )
    expect(hits).toEqual([])
  })

  it("the moved media files are gone", () => {
    const present = ["paste-intercept", "clipboard", "clipboard-token", "detect"].filter((n) =>
      existsSync(join(REPO_ROOT, "src", "media", `${n}.ts`)),
    )
    expect(present).toEqual([])
  })

  it("flags a planted fixture: each import form and each token", () => {
    const planted = [
      'import { mediaPasteInterceptor } from "../media/paste-intercept.ts"',
      'export * from "../media/clipboard.ts"',
      'import { clipboardImageToken } from "./media/clipboard-token"',
      "import { looksLikeMediaDrop } from '../media/detect.ts'",
      ...PASTE_TOKENS.map((t) => `const x = ${JSON.stringify(t)}`),
    ].join("\n")
    expect(pasteViolations(planted)).toHaveLength(4 + PASTE_TOKENS.length)
  })

  it('allows the media registry origin tag "clipboard"', () => {
    const ok =
      'registry.registerBytesSync(bytes, "clipboard", "image/png")\ntype O = "drop" | "clipboard"'
    expect(pasteViolations(ok)).toEqual([])
  })
})
