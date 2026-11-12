/**
 * Plugin package sources: one interface over a plugin package on disk and
 * a plugin package embedded in a compiled binary.
 *
 * Every loader path that reads, imports, or runs a file of a plugin goes
 * through a {@link PluginPackage}. A disk package does what the loader did
 * before this module existed (`existsSync`, `readFileSync`, `import(abs)`
 * on `resolve(dir, rel)`), so a source run and a dev checkout behave the
 * same as before.
 *
 * An embedded package reads from a table the host registers at startup
 * with {@link registerEmbeddedPlugins}. The table holds text imports
 * (`manifest.json`, `provider.json`, `PROMPT.md`), literal
 * `() => import("...")` thunks for every entry module, and `$bunfs` paths of
 * the files a plugin runs (`gather.sh`). Core never imports generated code:
 * only a compiled host registers a table, so in a source run the embedded
 * tier holds disk roots only.
 *
 * Precedence by plugin id stays project, then user, then embedded. The
 * registered table sorts after every disk root of the embedded tier.
 *
 * @module plugins/source
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, posix, resolve } from "node:path"

import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"
import { isValidScriptId } from "@minimal-agent/core/plugin-api/utils/self-spawn"

/** The root tier a package was discovered under. */
export type PluginPackageRoot = "embedded" | "user" | "project"

/** Where the bytes of a package live. */
export type PluginPackageKind = "disk" | "embedded"

/**
 * One plugin package, on disk or embedded. Every `rel` argument is a path
 * as written in the manifest (`./handlers/a.ts`), relative to the package.
 * An absolute path passes through to the filesystem in both kinds, the same
 * as the loader's `resolvePath`.
 */
export interface PluginPackage {
  /** Package directory name, for example `ma-fetch-plugin`. */
  readonly name: string
  /**
   * Absolute package directory. Disk: the real directory. Embedded:
   * `<agentHome>/cache/embedded/<buildId>/<name>`, a real directory that
   * holds only the files {@link materializeEmbedded} extracted. Never a
   * `$bunfs` path. This is the value handlers see as `ctx.packageDir`.
   */
  readonly dir: string
  /** The root tier, when the package came from discovery. */
  readonly root?: PluginPackageRoot
  /** `disk` or `embedded`. */
  readonly kind: PluginPackageKind
  /** The absolute path of `rel`, for log lines and `entryAbsolute`. */
  resolve(rel: string): string
  /** The UTF-8 text of `rel`, or `null` when the package has no such file. */
  readText(rel: string): string | null
  /** Import the module `rel`. Rejects when it is missing or throws. */
  importModule(rel: string): Promise<unknown>
  /** Whether the package holds `rel`. */
  hasFile(rel: string): boolean
  /**
   * A disk path that can be passed to `Bun.spawn` for `rel`. Disk: the
   * resolved path. Embedded: the file extracted by
   * {@link materializeEmbedded} (mode 0755).
   */
  execPath(rel: string): string
}

/**
 * One package of an {@link EmbeddedPluginTable}. Keys of every map are
 * normalized package paths ({@link normalizePackagePath}): `handlers/a.ts`,
 * never `./handlers/a.ts`.
 */
export interface EmbeddedPluginPackageEntry {
  /** Text imports: `manifest.json`, `provider.json`, `PROMPT.md`, a custom `manifest.prompt`. */
  readonly texts: Readonly<Record<string, string>>
  /** Literal `() => import("<abs>")` thunks, one per entry module and script. */
  readonly modules: Readonly<Record<string, () => Promise<unknown>>>
  /** Files a plugin runs (`gather.sh`): the `$bunfs` path of a `type: "file"` import. */
  readonly files: Readonly<Record<string, string>>
}

/** The table a compiled host registers. Generated at build time. */
export interface EmbeddedPluginTable {
  /**
   * Identity of the build, for example `<cli-sha>-<core-sha>-<plugins-sha>`.
   * Names the extract cache directory, so an upgrade never runs a stale
   * script. Characters: `[A-Za-z0-9._-]`, 1 to 128.
   */
  readonly buildId: string
  /** Packages keyed by package directory name (`ma-fetch-plugin`). */
  readonly packages: Readonly<Record<string, EmbeddedPluginPackageEntry>>
}

/** Options for {@link registerEmbeddedPlugins}. */
export interface RegisterEmbeddedPluginsOptions {
  /**
   * Root of the extract cache. Default:
   * `<agentHome>/cache/embedded`, read when packages are listed (after the
   * host publishes `MINIMAL_AGENT_HOME`).
   */
  readonly cacheRoot?: string
}

