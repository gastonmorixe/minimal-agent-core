/**
 * Project tool detection — "use whatever the project already has".
 *
 * We NEVER install anything. We probe the project root for tools that are
 * already present: a binary in `node_modules/.bin` or on `PATH`, and check
 * for known config files that signal the tool is configured for the project.
 *
 * Pure + synchronous: detection is a function of the filesystem at `root`, with
 * no spawning, so it unit-tests against temp fixtures. The returned
 * {@link DetectedTool}s are inert descriptors; the runner decides what to spawn.
 *
 * @module plugins/diagnostics/lib/detect
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** What kind of signal a detected tool produces. */
export type ToolKind = "type" | "lint" | "format" | "apple"

/** An inert descriptor of a tool found in the project. */
export interface DetectedTool {
  /** Stable id: `"tsgo"`, `"biome"`, `"oxlint"`, `"sourcekit-lsp"`, ... */
  id: string
  kind: ToolKind
  /** Absolute path to the resolved binary. */
  bin: string
  /** True when a config file or devDependency named this tool (a strong signal). */
  configFound: boolean
  /** True for tools we run as a long-lived LSP server (tsgo) vs spawn-per-call. */
  persistent: boolean
}

/** One entry in the detection registry: how to recognize a given tool. */
interface ToolSpec {
  id: string
  kind: ToolKind
  /** Binary name under `node_modules/.bin` (or on PATH when `fromPath` is true). */
  binName: string
  /** Config files that signal the tool is configured for this project. */
  configFiles: string[]
  /** package.json dependency names that signal the tool. */
  depNames: string[]
  /** When true, the tool is unusable without one of `requiresAnyOf` present. */
  requiresConfig: boolean
  /** Files (or globs like "*.xcodeproj") that must exist for the tool to have anything to check. */
  requiresAnyOf?: string[]
  persistent: boolean
  /** When true, resolve the binary from PATH instead of node_modules/.bin. */
  fromPath?: boolean
}

/**
 * The detection registry. Adding a new tool (prettier, eslint, pyright,
 * rust-analyzer, ...) is a single entry here : the Strategy/Adapter layers key
 * off `id`. Ordered type → lint → format → apple so reports read in that priority.
 */
const REGISTRY: ToolSpec[] = [
  {
    id: "tsgo",
    kind: "type",
    binName: "tsgo",
    configFiles: ["tsconfig.json", "jsconfig.json"],
    depNames: ["@typescript/native-preview", "typescript"],
    requiresConfig: true,
    requiresAnyOf: ["tsconfig.json", "jsconfig.json"],
    persistent: true,
  },
  {
    id: "oxlint",
    kind: "lint",
    binName: "oxlint",
    configFiles: [".oxlintrc.json", "oxlint.json", ".oxlintrc"],
    depNames: ["oxlint"],
    requiresConfig: false,
    persistent: false,
  },
  {
    id: "biome",
    kind: "format",
    binName: "biome",
    configFiles: ["biome.json", "biome.jsonc"],
    depNames: ["@biomejs/biome"],
    requiresConfig: false,
    persistent: false,
  },
  {
    id: "sourcekit-lsp",
    kind: "apple",
    binName: "sourcekit-lsp",
    configFiles: ["Package.swift"],
    depNames: [],
    requiresConfig: false,
    requiresAnyOf: ["Package.swift", "*.xcodeproj", "*.xcworkspace"],
    persistent: true,
    fromPath: true,
  },
]

/** Read package.json dependency maps, tolerant of a missing/malformed file. */
function readDeps(root: string): Record<string, string> {
  const pkgPath = join(root, "package.json")
  if (!existsSync(pkgPath)) return {}
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const map = pkg[key]
      if (map && typeof map === "object") {
        for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
          if (typeof v === "string") out[k] = v
        }
      }
    }
    return out
  } catch {
    // Malformed package.json: behave as if there were no deps (binary probe
    // still applies). Never throw into detection.
    return {}
  }
}

/** Injectable options for detection (used in tests to control PATH). */
export interface DetectOptions {
  /** PATH to use when resolving PATH-based tools. Defaults to `process.env.PATH`. */
  path?: string
}

/**
 * Resolve a binary name from a PATH string. Returns the first match or null.
 */
function resolveFromPath(binName: string, pathEnv?: string): string | null {
  const paths = (pathEnv ?? process.env.PATH ?? "").split(":")
  for (const dir of paths) {
    if (!dir) continue
    const candidate = join(dir, binName)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Check whether at least one pattern in `patterns` matches an entry in `root`.
 * Supports simple `*` globs (e.g. `"*.xcodeproj"`).
 */
function anyPatternMatches(root: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      if (existsSync(join(root, pattern))) return true
    } else {
      // Simple wildcard: convert to regex and test against directory entries
      const re = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`)
      try {
        const entries = readdirSync(root)
        if (entries.some((e) => re.test(e))) return true
      } catch {
        // Can't read directory — skip this pattern
      }
    }
  }
  return false
}

/**
 * Detect the diagnostic tools available in the project at `root`. Returns an
 * ordered list of {@link DetectedTool} descriptors (type, then lint, then
 * format). Empty when nothing is installed.
 *
 * Pass `options.path` to control PATH resolution for `fromPath` tools (used
 * in tests). Defaults to `process.env.PATH`.
 */
export function detectTools(root: string, options: DetectOptions = {}): DetectedTool[] {
  const deps = readDeps(root)
  const out: DetectedTool[] = []
  for (const spec of REGISTRY) {
    let bin: string | null
    if (spec.fromPath) {
      bin = resolveFromPath(spec.binName, options.path)
    } else {
      bin = join(root, "node_modules", ".bin", spec.binName)
      if (!existsSync(bin)) bin = null
    }
    if (bin === null) continue

    const hasConfigFile = spec.configFiles.some((f) => existsSync(join(root, f)))
    const hasDep = spec.depNames.some((d) => d in deps)
    const configFound = hasConfigFile || hasDep

    // A tool that requires config is skipped when none of its requiresAnyOf
    // files (or wildcard patterns) are present.
    if (spec.requiresAnyOf && !anyPatternMatches(root, spec.requiresAnyOf)) {
      continue
    }
    if (spec.requiresConfig && !configFound) continue

    out.push({ id: spec.id, kind: spec.kind, bin, configFound, persistent: spec.persistent })
  }
  return out
}
