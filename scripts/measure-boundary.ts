#!/usr/bin/env bun
/**
 * Boundary measurement for the "minimal core" program.
 *
 * READ-ONLY. Emits one JSON object. No network, no writes.
 *
 * Every number here is a metric the plan shrinks on purpose. Run before and after
 * each phase; a phase that does not move its metric does not close, even if the
 * gates pass. Usage:
 *
 *   bun run scripts/measure-boundary.ts            # human summary
 *   bun run scripts/measure-boundary.ts --json      # machine object
 *   bun run scripts/measure-boundary.ts --baseline  # write evidence/baseline.json
 *
 * @module scripts/measure-boundary
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dirname, "..")
const SRC = join(REPO_ROOT, "src")
const PLUGIN_API = join(REPO_ROOT, "plugin-api", "src")
const EVIDENCE = resolve(REPO_ROOT, "..", "research", "core-boundary-refactor", "evidence")

const isTest = (p: string): boolean => /\.(test|spec)\.tsx?$/.test(p)
const isDevTooling = (p: string): boolean =>
  p.includes("/src/architecture/") || p.includes("/src/test-utils/")

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}

/** Count lines without a trailing-newline inflation. */
function loc(file: string): number {
  const text = readFileSync(file, "utf8")
  if (text.length === 0) return 0
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
}

interface DirMetric {
  readonly dir: string
  readonly files: number
  readonly lines: number
}

function measureDirs(root: string, opts: { excludeDevTooling: boolean }): DirMetric[] {
  const byDir = new Map<string, { files: number; lines: number }>()
  for (const file of walk(root)) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue
    if (isTest(file)) continue
    if (opts.excludeDevTooling && isDevTooling(file)) continue
    const rel = relative(root, file)
    const top = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "(root)"
    const entry = byDir.get(top) ?? { files: 0, lines: 0 }
    byDir.set(top, { files: entry.files + 1, lines: entry.lines + loc(file) })
  }
  return [...byDir.entries()]
    .map(([dir, v]) => ({ dir, files: v.files, lines: v.lines }))
    .sort((a, b) => b.lines - a.lines)
}

/**
 * Prose literals that reach a model or a human.
 *
 * Scoped on purpose. A tree-wide "long string literal" count is noise: it returns
 * thousands of hits from ordinary code (log formats, regexes, fixtures) and would
 * gate nothing. What matters is prose authored in the *prose-authoring* modules.
 *
 * Cost is a *trend* metric, not proof. The proof is the runtime capture test
 * (PLAN-V3 Phase 1); this number exists so a phase that claims progress must show
 * movement. The `seamModules` and `assets` counts are the hard zeros.
 */
const PROSE_AUTHORING = [
  "src/tools/PROMPTS.ts",
  "src/media/PROMPTS.ts",
  "src/agent/PROMPTS.ts",
  "src/modes/PROMPTS.ts",
  "src/plugins/loader/PROMPTS.ts",
  "src/agent/context-compact.ts",
  "src/agent/turn-notice.ts",
  "src/agent/agent-name.ts",
  "src/agent/synthetic-fallbacks.ts",
  "src/tools/binary-guard.ts",
  "src/tools/files-stats.ts",
  "src/llm/system-prompt.ts",
  "src/llm/instructions-block.ts",
] as const

function countProseLiterals(): {
  files: number
  literals: number
  proseFilesPresent: number
} {
  let literals = 0
  let touched = 0
  let present = 0
  for (const rel of PROSE_AUTHORING) {
    const file = join(REPO_ROOT, rel)
    if (!existsSync(file)) continue
    present++
    const hits = proseHits(readFileSync(file, "utf8"))
    if (hits > 0) {
      touched++
      literals += hits
    }
  }
  return { files: touched, literals, proseFilesPresent: present }
}

/** Long, wordy literals: 40+ chars and 6+ real words. Paths/specifiers excluded. */
function proseHits(text: string): number {
  const STRING_RE = /"((?:[^"\\\n]|\\.){40,})"|`((?:[^`\\]|\\.){40,})`/gu
  let hits = 0
  for (const m of text.matchAll(STRING_RE)) {
    const body = m[1] ?? m[2] ?? ""
    if (/^[./@]|^(?:node|bun):|\/\/|\bimport\b|\bexport\b/u.test(body)) continue
    const words = body
      .trim()
      .split(/\s+/u)
      .filter((w) => /^[a-z]{2,}/iu.test(w))
    if (words.length >= 6) hits++
  }
  return hits
}