const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Normalize a manifest-relative path to a table key: strip `./`, collapse
 * `a/../b`, use `/`. Returns `null` for a path that is empty, absolute,
 * holds a backslash or NUL, names a directory, or escapes the package.
 * The build-time generator must key its table with this same function.
 */
export function normalizePackagePath(rel: string): string | null {
  if (rel.length === 0 || rel.includes("\0") || rel.includes("\\")) return null
  if (isAbsolute(rel) || rel.startsWith("/")) return null
  if (rel.endsWith("/")) return null
  const n = posix.normalize(rel)
  if (n === "." || n === ".." || n.startsWith("../") || n.startsWith("/")) return null
  return n
}

/** Same as the loader's `resolvePath`: absolute paths pass through. */
function resolveOnDisk(dir: string, rel: string): string {
  return isAbsolute(rel) ? rel : resolve(dir, rel)
}

/** A package on disk. Behavior equals the pre-abstraction loader code. */
class DiskPluginPackage implements PluginPackage {
  readonly kind = "disk" as const
  readonly name: string
  readonly dir: string
  readonly root?: PluginPackageRoot

  constructor(dir: string, root: PluginPackageRoot | undefined) {
    this.dir = dir
    this.name = posix.basename(dir.replaceAll("\\", "/"))
    if (root !== undefined) this.root = root
  }

  resolve(rel: string): string {
    return resolveOnDisk(this.dir, rel)
  }

  readText(rel: string): string | null {
    const abs = this.resolve(rel)
    if (!existsSync(abs)) return null
    return readFileSync(abs, "utf-8")
  }

  importModule(rel: string): Promise<unknown> {
    return import(this.resolve(rel))
  }

  hasFile(rel: string): boolean {
    return existsSync(this.resolve(rel))
  }

  execPath(rel: string): string {
    return this.resolve(rel)
  }
}

/** A package of the registered table. */
class EmbeddedPluginPackage implements PluginPackage {
  readonly kind = "embedded" as const
  readonly root = "embedded" as const

  constructor(
    readonly name: string,
    readonly dir: string,
    private readonly entry: EmbeddedPluginPackageEntry,
  ) {}

  resolve(rel: string): string {
    if (isAbsolute(rel)) return rel
    const key = normalizePackagePath(rel)
    return key === null ? resolve(this.dir, rel) : join(this.dir, key)
  }

  readText(rel: string): string | null {
    if (isAbsolute(rel)) return existsSync(rel) ? readFileSync(rel, "utf-8") : null
    const key = normalizePackagePath(rel)
    if (key === null) return null
    const text = own(this.entry.texts, key)
    if (text !== undefined) return text
    const file = own(this.entry.files, key)
    return file === undefined ? null : readFileSync(file, "utf-8")
  }

  importModule(rel: string): Promise<unknown> {
    if (isAbsolute(rel)) return import(rel)
    const key = normalizePackagePath(rel)
    const thunk = key === null ? undefined : own(this.entry.modules, key)
    if (thunk === undefined) {
      return Promise.reject(new Error(`embedded module not found: ${this.name}/${rel}`))
    }
    return thunk()
  }

  hasFile(rel: string): boolean {
    if (isAbsolute(rel)) return existsSync(rel)
    const key = normalizePackagePath(rel)
    if (key === null) return false
    return (
      own(this.entry.texts, key) !== undefined ||
      own(this.entry.modules, key) !== undefined ||
      own(this.entry.files, key) !== undefined
    )
  }

  execPath(rel: string): string {
    if (isAbsolute(rel)) return rel
    const key = normalizePackagePath(rel)
    if (key === null || this.contentOf(key) === null) return this.resolve(rel)
    return materializeEmbedded(this, key)
  }

  /** The bytes of `key` (a file import or a text), or `null`. */
  contentOf(key: string): Uint8Array | null {
    const file = own(this.entry.files, key)
    if (file !== undefined) return readFileSync(file)
    const text = own(this.entry.texts, key)
    return text === undefined ? null : Buffer.from(text, "utf8")
  }
}

/** `record[key]` when it is an own property, else `undefined`. */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (record === undefined || !Object.hasOwn(record, key)) return undefined
  return record[key]
}

/** Build a disk package for `dir`. */
export function diskPluginPackage(dir: string, root?: PluginPackageRoot): PluginPackage {
  return new DiskPluginPackage(dir, root)
}

// ---------------------------------------------------------------------------
// Registered table
// ---------------------------------------------------------------------------

