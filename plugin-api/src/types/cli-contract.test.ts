import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import * as contract from "@minimal-agent/core/plugin-api/types/cli-contract"

import {
  CLI_CONTRACT_VERSION,
  type CatalogCliEntry,
  type CatalogCliRoot,
  type CliCommandHandler,
  type HelpModel,
  type ManifestCli,
} from "./cli-contract.ts"

/**
 * Every CatalogCliRoot member, checked both ways at typecheck: `satisfies`
 * rejects a value that is not a member, and `_allRoots` rejects a member
 * that is not in the list.
 */
const CATALOG_CLI_ROOTS = [
  "embedded",
  "user",
  "home",
  "project",
] as const satisfies readonly CatalogCliRoot[]
type MissingRoot = Exclude<CatalogCliRoot, (typeof CATALOG_CLI_ROOTS)[number]>
const _allRoots: [MissingRoot] extends [never] ? true : never = true

/**
 * The `PluginRootTier` members, read as text from the core source. The
 * plugin-api leaf rule (src/architecture/architecture.plugin-api-leaf.test.ts)
 * also scans test files and rejects any import that resolves into src/, even
 * a type-only one. A file read is not an import.
 */
function pluginRootTiers(): string[] {
  const roots = join(import.meta.dir, "..", "..", "..", "src", "plugins", "loader", "roots.ts")
  const decl = /export type PluginRootTier =([^\n]+)/u.exec(readFileSync(roots, "utf8"))?.[1]
  if (decl === undefined) throw new Error("PluginRootTier declaration not found in roots.ts")
  return [...decl.matchAll(/"([^"]+)"/gu)].map((m) => m[1] ?? "")
}

describe("cli-contract", () => {
  it("CatalogCliRoot has the same members as core PluginRootTier", () => {
    expect(_allRoots).toBe(true)
    const declared: string[] = [...CATALOG_CLI_ROOTS]
    expect(declared.sort()).toEqual(pluginRootTiers().sort())
  })

  it("pins contract version 1", () => {
    expect(CLI_CONTRACT_VERSION).toBe(1)
  })

  it("has only the version constant as a runtime value", () => {
    expect(Object.keys(contract)).toEqual(["CLI_CONTRACT_VERSION"])
  })

  it("keeps manifest, help, and catalog data JSON round-trip safe", () => {
    const cli: ManifestCli = {
      contractVersion: CLI_CONTRACT_VERSION,
      commands: [
        {
          name: "schedule",
          summary: "Manage scheduled tasks",
          commands: [
            {
              name: "list",
              summary: "List tasks",
              args: [{ name: "sid", summary: "Session id" }],
              flags: [
                { name: "all", short: "a", type: "boolean", summary: "Show all" },
                { name: "limit", type: "number", value: "optional", summary: "Max rows" },
              ],
              env: [{ name: "MA_SCHEDULE_LIMIT", summary: "Max rows", flag: "limit" }],
              examples: [{ argv: "schedule list --all", summary: "Show all tasks" }],
              seeAlso: [["schedule"]],
              handler: { type: "module", path: "./list.ts" },
            },
          ],
        },
      ],
      helpSections: [{ id: "notes", title: "NOTES", rows: [{ term: "a", summary: "b" }] }],
    }
    const model: HelpModel = {
      contractVersion: CLI_CONTRACT_VERSION,
      kind: "command",
      program: { name: "minimal-agent", version: "0.1.0" },
      path: ["schedule", "list"],
      sections: [
        {
          id: "flags",
          title: "FLAGS",
          groups: [{ title: "Output", rows: [{ term: "-a, --all", summary: "Show all", source: "plugin:x" }] }],
        },
      ],
    }
    const entry: CatalogCliEntry = {
      pluginId: "ma-x-plugin",
      root: "home",
      effectiveOn: false,
      note: "platform",
      cli,
      hostModes: [{ id: "x", description: "X mode", args: [{ name: "a", summary: "A" }] }],
    }
    for (const value of [cli, model, entry]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    }
  })

  it("types a handler that returns an exit code", async () => {
    const handler: CliCommandHandler = async (ctx) => {
      ctx.stdout.write(ctx.path.join(" "))
      return 0
    }
    let out = ""
    const code = await handler({
      path: ["schedule", "list"],
      args: {},
      flags: {},
      env: {},
      stdout: { write: (s) => (out += s) },
      stderr: { write: () => undefined },
    })
    expect(code).toBe(0)
    expect(out).toBe("schedule list")
  })
})