/** Transitive import closure from a set of entry files, resolving relative specifiers. */
function closure(entries: readonly string[]): {
  files: string[]
  builtins: Map<string, string[]>
  unresolved: string[]
} {
  const seen = new Set<string>()
  const builtins = new Map<string, string[]>()
  const unresolved = new Set<string>()
  const queue = [...entries]
  const RE_STATIC =
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/gu
  const RE_DYNAMIC = /import\(\s*["']([^"']+)["']\s*\)/gu
  const RE_REQUIRE = /require\(\s*["']([^"']+)["']\s*\)/gu

  /**
   * Resolve a specifier to a real file, or null.
   *
   * Handles relative specifiers AND the package's own self-referential specifiers
   * (`@minimal-agent/core/...`). Those resolve through `package.json#exports`, which
   * maps e.g. `./plugin-api/llm/*` to `./plugin-api/src/llm/*`, so they cannot be
   * resolved by path arithmetic alone. They are not external deps and must not be
   * counted as unresolved edges.
   */
  const resolveSpec = (spec: string, from: string): string | null => {
    const SELF = "@minimal-agent/core/"
    const candidates: string[] = []
    if (spec.startsWith(".")) {
      const base = resolve(dirname(from), spec)
      candidates.push(base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"))
    } else if (spec.startsWith(SELF)) {
      const sub = `./${spec.slice(SELF.length)}`
      const mapped = (pkg.exports ?? {})[sub]
      if (mapped !== undefined) candidates.push(resolve(REPO_ROOT, mapped))
      // Also try the literal path and the common `src/` insertion, since the export
      // map does not cover every internal edge.
      const literal = resolve(REPO_ROOT, spec.slice(SELF.length))
      candidates.push(
        literal,
        `${literal}.ts`,
        resolve(REPO_ROOT, "plugin-api", "src", spec.slice(SELF.length + "plugin-api/".length)),
      )
      candidates.push(`${resolve(REPO_ROOT, "src", spec.slice(SELF.length))}.ts`)
    } else {
      return null
    }
    for (const candidate of candidates) {
      for (const c of [
        candidate,
        `${candidate}.ts`,
        `${candidate}.tsx`,
        join(candidate, "index.ts"),
      ]) {
        if (existsSync(c) && !c.endsWith("/") && statSync(c).isFile()) return c
      }
    }
    return null
  }

  /** True for specifiers that name an external package rather than this repo. */
  const isExternal = (spec: string): boolean =>
    !spec.startsWith(".") && !spec.startsWith("@minimal-agent/core/")

  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    if (!existsSync(file)) continue
    const text = readFileSync(file, "utf8")
    for (const re of [RE_STATIC, RE_DYNAMIC, RE_REQUIRE]) {
      re.lastIndex = 0
      for (const m of text.matchAll(re)) {
        const spec = m[1]
        if (spec === undefined) continue
        if (spec.startsWith("node:") || spec.startsWith("bun:")) {
          const label = spec.split("/").slice(0, 2).join("/")
          const list = builtins.get(label) ?? []
          list.push(relative(REPO_ROOT, file))
          builtins.set(label, list)
          continue
        }
        const resolved = resolveSpec(spec, file)
        if (resolved !== null) {
          queue.push(resolved)
        } else if (isExternal(spec)) {
          // An external package: out of scope, not an unresolved edge.
          continue
        } else {
          // FAIL CLOSED. A relative import we cannot resolve silently shrinks the
          // closure, which would make the score look *better*. Record it so the
          // ratchet can assert zero unresolved specifiers.
          unresolved.add(`${relative(REPO_ROOT, file)} -> ${spec}`)
        }
      }
    }
  }
  return { files: [...seen], builtins, unresolved: [...unresolved] }
}

/** Platform globals reachable from the closure. */
function platformGlobals(files: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const PATTERNS: readonly [string, RegExp][] = [
    ["process.", /\bprocess\.(?:env|cwd|exit|argv|platform|stdout|stderr|hrtime|nextTick)\b/gu],
    ["Buffer.", /\bBuffer\.(?:from|alloc|concat|byteLength)\b/gu],
    ["Bun.", /\bBun\.\w+/gu],
    ["__dirname", /\b__dirname\b/gu],
    ["import.meta.dirname", /import\.meta\.dirname/gu],
    ["globalThis.crypto", /globalThis\.crypto/gu],
  ]
  for (const file of files) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, "utf8")
    for (const [name, re] of PATTERNS) {
      re.lastIndex = 0
      if (re.test(text)) {
        const list = found.get(name) ?? []
        list.push(relative(REPO_ROOT, file))
        found.set(name, list)
      }
    }
  }
  return found
}

// ---------------------------------------------------------------- collect

const srcDirs = measureDirs(SRC, { excludeDevTooling: true })
const pluginApiDirs = measureDirs(PLUGIN_API, { excludeDevTooling: true })

const promptAssets = walk(join(SRC, "prompts")).filter(
  (f) => (f.endsWith(".md") || f.endsWith(".tmpl.md")) && !f.endsWith("README.md"),
)
const promptAssetLines = promptAssets.reduce((sum, f) => sum + loc(f), 0)

const prose = countProseLiterals()

/** `PROMPTS.ts` seams: modules whose whole job is prose. */
const promptsSeams = walk(SRC).filter((f) => /\/PROMPTS\.ts$/u.test(f) && !isTest(f))

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  engines?: Record<string, string>
  exports?: Record<string, string>
}
const exportEntries = Object.entries(pkg.exports ?? {})
const sdkEntries = exportEntries
  .filter(([, target]) => target.startsWith("./src/sdk/"))
  .map(([, target]) => join(REPO_ROOT, target))

