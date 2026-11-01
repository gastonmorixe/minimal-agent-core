/**
 * The core import guard (spec S2). Core source may not import the terminal
 * host folders (`cli`, `host`, `ui`, `input`, `terminal`). The rule covers
 * `import type`, type-position `import()`, literal dynamic `import()`, and
 * the config, logging, and network paths. Each fixture below is a
 * violation, and the guard must flag it. The repo scan itself is in
 * `core-host-import-scan.test.ts` and `zero-baselines.test.ts`.
 *
 * @module architecture/core-boundary-guard.test
 */

import { existsSync } from "node:fs"
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
