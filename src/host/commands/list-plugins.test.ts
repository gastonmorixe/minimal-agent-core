import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { stripAnsi } from "../../terminal/term-width.ts"

import { runListPluginsCommand } from "./list-plugins.ts"

function writePlugin(root: string, name: string, manifest: Record<string, unknown>): void {
  const dir = join(root, "plugins", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
}

describe("runListPluginsCommand", () => {
  test("renders plugin table with state summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-list-plugins-"))
    try {
      writePlugin(dir, "demo", { id: "demo", name: "Demo Plugin" })
      writePlugin(dir, "off", { id: "off", name: "Off Plugin", enabled: false })

      let out = ""
      runListPluginsCommand({
        roots: { embeddedDir: dir },
        config: { forceDisabled: new Set(), forceEnabled: new Set() },
        output: { write: (s) => (out += s) },
      })
      const plain = stripAnsi(out)
      expect(plain).toContain("demo")
      expect(plain).toContain("Demo Plugin")
      expect(plain).toContain("off")
      expect(plain).toContain("2 plugins (1 on, 1 off)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
