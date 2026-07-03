#!/usr/bin/env bun

// reorg-move.ts — move a src/ file into a subfolder and fix ALL relative imports.
//
// Usage: bun reorg-move.ts <srcFile> <targetDir> [--root <dir>] [--dry] [--git]
//   <srcFile>   path to the file to move, e.g. src/term-width.ts
//   <targetDir> destination directory (created if needed), e.g. src/utils
//   --root      repo root to scan for importers (default: cwd)
//   --dry       print what would change; make no edits
//   --git       use `git mv` so the move is tracked as a rename (preserves history)
//   --biome     after moving, run `biome check --write` on every touched file so
//               import blocks are re-sorted (organizeImports) and the tree is gate-clean
//
// It (1) rewrites every importer's relative specifier to the file's new home,
// (2) rewrites the moved file's own outgoing relative imports, (3) does the
// physical move. It does NOT run git or the gate — caller does that.
//
// Assumptions matched to this repo: ESM, explicit ".ts" extensions on relative
// imports, no path aliases for these files.

import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"

interface Args {
  srcFile: string
  targetDir: string
  root: string
  dry: boolean
  git: boolean
  biome: boolean
}

function parseArgs(argv: string[]): Args {
  const pos: string[] = []
  let root = process.cwd()
  let dry = false
  let git = false
  let biome = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--root") {
      root = resolve(argv[++i]!)
    } else if (a === "--dry") {
      dry = true
    } else if (a === "--git") {
      git = true
    } else if (a === "--biome") {
      biome = true
    } else pos.push(a!)
  }
  if (pos.length < 2) {
    console.error(
      "usage: reorg-move.ts <srcFile> <targetDir> [--root dir] [--dry] [--git] [--biome]",
    )
    process.exit(2)
  }
  return { srcFile: resolve(pos[0]!), targetDir: resolve(pos[1]!), root, dry, git, biome }
}

// Walk a dir tree collecting .ts files, skipping node_modules/.git/dist.
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === "coverage")
      continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p)
  }
  return out
}

// A relative import specifier that resolves (with optional .ts) to `target`.
// Returns the new specifier string given the importing file's dir and target abs path.
function relSpec(fromFileDir: string, targetAbs: string): string {
  let rel = relative(fromFileDir, targetAbs)
  if (!rel.startsWith(".")) rel = "./" + rel
  return rel
}

// Resolve an import specifier (as written) from a file to an absolute path (with .ts).
function resolveSpec(fromFileDir: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null // bare/alias — not ours to rewrite
  let abs = resolve(fromFileDir, spec)
  if (abs.endsWith(".ts") || abs.endsWith(".tsx")) return abs
  // extensionless — try .ts / .tsx / /index.ts
  for (const cand of [abs + ".ts", abs + ".tsx", join(abs, "index.ts")]) {
    if (existsSync(cand)) return cand
  }
  return abs + ".ts" // best-effort
}

const IMPORT_RE = /(\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(["'])([^"']+)\2/g

function main() {
  const { srcFile, targetDir, root, dry, git, biome } = parseArgs(process.argv.slice(2))
  if (!existsSync(srcFile)) {
    console.error(`no such file: ${srcFile}`)
    process.exit(1)
  }
  const newAbs = join(targetDir, basename(srcFile))
  if (existsSync(newAbs)) {
    console.error(`target already exists: ${newAbs}`)
    process.exit(1)
  }

  const oldDir = dirname(srcFile)
  const newDir = targetDir
  const files = walk(root)
  let importerEdits = 0,
    importerFiles = 0
  const touched: string[] = [] // absolute paths of every file we edited (for --biome)

  // 1. Rewrite importers (every file except the moved one) that point at srcFile.
  for (const f of files) {
    if (resolve(f) === srcFile) continue
    const fromDir = dirname(f)
    const text = readFileSync(f, "utf8")
    let changed = false
    const next = text.replace(IMPORT_RE, (m, kw, q, spec) => {
      const resolved = resolveSpec(fromDir, spec)
      if (resolved && resolve(resolved) === srcFile) {
        const newSpec = relSpec(fromDir, newAbs)
        const withExt =
          newSpec.endsWith(".ts") || newSpec.endsWith(".tsx") ? newSpec : newSpec + ".ts"
        changed = true
        importerEdits++
        return `${kw}${q}${withExt}${q}`
      }
      return m
    })
    if (changed) {
      importerFiles++
      touched.push(resolve(f))
      if (!dry) writeFileSync(f, next)
    }
  }

  // 2. Rewrite the moved file's OWN outgoing relative imports (dir changed).
  const movedText = readFileSync(srcFile, "utf8")
  let selfEdits = 0
  const movedNext = movedText.replace(IMPORT_RE, (m, kw, q, spec) => {
    if (!spec.startsWith(".")) return m
    const resolved = resolveSpec(oldDir, spec)
    if (!resolved) return m
    const newSpec = relSpec(newDir, resolved)
    const hadExt = spec.endsWith(".ts") || spec.endsWith(".tsx")
    const withExt = hadExt
      ? newSpec.endsWith(".ts") || newSpec.endsWith(".tsx")
        ? newSpec
        : newSpec + ".ts"
      : newSpec
    if (withExt !== spec) {
      selfEdits++
      return `${kw}${q}${withExt}${q}`
    }
    return m
  })

  // 3. Physical move.
  if (dry) {
    console.log(`[dry] move ${relative(root, srcFile)} -> ${relative(root, newAbs)}`)
    console.log(
      `[dry] importer specifiers rewritten: ${importerEdits} across ${importerFiles} file(s)`,
    )
    console.log(`[dry] moved-file own imports rewritten: ${selfEdits}`)
    return
  }
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(srcFile, movedNext)
  if (git) {
    // git mv tracks the rename; run from repo root for correct pathspecs.
    execFileSync("git", ["mv", relative(root, srcFile), relative(root, newAbs)], {
      cwd: root,
      stdio: "inherit",
    })
  } else {
    renameSync(srcFile, newAbs)
  }
  touched.push(newAbs) // the moved file itself may need organizeImports too
  console.log(
    `moved ${relative(root, srcFile)} -> ${relative(root, newAbs)}${git ? " (git mv)" : ""}`,
  )
  console.log(
    `importer specifiers rewritten: ${importerEdits} across ${importerFiles} file(s); own imports: ${selfEdits}`,
  )

  // 4. Optional: re-sort import blocks on every touched file so the tree is gate-clean.
  //    The rewrite only swaps specifier strings; biome's organizeImports assist may then
  //    want to reorder the lines. Running it here means a single move leaves a green tree.
  if (biome && touched.length > 0) {
    const rel = touched.map((t) => relative(root, t))
    try {
      execFileSync("bunx", ["biome", "check", "--write", ...rel], { cwd: root, stdio: "inherit" })
      console.log(`biome check --write applied to ${rel.length} touched file(s)`)
    } catch {
      // biome exits non-zero if it changed files or found unfixable issues; the writes
      // still landed. Caller runs the full gate anyway, so surface but don't hard-fail.
      console.log(`biome pass ran on ${rel.length} file(s) (non-zero exit; check the gate)`)
    }
  }
}

main()
