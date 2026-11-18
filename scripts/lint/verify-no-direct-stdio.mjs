#!/usr/bin/env node
/**
 * Ratchet check for the `ma/no-direct-stdio` oxlint rule, one repo at a time.
 *
 * The rule (`no-direct-stdio.mjs`, next to this file) bans every direct write
 * to the process stdout and stderr outside the few files that render for the
 * user. This script is the second net behind `bun run lint`: it still fails
 * when someone switches the rule off, widens an override, or lets the
 * allowlist grow.
 *
 * It checks, in this order:
 *
 * 1. CONFIG: the repo `.oxlintrc.json` registers the plugin, sets the rule to
 *    error, and a canary file outside the repo is really reported when it is
 *    linted with that config (so `extends`, severity and plugin path all work).
 * 2. COUNTS: a restricted run with NO allowlist counts every violation per
 *    file. A file that is not in the baseline must have zero. A file in the
 *    baseline must have exactly the recorded count, so a fix is locked in and
 *    a new write is caught.
 * 3. STALE: a baseline file that no longer exists or has zero violations must
 *    leave the baseline.
 * 4. OVERRIDES: the files that the repo config switches the rule off for must
 *    equal the baseline `exempt` globs plus the baseline `allow` files.
 *
 * The baseline is a JSON file with two keys. `exempt` is a list of globs for
 * tests, fixtures and dev scripts. `allow` maps a file to its `count`,
 * `reason` and `target`. The list only shrinks.
 *
 * Usage: `node verify-no-direct-stdio.mjs --repo DIR`, plus the optional flags
 * `--baseline FILE`, `--oxlint BIN`, `--plugin FILE`, `--counts` (print the
 * per-file counts), `--sync` (after a fix, shrink the baseline and the oxlint
 * override together; it never adds a file or raises a count) and `--selftest`
 * (prove the check fails on a canary).
 *
 * @module scripts/lint/verify-no-direct-stdio
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PLUGIN = join(HERE, "no-direct-stdio.mjs")
const RULE = "ma/no-direct-stdio"
const CANARY = 'export const canary = () => process.stderr.write("canary")\n'

/**
 * Parse JSON with comments and trailing commas (the `.oxlintrc.json` dialect).
 *
 * @param text - JSONC source.
 * @returns The parsed value.
 */