interface Registration {
  readonly table: EmbeddedPluginTable
  readonly cacheRoot: string | undefined
}

let registration: Registration | undefined
/** Embedded packages by `dir`, filled when packages are listed. */
const embeddedByDir = new Map<string, EmbeddedPluginPackage>()

/** Throw a `TypeError` when `table` does not have the table shape. */
function validateTable(table: EmbeddedPluginTable): void {
  if (table === null || typeof table !== "object") {
    throw new TypeError("embedded plugin table must be an object")
  }
  if (typeof table.buildId !== "string" || !SAFE_SEGMENT_RE.test(table.buildId)) {
    throw new TypeError(`embedded plugin table: invalid buildId ${JSON.stringify(table.buildId)}`)
  }
  if (table.packages === null || typeof table.packages !== "object") {
    throw new TypeError("embedded plugin table: packages must be an object")
  }
  for (const [name, entry] of Object.entries(table.packages)) {
    if (!SAFE_SEGMENT_RE.test(name) || name === "." || name === "..") {
      throw new TypeError(`embedded plugin table: invalid package name ${JSON.stringify(name)}`)
    }
    for (const field of ["texts", "modules", "files"] as const) {
      const map = entry?.[field]
      if (map === null || typeof map !== "object") {
        throw new TypeError(`embedded plugin table: ${name}.${field} must be an object`)
      }
      for (const key of Object.keys(map)) {
        if (normalizePackagePath(key) !== key) {
          throw new TypeError(
            `embedded plugin table: ${name}.${field} key ${JSON.stringify(key)} is not a normalized package path`,
          )
        }
        const value = (map as Record<string, unknown>)[key]
        const want = field === "modules" ? "function" : "string"
        if (typeof value !== want) {
          throw new TypeError(`embedded plugin table: ${name}.${field}[${key}] must be a ${want}`)
        }
      }
    }
  }
}

/**
 * Register the embedded plugin table. A compiled host calls this once at
 * startup, before provider discovery and `PluginLoader.load`. A second
 * call replaces the table. Throws a `TypeError` for a malformed table.
 */
export function registerEmbeddedPlugins(
  table: EmbeddedPluginTable,
  options: RegisterEmbeddedPluginsOptions = {},
): void {
  validateTable(table)
  registration = { table, cacheRoot: options.cacheRoot }
  embeddedByDir.clear()
}

/** Drop the registered table. For tests. */
export function clearEmbeddedPlugins(): void {
  registration = undefined
  embeddedByDir.clear()
}

/** Whether a table is registered. */
export function hasEmbeddedPlugins(): boolean {
  return registration !== undefined
}

/** The extract cache root of the registered table, or `undefined`. */
function cacheRootOf(reg: Registration): string {
  return reg.cacheRoot ?? join(resolveAgentHome(), "cache", "embedded")
}

/**
 * The packages of the registered table, sorted by name. Empty when no
 * table is registered. Directories are not created here.
 */
export function embeddedPluginPackages(): PluginPackage[] {
  const reg = registration
  if (reg === undefined) return []
  const base = join(cacheRootOf(reg), reg.table.buildId)
  const out: PluginPackage[] = []
  for (const name of Object.keys(reg.table.packages).sort()) {
    const dir = join(base, name)
    let pkg = embeddedByDir.get(dir)
    if (pkg === undefined) {
      const entry = reg.table.packages[name]
      if (entry === undefined) continue
      pkg = new EmbeddedPluginPackage(name, dir, entry)
      embeddedByDir.set(dir, pkg)
    }
    out.push(pkg)
  }
  return out
}

/**
 * The package for a package directory: the embedded package whose `dir`
 * is `dir`, else a disk package. Loader stages that only carry
 * `packageDir` use this, so their signatures stay the same.
 */
export function pluginPackageFor(dir: string, root?: PluginPackageRoot): PluginPackage {
  if (registration !== undefined && !embeddedByDir.has(dir)) embeddedPluginPackages()
  return embeddedByDir.get(dir) ?? diskPluginPackage(dir, root)
}

/** Options for {@link materializeEmbedded}. */
export interface MaterializeOptions {
  /** File mode. Default `0o755` (the file is run). */
  readonly mode?: number
}

let tmpCounter = 0

/**
 * Write one embedded file to `<pkg.dir>/<rel>` and return that path, so it
 * can be run (`$bunfs` paths cannot be spawned, and `copyFileSync` from
 * `$bunfs` fails). Reads the bytes with `readFileSync` and writes a temp
 * file, then renames it, so a reader never sees a partial file. A file
 * that already exists with the same mode and the same bytes is reused, so a
 * same-length edit or a stale copy is rewritten. A disk
 * package returns `pkg.resolve(rel)` and writes nothing.
 *
 * Throws when `rel` is not a file of the package or the write fails.
 */
