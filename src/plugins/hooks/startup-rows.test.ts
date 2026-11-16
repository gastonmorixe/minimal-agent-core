/**
 * The `startup.rows` chain channel: catalog entry, manifest hook
 * subscription accepted by the loader, and row appending through
 * `emitChain`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { StartupRow, StartupRowsPayload } from "@minimal-agent/core/plugin-api"
import type { LoadedPlugin } from "@minimal-agent/core/plugin-api/types/plugin"

import { resolvePluginHookSubs } from "../loader/hook-subs.ts"

import { CHANNEL_BY_NAME, hasPermission } from "./channels.ts"
import { Hooks } from "./hooks.ts"

let scratch: string

beforeEach(() => {
  scratch = join(tmpdir(), `ma-startup-rows-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(scratch, { recursive: true })
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function pluginWith(permissions: string[]): LoadedPlugin {
  writeFileSync(
    join(scratch, "rows.ts"),
    "export default (p) => ({ payload: { ...p, rows: [...p.rows, { label: 'x', summary: [] }] } })\n",
  )
  return {
    packageDir: scratch,
    manifest: {
      id: "rows-test",
      permissions,
      hooks: [
        { id: "rows", channel: "startup.rows", handler: { type: "module", path: "./rows.ts" } },
      ],
    },
  } as unknown as LoadedPlugin
}

describe("startup.rows channel", () => {
  test("is a chain channel in the catalog with permission hooks:startup.rows", () => {
    const c = CHANNEL_BY_NAME.get("startup.rows")
    expect(c?.shape).toBe("chain")
    expect(c?.permission).toBe("hooks:startup.rows")
    expect(hasPermission(["hooks:startup.*"], "hooks:startup.rows")).toBe(true)
  })

  test("the loader accepts a manifest hook subscription on startup.rows", async () => {
    const logs: string[] = []
    const subs = await resolvePluginHookSubs(pluginWith(["hooks:startup.rows"]), (m) =>
      logs.push(m),
    )
    expect(logs).toEqual([])
    expect(subs.map((s) => s.definition.channel)).toEqual(["startup.rows"])
  })

  test("the loader drops the subscription without the permission", async () => {
    const logs: string[] = []
    const subs = await resolvePluginHookSubs(pluginWith([]), (m) => logs.push(m))
    expect(subs).toEqual([])
    expect(logs.join("\n")).toContain('requires permission "hooks:startup.rows"')
  })

  test("emitChain collects the rows of two listeners in order", async () => {
    const h = new Hooks({ logger: () => {} })
    const append =
      (row: StartupRow) =>
      (p: StartupRowsPayload): { payload: StartupRowsPayload } => ({
        payload: { ...p, rows: [...p.rows, row] },
      })
    const first: StartupRow = { label: "tools", summary: [{ text: "3", tone: "ok" }] }
    const second: StartupRow = {
      label: "hooks",
      summary: [{ text: "1 untrusted", tone: "warn" }],
      children: [{ label: "turn.willStop", value: [{ text: "run-tests.sh", tone: "accent" }] }],
    }
    h.on("startup.rows", append(first), { caller: "plugin", priority: 50 })
    h.on("startup.rows", append(second), { caller: "plugin", priority: 10 })
    const r = await h.emitChain<StartupRowsPayload>("startup.rows", {
      cwd: "/repo",
      cols: 80,
      rows: [],
    })
    expect(r.halted).toBe(false)
    expect(r.payload.rows).toEqual([first, second])
    expect(r.payload.cwd).toBe("/repo")
    expect(r.payload.cols).toBe(80)
  })
})
