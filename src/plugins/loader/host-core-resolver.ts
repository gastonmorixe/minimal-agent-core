/**
 * One copy of `@minimal-agent/core` per process.
 *
 * Plugins import the contract as `@minimal-agent/core/plugin-api/...`. A
 * plugin with its own `node_modules/@minimal-agent/core` would load a second
 * copy of those modules next to the host's copy. Module state, `instanceof`
 * checks, and registries would then split in two.
 *
 * {@link installHostCoreResolver} adds one Bun runtime plugin that stops this:
 *
 * - Each subpath in the host's `exports` map becomes a virtual module
 *   (`build.module`). An `import`, `import()`, or `require()` of that exact
 *   specifier, from any file, gets the host's own module. Its exports are
 *   the host module's values (the same objects and classes), read when it
 *   is first imported, so a binding the host reassigns later is not seen.
 * - A file inside any other `node_modules/@minimal-agent/core/` folder fails
 *   to load (`build.onLoad` throws). So a subpath that the host does not
 *   export cannot fall through to a plugin's own copy.
 *
 * Why not `build.onResolve`: at runtime Bun calls `onResolve` only for a
 * specifier that contains a "." or a ":" (see `Bun.plugin` in bun-types).
 * `@minimal-agent/core/plugin-api` has neither, so the callback never runs for
 * it. A virtual module matches the exact specifier, with no such rule.
 *
 * The host is the running core package: the `package.json` that this file's
 * own self-reference (`@minimal-agent/core/package.json`) resolves to.
 *
 * @module plugins/loader/host-core-resolver
 */

import { readFileSync } from "node:fs"
import { dirname } from "node:path"

const CORE = "@minimal-agent/core"
const STATE_KEY = Symbol.for("@minimal-agent/core/host-core-resolver")

/** What {@link installHostCoreResolver} set up for this process. */
export interface HostCoreResolver {
  /** Absolute path of the host core package (the folder of its `package.json`). */
  readonly root: string
  /** Each specifier served from the host, one per `exports` key. */
  readonly specifiers: readonly string[]
}

/**
 * Install the host-core runtime plugin once per process. Later calls return
 * the first install and register nothing.
 *
 * @returns The host root and the specifiers it serves.
 */
export function installHostCoreResolver(): HostCoreResolver {
  const state = globalThis as Record<symbol, HostCoreResolver | undefined>
  const existing = state[STATE_KEY]
  if (existing) return existing
  const pkgPath = Bun.resolveSync(`${CORE}/package.json`, import.meta.dir)
  const root = dirname(pkgPath)
  const specifiers = exportedSpecifiers(pkgPath)
  Bun.plugin({
    name: "minimal-agent-host-core",
    setup(build) {
      for (const specifier of specifiers) {
        build.module(specifier, () => ({
          exports: hostModuleExports(specifier, root),
          loader: "object",
        }))
      }
      build.onLoad({ filter: foreignCoreCopyFilter(root) }, (args) => {
        throw new Error(
          `refusing to load ${args.path}: it is in a second copy of ${CORE}. Plugins share ` +
            `the host copy at ${root} and can import only the subpaths its package.json exports.`,
        )
      })
    },
  })
  const installed: HostCoreResolver = { root, specifiers }
  state[STATE_KEY] = installed
  return installed
}

/**
 * The bare specifiers for the `exports` keys of the package at `pkgPath`.
 * A pattern key (with `*`) is not served: it has no single specifier.
 */
export function exportedSpecifiers(pkgPath: string): string[] {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports?: Record<string, unknown> }
  return Object.keys(pkg.exports ?? {})
    .filter((key) => key.startsWith(".") && !key.includes("*"))
    .map((key) => (key === "." ? CORE : `${CORE}${key.slice(1)}`))
}

/**
 * The `onLoad` filter for files of another core copy: a path with a
 * `node_modules/@minimal-agent/core/` segment that is not inside `root`.
 */
export function foreignCoreCopyFilter(root: string): RegExp {
  const sep = String.raw`[\\/]`
  const rootRe = root.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  return new RegExp(`^(?!${rootRe}${sep}).*${sep}node_modules${sep}@minimal-agent${sep}core${sep}`)
}

/**
 * The host module for `specifier`, shaped as the exports of a virtual module.
 * ESM gives its namespace. JSON and CommonJS give a plain value, so this
 * mirrors Bun's interop: `default` is that value and its keys are named exports.
 */
function hostModuleExports(specifier: string, root: string): Record<string, unknown> {
  const mod: unknown = require(Bun.resolveSync(specifier, root))
  if (Object.prototype.toString.call(mod) === "[object Module]") {
    return mod as Record<string, unknown>
  }
  return { ...(typeof mod === "object" && mod !== null ? mod : {}), default: mod }
}