const sdkClosure = closure(sdkEntries)
const sdkGlobals = platformGlobals(sdkClosure.files)

const srcTotal = srcDirs.reduce((s, d) => s + d.lines, 0)
const pluginApiTotal = pluginApiDirs.reduce((s, d) => s + d.lines, 0)

/**
 * Guard weight: test LOC under `src/architecture/` plus all of `src/test-utils/`.
 *
 * Reported, never gated. The product-size ratchet deliberately EXCLUDES these, because
 * Phase 1 requires adding violation fixtures, which raises LOC while the program gets
 * more correct. A guard that punishes its own growth is a broken guard. Two metrics,
 * two directions, both in one JSON so neither can hide the other.
 */
function guardWeight(): { architectureTest: number; testUtils: number; total: number } {
  const architectureTest = walk(join(SRC, "architecture"))
    .filter((f) => f.endsWith(".ts") && isTest(f))
    .reduce((sum, f) => sum + loc(f), 0)
  const testUtils = walk(join(SRC, "test-utils"))
    .filter((f) => f.endsWith(".ts"))
    .reduce((sum, f) => sum + loc(f), 0)
  return { architectureTest, testUtils, total: architectureTest + testUtils }
}

const guards = guardWeight()

const report = {
  measuredAt: new Date().toISOString(),
  commit: (() => {
    try {
      return Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT })
        .stdout.toString()
        .trim()
    } catch {
      return "unknown"
    }
  })(),
  core: {
    srcLines: srcTotal,
    srcFiles: srcDirs.reduce((s, d) => s + d.files, 0),
    pluginApiLines: pluginApiTotal,
    shippingLinesTotal: srcTotal + pluginApiTotal,
    byDir: srcDirs,
  },
  /** Not gated. Rises when guards get better; kept visible so it cannot hide. */
  guardWeight: guards,
  prompts: {
    assets: promptAssets.length,
    assetLines: promptAssetLines,
    seamModules: promptsSeams.length,
    proseLiteralFiles: prose.files,
    proseLiterals: prose.literals,
  },
  sdkPortability: {
    declaredEngines: Object.keys(pkg.engines ?? {}),
    closureFiles: sdkClosure.files.length,
    /** Must be zero. Non-zero means the closure walk lost an edge. */
    unresolvedSpecifiers: sdkClosure.unresolved,
    reachableBuiltins: Object.fromEntries(
      [...sdkClosure.builtins.entries()].map(([k, v]) => [k, [...new Set(v)]]),
    ),
    reachableGlobals: Object.fromEntries(
      [...sdkGlobals.entries()].map(([k, v]) => [k, [...new Set(v)]]),
    ),
  },
} as const

// ---------------------------------------------------------------- emit

const asJson = process.argv.includes("--json")
const writeBaseline = process.argv.includes("--baseline")

if (writeBaseline) {
  writeFileSync(join(EVIDENCE, "baseline.json"), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`wrote ${join(EVIDENCE, "baseline.json")}`)
}

if (asJson || writeBaseline) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const pad = (s: string | number, n: number): string => String(s).padStart(n)
console.log(`\ncore boundary measurement  (${report.commit})`)
console.log("=".repeat(64))
console.log(`\nCORE SIZE`)
console.log(
  `  src/            ${pad(report.core.srcLines, 7)} lines  ${report.core.srcFiles} files`,
)
console.log(`  plugin-api/src/ ${pad(report.core.pluginApiLines, 7)} lines`)
console.log(`  shipping total  ${pad(report.core.shippingLinesTotal, 7)} lines`)
console.log(
  `  guard weight    ${pad(report.guardWeight.total, 7)} lines  (not gated: ${report.guardWeight.architectureTest} arch tests + ${report.guardWeight.testUtils} test-utils)`,
)
console.log(`\n  top dirs:`)
for (const d of report.core.byDir.slice(0, 10)) {
  console.log(`    ${d.dir.padEnd(16)} ${pad(d.lines, 6)} lines  ${pad(d.files, 3)} files`)
}
console.log(`\nPROMPT CONTENT  (target: 0)`)
console.log(
  `  .md assets      ${pad(report.prompts.assets, 7)}  (${report.prompts.assetLines} lines)`,
)
console.log(`  PROMPTS.ts      ${pad(report.prompts.seamModules, 7)}`)
console.log(
  `  prose literals  ${pad(report.prompts.proseLiterals, 7)}  in ${report.prompts.proseLiteralFiles} files`,
)
console.log(`\nSDK PORTABILITY  (target: 0 builtins, 0 globals)`)
console.log(`  declared engines: ${report.sdkPortability.declaredEngines.join(", ") || "(none)"}`)
console.log(`  closure files   ${pad(report.sdkPortability.closureFiles, 7)}`)
const builtins = Object.entries(report.sdkPortability.reachableBuiltins)
const globals = Object.entries(report.sdkPortability.reachableGlobals)
console.log(
  `  reachable builtins ${pad(builtins.length, 3)}  ${builtins.map(([k]) => k).join(" ")}`,
)
console.log(`  reachable globals  ${pad(globals.length, 3)}  ${globals.map(([k]) => k).join(" ")}`)
console.log("")
