/**
 * Project tool detection — "use whatever the project already has".
 *
 * We NEVER install anything. We probe the project root for tools that are
 * already present: a binary in `node_modules/.bin` (or, as a fallback, a
 * devDependency / config file that names the tool). This mirrors how OpenCode
 * gates each language server on a project devDep + binary, and how claude-lsp
 * keys services off config-file presence ("no config found = service off").
 *
 * Pure + synchronous: detection is a function of the filesystem at `root`, with
 * no spawning, so it unit-tests against temp fixtures. The returned
 * {@link DetectedTool}s are inert descriptors; the runner decides what to spawn.
 *
 * @module plugins/diagnostics/lib/detect
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** What kind of signal a detected tool produces. */
export type ToolKind = "type" | "lint" | "format"

/** An inert descriptor of a tool found in the project. */
export interface DetectedTool {
  /** Stable id: `"tsgo"`, `"biome"`, `"oxlint"`, ... */
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
  /** Binary name under `node_modules/.bin`. */
  binName: string
  /** Config files that signal the tool is configured for this project. */
  configFiles: string[]
  /** package.json dependency names that signal the tool. */
  depNames: string[]
  /** When true, the tool is unusable without one of `requiresAnyOf` present. */
  requiresConfig: boolean
  /** Files that must exist for the tool to have anything to check (e.g. tsconfig). */
  requiresAnyOf?: string[]
  persistent: boolean
}

/**
 * The detection registry. Adding a new tool (prettier, eslint, pyright,
 * rust-analyzer, ...) is a single entry here : the Strategy/Adapter layers key
 * off `id`. Ordered type → lint → format so reports read in that priority.
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

/**
 * Detect the diagnostic tools available in the project at `root`. Returns an
 * ordered list of {@link DetectedTool} descriptors (type, then lint, then
 * format). Empty when nothing is installed.
 */
export function detectTools(root: string): DetectedTool[] {
  const deps = readDeps(root)
  const out: DetectedTool[] = []
  for (const spec of REGISTRY) {
    const bin = join(root, "node_modules", ".bin", spec.binName)
    if (!existsSync(bin)) continue

    const hasConfigFile = spec.configFiles.some((f) => existsSync(join(root, f)))
    const hasDep = spec.depNames.some((d) => d in deps)
    const configFound = hasConfigFile || hasDep

    // A tool that requires config (tsgo needs a tsconfig to know the project)
    // is skipped when none of its `requiresAnyOf` files are present.
    if (spec.requiresAnyOf && !spec.requiresAnyOf.some((f) => existsSync(join(root, f)))) {
      continue
    }
    if (spec.requiresConfig && !configFound) continue

    out.push({ id: spec.id, kind: spec.kind, bin, configFound, persistent: spec.persistent })
  }
  return out
}
