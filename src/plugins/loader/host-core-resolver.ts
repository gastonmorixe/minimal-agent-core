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
 * Where the host modules come from: {@link HOST_CORE_MODULES}, a generated
 * map with one static `require()` per export. No export is resolved by
 * package name at run time; only the host root is, and only from source (see
 * below). That matters in a compiled binary (`bun build --compile`): there
 * `import.meta.dir` is the virtual `/$bunfs/root` and no `node_modules`
 * exists, so a `Bun.resolveSync` of a core specifier throws. The static
 * requires also make the bundler embed every public module, which plugins on
 * disk may import.
 *
 * The host root: from source, the folder of the `package.json` that this
 * file's own self-reference (`@minimal-agent/core/package.json`) resolves to.
 * In a compiled binary, the virtual dir of the bundle. No file on disk is
 * inside it, so every on-disk core copy counts as foreign.
 *
 * @module plugins/loader/host-core-resolver
 */

import { dirname } from "node:path"

import { HOST_CORE_MODULES } from "./host-core-modules.ts"

const CORE = "@minimal-agent/core"
const STATE_KEY = Symbol.for("@minimal-agent/core/host-core-resolver")

/** What {@link installHostCoreResolver} set up for this process. */
export interface HostCoreResolver {
  /**
   * Absolute path of the host core package (the folder of its
   * `package.json`). In a compiled binary, the virtual bundle dir.
   */
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
  const root = hostCoreRoot()
  const specifiers = Object.keys(HOST_CORE_MODULES)
  Bun.plugin({
    name: "minimal-agent-host-core",
    setup(build) {
      for (const [specifier, load] of Object.entries(HOST_CORE_MODULES)) {
        // Synchronous on purpose: an async callback breaks a plugin's
        // `require()` of the specifier.
        build.module(specifier, () => ({ exports: asModuleExports(load()), loader: "object" }))
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
 * True when this code runs from a `bun build --compile` binary. Read through
 * a narrow cast: hosts typecheck this file with their own (older) bun-types,
 * which may not declare `Bun.isStandaloneExecutable`.
 */
export function isStandaloneExecutable(): boolean {
  return (Bun as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true
}

/** The host root. See the module doc. */
function hostCoreRoot(): string {
  if (isStandaloneExecutable()) return import.meta.dir
  return dirname(Bun.resolveSync(`${CORE}/package.json`, import.meta.dir))
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
 * A loaded host module, shaped as the exports of a virtual module.
 *
 * - From source, `require()` of an ES module gives its namespace: as is.
 * - In a compiled binary, the bundler gives a plain object marked
 *   `__esModule: true` instead: its own keys, `default` included, are the
 *   module's exports, so they are copied as they are (no `__esModule` key).
 * - JSON and CommonJS give a plain value, so this mirrors Bun's interop:
 *   `default` is that value and its keys are named exports (the
 *   `package.json` export).
 */
export function asModuleExports(mod: unknown): Record<string, unknown> {
  if (Object.prototype.toString.call(mod) === "[object Module]") {
    return mod as Record<string, unknown>
  }
  if (typeof mod === "object" && mod !== null && "__esModule" in mod && mod.__esModule === true) {
    const { __esModule: _marker, ...exports } = mod as Record<string, unknown>
    return exports
  }
  return { ...(typeof mod === "object" && mod !== null ? mod : {}), default: mod }
}
