/**
 * SPEC-HELP M-14a: `loadPluginCliCommand` loads one plugin CLI command
 * handler with the catalog gates, keeps the handler path inside the
 * package, and imports exactly one module.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { buildPluginCliCatalog, type CatalogOverridesInput } from "./catalog.ts"
import { importedModules } from "./cli-command-fixtures/import-log.ts"
import { type LoadPluginCliCommandInput, loadPluginCliCommand } from "./cli-command-loader.ts"

const FIXTURES = join(import.meta.dir, "cli-command-fixtures", "plugins")

function noOverrides(): CatalogOverridesInput {
  return { config: { forceDisabled: new Set(), forceEnabled: new Set() } }
}

function input(
  pluginId: string,
  path: string[],
  extra: Partial<LoadPluginCliCommandInput> = {},
): LoadPluginCliCommandInput {
  return {
    pluginId,
    path,
    roots: { embedded: [FIXTURES] },
    overrides: noOverrides(),
    effectivePlatform: "linux",
    warn: () => {},
    ...extra,
  }
}

/**
 * Build a temp plugin root with one package `id` whose commands use the
 * given handler paths, let `setup` add files, run `body`, then delete the
 * root.
 */
async function withPackage(
  id: string,
  commands: { name: string; path: string }[],
  setup: (root: string, pkg: string) => void,
  body: (roots: { embedded: string[] }, pkg: string, root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ma-clicmd-"))
  try {
    const pkg = join(root, id)
    mkdirSync(pkg)
    writeFileSync(
      join(pkg, "manifest.json"),
      JSON.stringify({
        id,
        name: id,
        version: "0.1.0",
        description: "Command loader temp fixture",
        cli: {
          contractVersion: 1,
          commands: commands.map((c) => ({
            name: c.name,
            summary: c.name,
            handler: { type: "module", path: c.path },
          })),
        },
      }),
    )
    setup(root, pkg)
    await body({ embedded: [root] }, pkg, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Run `fn` and return the fixture modules it imported. */
async function importsOf<T>(fn: () => Promise<T>): Promise<{ result: T; imported: string[] }> {
  const before = importedModules().length
  const result = await fn()
  return { result, imported: importedModules().slice(before) }
}

describe("loadPluginCliCommand", () => {
  test("loads a nested command handler and imports only that module", async () => {
    const { result, imported } = await importsOf(() =>
      loadPluginCliCommand(input("ma-clicmd-ok", ["sched", "list"])),
    )
    expect(imported).toEqual(["ok/list"])
    if (!result.ok) throw new Error(result.message)
    expect(result.spec.name).toBe("list")
    expect(result.entryAbsolute).toBe(
      realpathSync(join(FIXTURES, "ma-clicmd-ok", "handlers", "list.ts")),
    )
    const out: string[] = []
    const code = await result.handler({
      path: ["sched", "list"],
      args: {},
      flags: {},
      env: {},
      stdout: { write: (s) => out.push(s) },
      stderr: { write: () => {} },
    })
    expect(code).toBe(7)
    expect(out).toEqual(["list sched list\n"])
  })

  test("walks aliases", async () => {
    const result = await loadPluginCliCommand(input("ma-clicmd-ok", ["sc", "list"]))
    expect(result.ok).toBe(true)
  })

  test("unknown plugin", async () => {
    const result = await loadPluginCliCommand(input("ma-clicmd-nope", ["x"]))
    expect(result).toMatchObject({ ok: false, reason: "unknown-plugin" })
  })

  test("manifest opt-out gives disabled with note manifest, no import", async () => {
    const { result, imported } = await importsOf(() =>
      loadPluginCliCommand(input("ma-clicmd-off", ["offcmd"])),
    )
    expect(result).toMatchObject({ ok: false, reason: "disabled", note: "manifest" })
    expect(imported).toEqual([])
  })

  test("a CLI disable override gives disabled with note cli, no import", async () => {
    const overrides: CatalogOverridesInput = {
      ...noOverrides(),
      cli: { disable: ["ma-clicmd-ok"] },
    }
    const { result, imported } = await importsOf(() =>
      loadPluginCliCommand(input("ma-clicmd-ok", ["other"], { overrides })),
    )
    expect(result).toMatchObject({ ok: false, reason: "disabled", note: "cli" })
    expect(imported).toEqual([])
  })

  test("an env disable override gives disabled with note env", async () => {
    const overrides: CatalogOverridesInput = { ...noOverrides(), env: { disable: "ma-clicmd-ok" } }
    const result = await loadPluginCliCommand(input("ma-clicmd-ok", ["other"], { overrides }))
    expect(result).toMatchObject({ ok: false, reason: "disabled", note: "env" })
  })

  test("platform whitelist gives disabled with note platform", async () => {
    const { result, imported } = await importsOf(() =>
      loadPluginCliCommand(input("ma-clicmd-macos", ["maccmd"])),
    )
    expect(result).toMatchObject({ ok: false, reason: "disabled", note: "platform" })
    expect(imported).toEqual([])
  })

  test("platform whitelist passes on the allowed platform", async () => {
    const result = await loadPluginCliCommand(
      input("ma-clicmd-macos", ["maccmd"], { effectivePlatform: "macos" }),
    )
    expect(result.ok).toBe(true)
  })

  test("a force-enable override revives a manifest opt-out", async () => {
    const overrides: CatalogOverridesInput = {
      ...noOverrides(),
      cli: { enable: ["ma-clicmd-off"] },
    }
    const result = await loadPluginCliCommand(input("ma-clicmd-off", ["offcmd"], { overrides }))
    if (!result.ok) throw new Error(result.message)
    expect(await result.handler({} as never)).toBe(3)
  })

  test("unknown command path, empty path, and a group with no handler", async () => {
    expect(await loadPluginCliCommand(input("ma-clicmd-ok", ["sched", "nope"]))).toMatchObject({
      ok: false,
      reason: "no-command",
    })
    expect(await loadPluginCliCommand(input("ma-clicmd-ok", []))).toMatchObject({
      ok: false,
      reason: "no-command",
    })
    expect(await loadPluginCliCommand(input("ma-clicmd-ok", ["sched"]))).toMatchObject({
      ok: false,
      reason: "no-handler",
    })
    expect(await loadPluginCliCommand(input("ma-clicmd-ok", ["nohandler"]))).toMatchObject({
      ok: false,
      reason: "no-handler",
    })
  })

  test("rejects an absolute handler path with reason path", async () => {
    const { result, imported } = await importsOf(() =>
      loadPluginCliCommand(input("ma-clicmd-ok", ["abs"])),
    )
    expect(result).toMatchObject({ ok: false, reason: "path" })
    expect(imported).toEqual([])
  })

  test("rejects a ../ handler path that escapes the package, no import", async () => {
    for (const cmd of ["escape", "deepescape"]) {
      const { result, imported } = await importsOf(() =>
        loadPluginCliCommand(input("ma-clicmd-ok", [cmd])),
      )
      expect(result).toMatchObject({ ok: false, reason: "path" })
      expect(imported).toEqual([])
    }
  })

  test("rejects a symlink that points outside the package", async () => {
    const root = mkdtempSync(join(tmpdir(), "ma-clicmd-link-"))
    try {
      const pkg = join(root, "ma-clicmd-link")
      mkdirSync(pkg)
      writeFileSync(join(root, "outside.ts"), "export default async () => 0\n")
      symlinkSync(join(root, "outside.ts"), join(pkg, "link.ts"))
      writeFileSync(
        join(pkg, "manifest.json"),
        JSON.stringify({
          id: "ma-clicmd-link",
          name: "Link",
          version: "0.1.0",
          description: "Symlink escape fixture",
          cli: {
            contractVersion: 1,
            commands: [
              { name: "link", summary: "Link", handler: { type: "module", path: "./link.ts" } },
            ],
          },
        }),
      )
      const result = await loadPluginCliCommand(
        input("ma-clicmd-link", ["link"], { roots: { embedded: [root] } }),
      )
      expect(result).toMatchObject({ ok: false, reason: "path" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // M14A-1: Bun resolves a directory import through package.json `main` or
  // an implicit index.* file. Both fixtures point at the second plugin's
  // handler, outside the package. No import may happen.
  test("rejects a directory handler path whose package.json main is outside, no import", async () => {
    const { result, imported } = await importsOf(() =>
      loadPluginCliCommand(input("ma-clicmd-dir", ["dirmain"])),
    )
    expect(result).toMatchObject({ ok: false, reason: "path" })
    if (!result.ok) expect(result.message).toContain("is not a regular file")
    expect(imported).toEqual([])
  })

  test("rejects a directory handler path with an index.ts that re-exports from outside, no import", async () => {
    const { result, imported } = await importsOf(() =>
      loadPluginCliCommand(input("ma-clicmd-dir", ["dirindex"])),
    )
    expect(result).toMatchObject({ ok: false, reason: "path" })
    expect(imported).toEqual([])
  })

  test("rejects a directory handler path whose index.ts is a symlink to outside", async () => {
    await withPackage(
      "ma-clicmd-dirlink",
      [{ name: "d", path: "./d" }],
      (root, pkg) => {
        writeFileSync(join(root, "outside.ts"), "export default async () => 0\n")
        mkdirSync(join(pkg, "d"))
        symlinkSync(join(root, "outside.ts"), join(pkg, "d", "index.ts"))
      },
      async (roots) => {
        const result = await loadPluginCliCommand(input("ma-clicmd-dirlink", ["d"], { roots }))
        expect(result).toMatchObject({ ok: false, reason: "path" })
      },
    )
  })

  test("imports the real path of an inside symlink, not the link path", async () => {
    await withPackage(
      "ma-clicmd-inlink",
      [{ name: "l", path: "./link.ts" }],
      (_root, pkg) => {
        mkdirSync(join(pkg, "lib"))
        writeFileSync(join(pkg, "lib", "real.ts"), "export default async () => 5\n")
        symlinkSync(join(pkg, "lib", "real.ts"), join(pkg, "link.ts"))
      },
      async (roots, pkg) => {
        const result = await loadPluginCliCommand(input("ma-clicmd-inlink", ["l"], { roots }))
        if (!result.ok) throw new Error(result.message)
        expect(result.entryAbsolute).toBe(realpathSync(join(pkg, "lib", "real.ts")))
      },
    )
  })

  test("a broken symlink handler gives not-found, not a throw", async () => {
    await withPackage(
      "ma-clicmd-broken",
      [{ name: "b", path: "./gone.ts" }],
      (root, pkg) => symlinkSync(join(root, "nothing.ts"), join(pkg, "gone.ts")),
      async (roots) => {
        const result = await loadPluginCliCommand(input("ma-clicmd-broken", ["b"], { roots }))
        expect(result).toMatchObject({ ok: false, reason: "not-found" })
      },
    )
  })

  test("rejects a handler file whose name holds ? (Bun import query), no import of the sibling", async () => {
    await withPackage(
      "ma-clicmd-query",
      [{ name: "q", path: "./q.ts?raw" }],
      (root, pkg) => {
        writeFileSync(join(pkg, "q.ts?raw"), "export default async () => 0\n")
        writeFileSync(join(root, "outside.ts"), "export default async () => 0\n")
        symlinkSync(join(root, "outside.ts"), join(pkg, "q.ts"))
      },
      async (roots) => {
        const result = await loadPluginCliCommand(input("ma-clicmd-query", ["q"], { roots }))
        expect(result).toMatchObject({ ok: false, reason: "path" })
      },
    )
  })

  // M14A-4: plugin data must not put ESC or other C0 controls in a message.
  test("an ESC in the handler path does not reach the message", async () => {
    await withPackage(
      "ma-clicmd-esc",
      [
        { name: "missing", path: "./\u001b[31mred.ts" },
        { name: "escape", path: "../\u001b]0;title\u0007.ts" },
      ],
      () => {},
      async (roots) => {
        for (const cmd of ["missing", "escape"]) {
          const result = await loadPluginCliCommand(input("ma-clicmd-esc", [cmd], { roots }))
          if (result.ok) throw new Error("expected a failure")
          expect(result.message).not.toMatch(/[\u0000-\u001f\u007f]/)
          expect(result.message).toContain("\\u001b")
        }
      },
    )
  })

  // M14A-5: the old catalog threw ENOENT here too (probe: research scratch).
  test("a broken symlink in a plugin root is skipped with a warn, not a throw", async () => {
    await withPackage(
      "ma-clicmd-rootlink",
      [{ name: "r", path: "./run.ts" }],
      (root, pkg) => {
        writeFileSync(join(pkg, "run.ts"), "export default async () => 4\n")
        symlinkSync(join(root, "no-such-dir"), join(root, "ma-broken-entry"))
      },
      async (roots, _pkg, root) => {
        const warns: string[] = []
        const catalog = buildPluginCliCatalog(roots, noOverrides(), {
          effectivePlatform: "linux",
          warn: (m) => warns.push(m),
        })
        expect(catalog.map((e) => e.pluginId)).toEqual(["ma-clicmd-rootlink"])
        expect(warns).toHaveLength(1)
        expect(warns[0]).toContain(join(root, "ma-broken-entry"))
        const result = await loadPluginCliCommand(
          input("ma-clicmd-rootlink", ["r"], { roots, warn: () => {} }),
        )
        if (!result.ok) throw new Error(result.message)
        expect(await result.handler({} as never)).toBe(4)
      },
    )
  })

  test("missing handler file gives not-found", async () => {
    expect(await loadPluginCliCommand(input("ma-clicmd-ok", ["missing"]))).toMatchObject({
      ok: false,
      reason: "not-found",
    })
  })

  test("a module with no default export function gives reason export", async () => {
    const { result, imported } = await importsOf(() =>
      loadPluginCliCommand(input("ma-clicmd-ok", ["noexport"])),
    )
    expect(result).toMatchObject({ ok: false, reason: "export" })
    expect(imported).toEqual(["ok/noexport"])
  })

  test("a module that throws at import gives reason import", async () => {
    const result = await loadPluginCliCommand(input("ma-clicmd-ok", ["boom"]))
    expect(result).toMatchObject({ ok: false, reason: "import" })
  })

  // Keep this test last. No load above selects `other` or the second
  // plugin (the escape paths point at the second plugin's handler), so
  // their modules must never have been imported in this file.
  test("never imported a module of another command or another plugin", () => {
    const all = importedModules()
    expect(all.length).toBeGreaterThan(0)
    expect(all).not.toContain("ok/other")
    expect(all).not.toContain("second/run")
  })
})

describe("@minimal-agent/core/host/plugin-cli-command", () => {
  test("the public subpath exports the same loader", async () => {
    const mod = await import("@minimal-agent/core/host/plugin-cli-command")
    expect(mod.loadPluginCliCommand).toBe(loadPluginCliCommand)
  })
})

// M14A-2: the internal scan carries the package dir (a machine path). It
// must not leak through the public catalog subpath.
describe("@minimal-agent/core/host/plugin-catalog", () => {
  test("exports only the public catalog values, not scanPluginCliCatalog", async () => {
    const mod: Record<string, unknown> = await import("@minimal-agent/core/host/plugin-catalog")
    expect(Object.keys(mod).sort()).toEqual([
      "buildPluginCatalog",
      "buildPluginCliCatalog",
      "scanPluginCatalog",
    ])
    expect("scanPluginCliCatalog" in mod).toBe(false)
  })
})
