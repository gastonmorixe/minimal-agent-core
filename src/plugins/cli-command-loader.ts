/**
 * Load ONE plugin CLI command handler by plugin id and command path
 * (SPEC-HELP R-39, M-14a). The CLI calls it on the `plugin <cmd>` route
 * after it picks the plugin from the catalog.
 *
 * Gates: the winning manifest and its on/off state come from
 * {@link scanPluginCliCatalog}, the same scan as `buildPluginCliCatalog`
 * (root precedence, invalid copies, enable overrides, platform whitelist).
 * This module adds no gate rule of its own.
 *
 * Import rule: it imports exactly one module, the selected handler. It
 * never imports a module of another command or another plugin. The handler
 * path must stay inside the plugin package dir (no absolute path, no `..`
 * escape, no symlink escape). It must name a regular file, not a directory:
 * Bun resolves a directory import through `package.json` `main` or an
 * implicit `index.*` file, which can name a module outside the package
 * (https://bun.com/docs/runtime/module-resolution). The loader imports the
 * checked real path, never the manifest path.
 *
 * All inputs come from arguments. It reads no environment variable.
 *
 * @module plugins/cli-command-loader
 */

import { realpathSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"

import type {
  CatalogCliNote,
  CliCommandHandler,
  CommandSpec,
} from "../../plugin-api/src/types/cli-contract.ts"
import type { NormalizedPlatform } from "../../plugin-api/src/utils/platform.ts"

import {
  type CatalogCliWinner,
  type CatalogOverridesInput,
  type CatalogRoots,
  scanPluginCliCatalog,
} from "./catalog.ts"
import type { CliWarn } from "./manifest-cli.ts"
import { hasUnsafeTextChar } from "./manifest-text.ts"
import { type PluginPackage, pluginPackageFor } from "./source.ts"

/** Input of {@link loadPluginCliCommand}. */
export interface LoadPluginCliCommandInput {
  /** Plugin id, for example `"ma-schedule-plugin"`. */
  pluginId: string
  /** Command path inside the plugin, without `plugin`. For example `["schedule", "list"]`. */
  path: readonly string[]
  /** The same plugin roots the catalog and the loader take. */
  roots: CatalogRoots
  /** The same override lists the catalog and the loader take. */
  overrides: CatalogOverridesInput
  /** The effective platform (`resolveEffectivePlatform`). */
  effectivePlatform: NormalizedPlatform
  /** Sink for manifest diagnostics. Default: the catalog default sink. */
  warn?: CliWarn
}

/**
 * Why a load failed:
 * - `"unknown-plugin"`: no manifest with this id in the roots.
 * - `"disabled"`: the plugin is off. `note` holds the catalog reason
 *   (`cli`, `env`, `config`, `manifest`, `platform`, `invalid`).
 * - `"no-command"`: the path does not match a command of the plugin.
 * - `"no-handler"`: the command exists but declares no handler.
 * - `"path"`: the handler path is absolute, resolves outside the package
 *   (also after symlinks), names a directory or another non-file entry, or
 *   its real path holds `?` or `#` (Bun reads those as an import suffix).
 * - `"not-found"`: the handler path does not exist.
 * - `"import"`: the import of the handler module threw.
 * - `"export"`: the module has no default export function.
 */
export type PluginCliCommandLoadFailure =
  | "unknown-plugin"
  | "disabled"
  | "no-command"
  | "no-handler"
  | "path"
  | "not-found"
  | "import"
  | "export"

/** Result of {@link loadPluginCliCommand}. */
export type PluginCliCommandLoadResult =
  | {
      ok: true
      /** The command spec at `path`. */
      spec: CommandSpec
      /** The default export of the handler module. */
      handler: CliCommandHandler
      /**
       * Real path (symlinks resolved) of the imported module, the exact
       * path the loader checked and imported. A machine-local absolute
       * path, for local diagnostics only. Do not write it to JSON help or
       * telemetry.
       */
      entryAbsolute: string
    }
  | {
      ok: false
      reason: PluginCliCommandLoadFailure
      /** Catalog note. Set when `reason` is `"disabled"`. */
      note?: CatalogCliNote
      /** One line, plain text. */
      message: string
    }

/** Load the handler of one plugin CLI command. See the module doc. */
export async function loadPluginCliCommand(
  input: LoadPluginCliCommandInput,
): Promise<PluginCliCommandLoadResult> {
  const { pluginId, path } = input
  const label = `plugin "${pluginId}" command "${path.join(" ")}"`
  const winner = findWinner(input)
  if (!winner) {
    return fail("unknown-plugin", `plugin "${pluginId}" not found`)
  }
  const { entry, packageDir } = winner
  if (!entry.effectiveOn || packageDir === undefined) {
    const note = entry.note
    return {
      ok: false,
      reason: "disabled",
      note,
      message: `plugin "${pluginId}" is disabled${note ? ` (reason: ${note})` : ""}`,
    }
  }

  const spec = findCommand(entry.cli?.commands ?? [], path)
  if (!spec) return fail("no-command", `${label} not found`)
  const handler = spec.handler
  if (!handler) return fail("no-handler", `${label} has no handler`)
  // parseCli rejects every other type (W1-3). Keep the check for safety.
  if (handler.type !== "module") return fail("no-handler", `${label} handler is not a module`)

  const pkg = pluginPackageFor(packageDir)
  const located =
    pkg.kind === "embedded"
      ? locateEmbedded(pkg, handler.path)
      : locateInside(packageDir, handler.path)
  if (!located.ok) return fail(located.reason, `${label}: ${located.message}`)
  // Import the checked REAL path, not the manifest path (M14A-1, M14A-6).
  // A symlink on the manifest path that changes after the check cannot
  // redirect the import, because the import does not walk that link again.
  // An embedded package has no symlinks: its table thunk is the module.
  const real = located.real

  let mod: { default?: unknown }
  try {
    mod = (pkg.kind === "embedded" ? await pkg.importModule(handler.path) : await import(real)) as {
      default?: unknown
    }
  } catch (e) {
    return fail("import", `${label}: failed to import ${quote(real)}: ${errText(e)}`)
  }
  if (typeof mod.default !== "function") {
    return fail("export", `${label}: ${quote(real)} has no default export function`)
  }
  return { ok: true, spec, handler: mod.default as CliCommandHandler, entryAbsolute: real }
}

function findWinner(input: LoadPluginCliCommandInput): CatalogCliWinner | undefined {
  const options = {
    effectivePlatform: input.effectivePlatform,
    ...(input.warn ? { warn: input.warn } : {}),
  }
  return scanPluginCliCatalog(input.roots, input.overrides, options).find(
    (w) => w.entry.pluginId === input.pluginId,
  )
}

/** Walk `path` strictly by name or alias. Empty path: no command. */
function findCommand(
  commands: readonly CommandSpec[],
  path: readonly string[],
): CommandSpec | undefined {
  if (path.length === 0) return undefined
  let level: readonly CommandSpec[] = commands
  let node: CommandSpec | undefined
  for (const segment of path) {
    node = level.find((c) => c.name === segment || (c.aliases ?? []).includes(segment))
    if (!node) return undefined
    level = node.commands ?? []
  }
  return node
}

type Located =
  | { ok: true; real: string }
  | { ok: false; reason: "path" | "not-found"; message: string }

/**
 * Resolve a manifest handler path to the real path of a regular file
 * inside the package dir. Reject:
 * - an absolute path, or a path that resolves outside the package
 *   (lexical check);
 * - a path whose real path (after symlinks) is outside the real package
 *   dir;
 * - a path that names a directory or any non-file entry. Bun resolves a
 *   directory import through `package.json` `main` or `index.*`, so the
 *   module it imports would not be the checked path (M14A-1);
 * - a real path that holds `?` or `#`. Bun reads a `?` suffix as an import
 *   query (`?raw`, `?url`) even on an absolute path, and then imports the
 *   file before the `?`, not the checked file.
 *
 * A missing path, a broken symlink, or a file removed during the check
 * gives `not-found`, never a throw. `realpathSync` throws when the path
 * does not exist (https://nodejs.org/api/fs.html#fsrealpathsyncpath-options).
 * `statSync(real).isFile()` is false for a directory
 * (https://nodejs.org/api/fs.html#statsisfile).
 */
function locateInside(packageDir: string, rel: string): Located {
  const shown = quote(rel)
  if (isAbsolute(rel)) {
    return { ok: false, reason: "path", message: `handler path ${shown} must be relative` }
  }
  const abs = resolve(packageDir, rel)
  if (!isInside(packageDir, abs)) {
    return { ok: false, reason: "path", message: `handler path ${shown} escapes the package` }
  }
  let real: string
  let realPackageDir: string
  let isFile: boolean
  try {
    realPackageDir = realpathSync(packageDir)
    real = realpathSync(abs)
    isFile = statSync(real).isFile()
  } catch {
    return { ok: false, reason: "not-found", message: `handler module not found: ${shown}` }
  }
  if (!isInside(realPackageDir, real)) {
    return { ok: false, reason: "path", message: `handler path ${shown} escapes the package` }
  }
  if (!isFile) {
    return { ok: false, reason: "path", message: `handler path ${shown} is not a regular file` }
  }
  if (real.includes("?") || real.includes("#")) {
    return { ok: false, reason: "path", message: `handler path ${shown} holds "?" or "#"` }
  }
  return { ok: true, real }
}

/**
 * The embedded form of {@link locateInside}: the same lexical checks
 * (relative, inside the package), then the table must hold a module for
 * the path. `real` is the display path under the package dir.
 */
function locateEmbedded(pkg: PluginPackage, rel: string): Located {
  const shown = quote(rel)
  if (isAbsolute(rel)) {
    return { ok: false, reason: "path", message: `handler path ${shown} must be relative` }
  }
  const abs = resolve(pkg.dir, rel)
  if (!isInside(pkg.dir, abs)) {
    return { ok: false, reason: "path", message: `handler path ${shown} escapes the package` }
  }
  if (!pkg.hasFile(rel)) {
    return { ok: false, reason: "not-found", message: `handler module not found: ${shown}` }
  }
  return { ok: true, real: abs }
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Quote a path for a one-line message (M14A-4). `JSON.stringify` escapes
 * C0 controls, so ESC and newline cannot reach the terminal. A path that
 * still holds a C1 or bidi character after that is not shown.
 */
function quote(path: string): string {
  const json = JSON.stringify(path)
  return hasUnsafeTextChar(json) ? "<path with control or bidi characters>" : json
}

function fail(reason: PluginCliCommandLoadFailure, message: string): PluginCliCommandLoadResult {
  return { ok: false, reason, message }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