export function parseJsonc(text) {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (ch === "\\") out += text[++i] ?? ""
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
    } else {
      out += ch
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

/** Read a JSONC file. */
function readJsonc(file) {
  return parseJsonc(readFileSync(file, "utf8"))
}

/** The oxlint binary of a repo: its own, the workspace one, then PATH. */
function findOxlint(repo) {
  for (const dir of [repo, resolve(repo, ".."), resolve(repo, "../..")]) {
    const bin = join(dir, "node_modules", ".bin", "oxlint")
    if (existsSync(bin)) return bin
  }
  return "oxlint"
}

/** Run oxlint with JSON output and return its diagnostics. */
function runOxlint(oxlint, cwd, args) {
  const run = spawnSync(oxlint, [...args, "-f", "json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
  let json
  try {
    json = JSON.parse(run.stdout)
  } catch {
    throw new Error(
      `oxlint gave no JSON (exit ${run.status}): ${run.stdout}${run.stderr}`.slice(0, 600),
    )
  }
  return json.diagnostics ?? []
}

/** Every violation of the rule under `repo`, with NO allowlist, exempt globs ignored. */
function countViolations({ repo, oxlint, plugin, exempt, ignore }) {
  const scratch = mkdtempSync(join(tmpdir(), "ma-stdio-"))
  try {
    const config = join(scratch, "oxlintrc.json")
    writeFileSync(
      config,
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        jsPlugins: [{ name: "ma", specifier: plugin }],
        rules: { [RULE]: "error" },
      }),
    )
    const args = ["-c", config]
    for (const pattern of [...ignore, ...exempt]) args.push("--ignore-pattern", pattern)
    args.push(".")
    const perFile = new Map()
    for (const d of runOxlint(oxlint, repo, args)) {
      if (!String(d.code).includes("no-direct-stdio")) continue
      const list = perFile.get(d.filename) ?? []
      list.push({ line: d.labels?.[0]?.span?.line ?? 0, message: String(d.message).split(".")[0] })
      perFile.set(d.filename, list)
    }
    return perFile
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Lint a canary outside the repo with the REAL repo config. True when the rule fires. */
function configReportsCanary({ repo, oxlint }) {
  const scratch = mkdtempSync(join(tmpdir(), "ma-stdio-canary-"))
  try {
    const file = join(scratch, "canary.ts")
    writeFileSync(file, CANARY)
    const diagnostics = runOxlint(oxlint, repo, ["-c", join(repo, ".oxlintrc.json"), file])
    return diagnostics.some((d) => String(d.code).includes("no-direct-stdio"))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** The files the repo config switches the rule off for. */
function overrideFiles(config) {
  const off = (value) => value === "off" || (Array.isArray(value) && value[0] === "off")
  return (config.overrides ?? []).filter((o) => off(o.rules?.[RULE])).flatMap((o) => o.files ?? [])
}

/**
 * Check one repo against its baseline.
 *
 * @param options - What to check: `repo` (absolute root), `baseline` (JSON file),
 *   and optionally `plugin` (default: the file next to this script) and `oxlint` (binary).
 * @returns The problems (empty when clean) and the raw per-file violations.
 */
export function verify(options) {
  const { repo, baseline } = options
  const plugin = options.plugin ?? DEFAULT_PLUGIN
  const oxlint = options.oxlint ?? findOxlint(repo)
  const problems = []
  const config = readJsonc(join(repo, ".oxlintrc.json"))
  const base = readJsonc(baseline)
  const exempt = base.exempt ?? []
  const allow = base.allow ?? {}

  const registered = (config.jsPlugins ?? []).some((p) => (p.name ?? p) === "ma")
  const severity = Array.isArray(config.rules?.[RULE])
    ? config.rules[RULE][0]
    : config.rules?.[RULE]
  if (!registered) problems.push(`CONFIG: .oxlintrc.json does not register the "ma" jsPlugin`)
  if (severity !== "error")
    problems.push(`CONFIG: ${RULE} must be "error" in .oxlintrc.json (is ${severity})`)
  if (registered && severity === "error" && !configReportsCanary({ repo, oxlint })) {
    problems.push(
      `CONFIG: a canary with process.stderr.write was NOT reported with this repo config`,
    )
  }

  const counts = countViolations({
    repo,
    oxlint,
    plugin,
    exempt,
    ignore: config.ignorePatterns ?? [],
  })
  for (const [file, hits] of counts) {
    const entry = allow[file]
    if (entry === undefined) {
      const first = hits[0]
      problems.push(
        `NEW: ${file}:${first.line} ${first.message} (${hits.length} in file). Route it through the diagnostic bus or an injected writer; do not add it to the baseline unless the file is a final renderer.`,
      )
    } else if (hits.length !== entry.count) {
      problems.push(
        `COUNT: ${file} has ${hits.length} direct writes, baseline says ${entry.count}. ${hits.length > entry.count ? "A new write was added." : "Lower the baseline count: the list only shrinks."}`,
      )
    }
  }
  for (const [file, entry] of Object.entries(allow)) {
    if (!existsSync(join(repo, file)))
      problems.push(`STALE: ${file} no longer exists, remove it from the baseline`)
    else if (!counts.has(file))
      problems.push(`STALE: ${file} has no direct writes any more, remove it from the baseline`)
    if (!entry.reason) problems.push(`REASON: ${file} needs a reason in the baseline`)
  }

  const expected = [...exempt, ...Object.keys(allow)].sort()
  const actual = [...overrideFiles(config)].sort()
  for (const f of expected)
    if (!actual.includes(f))
      problems.push(
        `OVERRIDE: ${f} is in the baseline but .oxlintrc.json does not switch the rule off for it`,
      )
  for (const f of actual)
    if (!expected.includes(f))
      problems.push(
        `OVERRIDE: .oxlintrc.json switches the rule off for ${f}, which is not in the baseline`,
      )
  return { problems, counts }
}

/** The biome binary of a repo, or undefined when it has none. */
function findBiome(repo) {
  for (const dir of [repo, resolve(repo, ".."), resolve(repo, "../..")]) {
    const bin = join(dir, "node_modules", ".bin", "biome")
    if (existsSync(bin)) return bin
  }
  return undefined
}

/**
 * Shrink the allowlist after a fix: lower the count of a file that writes less,
 * drop a file that is clean, and rewrite the `files` list of the oxlint override
 * to match. It never raises a count and never adds a file: new debt is a
 * refusal and nothing is written.
 *
 * @param options - `repo` (absolute root), `baseline` (JSON file), and optionally `plugin` and `oxlint`.
 * @returns `errors` (empty when it ran) and `changes` (what it wrote, empty when nothing shrank).
 */
export function syncBaseline(options) {
  const { repo, baseline } = options
  const plugin = options.plugin ?? DEFAULT_PLUGIN
  const oxlint = options.oxlint ?? findOxlint(repo)
  const configPath = join(repo, ".oxlintrc.json")
  const config = readJsonc(configPath)
  const base = readJsonc(baseline)
  const exempt = base.exempt ?? []
  const allow = base.allow ?? {}
  const counts = countViolations({
    repo,
    oxlint,
    plugin,
    exempt,
    ignore: config.ignorePatterns ?? [],
  })
  const errors = []
  const changes = []
  for (const [file, hits] of counts) {
    const entry = allow[file]
    if (entry === undefined)
      errors.push(`NEW: ${file} has ${hits.length} direct write(s) and is not in the baseline`)
    else if (hits.length > entry.count)
      errors.push(`COUNT: ${file} has ${hits.length}, baseline says ${entry.count}`)
  }
  if (errors.length > 0) return { errors, changes }
  for (const [file, entry] of Object.entries(allow)) {
    const now = counts.get(file)?.length ?? 0
    if (now === 0) {
      delete allow[file]
      changes.push(`removed ${file}`)
    } else if (now < entry.count) {
      changes.push(`${file}: ${entry.count} -> ${now}`)
      entry.count = now
    }
  }
  if (changes.length === 0) return { errors, changes }

  const text = readFileSync(configPath, "utf8")
  const marker = /\/\/\s*ma\/no-direct-stdio allowlist\./.exec(text)
  if (marker === null) {
    return {
      errors: [`.oxlintrc.json has no "ma/no-direct-stdio allowlist." comment above the override`],
      changes: [],
    }
  }
  const list = /"files"\s*:\s*\[[^\]]*\]/g
  list.lastIndex = marker.index + marker[0].length
  const found = list.exec(text)
  if (found === null)
    return {
      errors: [`.oxlintrc.json has no "files" list after the allowlist comment`],
      changes: [],
    }
  const files = [...exempt, ...Object.keys(allow).sort()]
  writeFileSync(
    configPath,
    `${text.slice(0, found.index)}"files": ${JSON.stringify(files)}${text.slice(found.index + found[0].length)}`,
  )
  writeFileSync(baseline, `${JSON.stringify({ ...base, allow }, null, 2)}\n`)
  const biome = findBiome(repo)
  if (biome === undefined)
    changes.push("(no biome found: run the repo format command on the two files)")
  else
    spawnSync(biome, ["format", "--write", configPath, baseline], { cwd: repo, encoding: "utf8" })
  return { errors, changes }
}

/** Build a throwaway repo, plant a canary, and prove the check fails and then passes. */
function selftest(oxlint, plugin) {
  const repo = mkdtempSync(join(tmpdir(), "ma-stdio-selftest-"))
  try {
    mkdirSync(join(repo, "src"), { recursive: true })
    writeFileSync(join(repo, "src", "ok.ts"), "export const ok = 1\n")
    writeFileSync(join(repo, "src", "leak.ts"), CANARY)
    writeFileSync(
      join(repo, ".oxlintrc.json"),
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        jsPlugins: [{ name: "ma", specifier: plugin }],
        rules: { [RULE]: "error" },
        overrides: [],
      }),
    )
    const baseline = join(repo, "baseline.json")
    writeFileSync(baseline, JSON.stringify({ exempt: [], allow: {} }))
    const red = verify({ repo, baseline, plugin, oxlint })
    if (!red.problems.some((p) => p.startsWith("NEW: src/leak.ts")))
      throw new Error(
        `selftest: the canary src/leak.ts was not reported. Got: ${red.problems.join(" | ")}`,
      )
    writeFileSync(
      baseline,
      JSON.stringify({ exempt: [], allow: { "src/leak.ts": { count: 1, reason: "selftest" } } }),
    )
    const half = verify({ repo, baseline, plugin, oxlint })
    if (!half.problems.some((p) => p.startsWith("OVERRIDE: src/leak.ts")))
      throw new Error(
        `selftest: a baseline entry without the config override was accepted. Got: ${half.problems.join(" | ")}`,
      )
    writeFileSync(
      join(repo, ".oxlintrc.json"),
      `{
  "plugins": [],
  "categories": { "correctness": "off" },
  "jsPlugins": [{ "name": "ma", "specifier": ${JSON.stringify(plugin)} }],
  "rules": { "${RULE}": "error" },
  "overrides": [
    {
      // ma/no-direct-stdio allowlist. selftest
      "files": ["src/leak.ts"],
      "rules": { "${RULE}": "off" }
    }
  ]
}
`,
    )
    const green = verify({ repo, baseline, plugin, oxlint })
    if (green.problems.length > 0)
      throw new Error(`selftest: a consistent allowlist still fails: ${green.problems.join(" | ")}`)
    writeFileSync(join(repo, "src", "leak.ts"), "export const fixed = 1\n")
    const stale = verify({ repo, baseline, plugin, oxlint })
    if (!stale.problems.some((p) => p.startsWith("STALE: src/leak.ts")))
      throw new Error(
        `selftest: a fixed file stayed in the baseline unnoticed. Got: ${stale.problems.join(" | ")}`,
      )
    const synced = syncBaseline({ repo, baseline, plugin, oxlint })
    if (synced.errors.length > 0 || !synced.changes.includes("removed src/leak.ts"))
      throw new Error(
        `selftest: --sync did not remove the fixed file. Got: ${JSON.stringify(synced)}`,
      )
    const shrunk = verify({ repo, baseline, plugin, oxlint })
    if (shrunk.problems.length > 0)
      throw new Error(
        `selftest: after --sync the check still fails: ${shrunk.problems.join(" | ")}`,
      )
    if (readJsonc(join(repo, ".oxlintrc.json")).overrides[0].files.includes("src/leak.ts"))
      throw new Error("selftest: --sync left the file in the oxlint override")
    const again = syncBaseline({ repo, baseline, plugin, oxlint })
    if (again.errors.length > 0 || again.changes.length > 0)
      throw new Error(`selftest: a second --sync is not a no-op: ${JSON.stringify(again)}`)
    writeFileSync(join(repo, "src", "leak2.ts"), CANARY)
    const refused = syncBaseline({ repo, baseline, plugin, oxlint })
    if (!refused.errors.some((e) => e.startsWith("NEW: src/leak2.ts")))
      throw new Error(`selftest: --sync accepted new debt. Got: ${JSON.stringify(refused)}`)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

/** Read `--name value` and `--flag` options from argv. */
function parseArgs(argv) {
  const out = { flags: new Set() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) continue
    const name = arg.slice(2)
    if (["counts", "selftest", "sync"].includes(name)) out.flags.add(name)
    else out[name] = argv[++i]
  }
  return out
}

/** Entry point. Exit code 1 when anything is wrong. */
function main() {
  const args = parseArgs(process.argv.slice(2))
  const repo = resolve(args.repo ?? process.cwd())
  const plugin = args.plugin ? resolve(args.plugin) : DEFAULT_PLUGIN
  const oxlint = args.oxlint ?? findOxlint(repo)
  if (args.flags.has("selftest")) {
    selftest(oxlint, plugin)
    process.stdout.write("selftest ok\n")
    return
  }
  const baseline = isAbsolute(args.baseline ?? "")
    ? args.baseline
    : resolve(repo, args.baseline ?? "src/architecture/no-direct-stdio.baseline.json")
  if (args.flags.has("sync")) {
    const { errors, changes } = syncBaseline({ repo, baseline, plugin, oxlint })
    if (errors.length > 0) {
      process.stderr.write(
        `no-direct-stdio --sync refused (new debt, nothing written):\n${errors.map((e) => `  ${e}`).join("\n")}\n`,
      )
      process.exitCode = 1
      return
    }
    process.stdout.write(
      changes.length === 0
        ? "no-direct-stdio --sync: nothing to shrink\n"
        : `no-direct-stdio --sync: ${changes.join("; ")}\n`,
    )
    return
  }
  if (args.flags.has("counts")) {
    const config = readJsonc(join(repo, ".oxlintrc.json"))
    const base = existsSync(baseline) ? readJsonc(baseline) : {}
    const counts = countViolations({
      repo,
      oxlint,
      plugin,
      exempt: base.exempt ?? [],
      ignore: config.ignorePatterns ?? [],
    })
    const table = Object.fromEntries([...counts].sort().map(([file, hits]) => [file, hits.length]))
    process.stdout.write(`${JSON.stringify(table, null, 2)}\n`)
    return
  }
  const { problems, counts } = verify({ repo, baseline, plugin, oxlint })
  if (problems.length > 0) {
    process.stderr.write(
      `no-direct-stdio: ${problems.length} problem(s) in ${repo}\n${problems.map((p) => `  ${p}`).join("\n")}\nAfter a fix that removes writes, shrink the allowlist with: node ${process.argv[1]} --repo ${repo} --baseline ${baseline} --sync\n`,
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(`no-direct-stdio ok: ${counts.size} allowlisted file(s), config enforced\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