export function materializeEmbedded(
  pkg: PluginPackage,
  rel: string,
  options: MaterializeOptions = {},
): string {
  if (!(pkg instanceof EmbeddedPluginPackage)) return pkg.resolve(rel)
  const key = normalizePackagePath(rel)
  const bytes = key === null ? null : pkg.contentOf(key)
  if (key === null || bytes === null) {
    throw new Error(`embedded file not found: ${pkg.name}/${rel}`)
  }
  const mode = options.mode ?? 0o755
  const dest = join(pkg.dir, key)
  try {
    const st = statSync(dest)
    // Reuse only an exact copy: same mode, same size, same bytes. A size and
    // mode check alone would run a same-length edited or stale file.
    if (
      st.isFile() &&
      st.size === bytes.byteLength &&
      (st.mode & 0o777) === mode &&
      Buffer.from(bytes).equals(readFileSync(dest))
    ) {
      return dest
    }
  } catch {
    // Missing: extract below.
  }
  mkdirSync(dirname(dest), { recursive: true })
  tmpCounter += 1
  const tmp = `${dest}.tmp-${process.pid}-${tmpCounter}`
  try {
    writeFileSync(tmp, bytes, { mode })
    // `mode` on write is masked by the umask.
    chmodSync(tmp, mode)
    renameSync(tmp, dest)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  return dest
}

/**
 * Create the package directory of an embedded package (its
 * `ctx.packageDir`). A disk package is left alone. Returns `false` when
 * the directory cannot be created (a read-only home): the plugin still
 * loads, and only a handler that writes to `packageDir` fails.
 */
export function ensurePackageDir(pkg: PluginPackage): boolean {
  if (pkg.kind !== "embedded") return true
  try {
    mkdirSync(pkg.dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * Remove every build directory of the extract cache except the one of the
 * registered table. Returns the removed paths. Does nothing when no table
 * is registered. A process of an older build that still runs extracts its
 * files again on its next run, because {@link materializeEmbedded} checks
 * for the file each time.
 */
export function pruneEmbeddedCache(): string[] {
  const reg = registration
  if (reg === undefined) return []
  const root = cacheRootOf(reg)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (name === reg.table.buildId) continue
    const path = join(root, name)
    rmSync(path, { recursive: true, force: true })
    removed.push(path)
  }
  return removed
}

/**
 * The module thunk of the embedded script `id` (`<manifest-id>/<name>`),
 * from the manifest `scripts` map of the registered table, or `undefined`.
 * Only a valid script id is looked up, so a path is never accepted. A
 * compiled host's `__run` dispatcher can use it instead of a second
 * generated map.
 *
 * Contract: this is a BUILD-LEVEL allowlist. It answers "is this script
 * part of the binary", not "is its plugin selected". It ignores the
 * enabled flag, platform gates and user/project shadowing on purpose: a
 * disabled plugin never spawns its scripts, and the ids come only from
 * manifests compiled into the binary, so nothing outside the build can be
 * run. Known gap: a user-tier copy that shadows an embedded plugin still
 * gets the EMBEDDED script when a compiled host dispatches `__run`. When
 * two embedded packages declare the same manifest id, the first package
 * name in sorted order wins (discovery dedupes ids the same way).
 */
export function findEmbeddedScript(id: string): (() => Promise<unknown>) | undefined {
  if (!isValidScriptId(id)) return undefined
  const reg = registration
  if (reg === undefined) return undefined
  const slash = id.indexOf("/")
  const pluginId = id.slice(0, slash)
  const script = id.slice(slash + 1)
  for (const name of Object.keys(reg.table.packages).sort()) {
    const entry = reg.table.packages[name]
    const text = entry === undefined ? undefined : own(entry.texts, "manifest.json")
    if (entry === undefined || text === undefined) continue
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      continue
    }
    if (raw === null || typeof raw !== "object") continue
    const m = raw as { id?: unknown; scripts?: unknown }
    if (m.id !== pluginId || m.scripts === null || typeof m.scripts !== "object") continue
    const rel = own(m.scripts as Record<string, unknown>, script)
    if (typeof rel !== "string") return undefined
    const key = normalizePackagePath(rel)
    return key === null ? undefined : own(entry.modules, key)
  }
  return undefined
}
