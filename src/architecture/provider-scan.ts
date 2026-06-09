/**
 * Pure scanning helpers for the provider-decoupling architecture test
 * (`src/architecture.provider-decoupling.test.ts`). Split from the test so
 * tooling (baseline regeneration one-liners, future lint integration) can
 * import the exact same logic without booting the test runner.
 *
 * @module architecture/provider-scan
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * Provider fingerprints flagged in core CODE (identifiers + string
 * literals; comments exempt). Word-ish boundaries keep noise down ("gpt"
 * only as gpt-<digit>/gpt-4o; bare "o3" excluded as collision-prone).
 */
export const PROVIDER_TOKEN_RE =
  /\b(anthropic|claude|opus|sonnet|haiku|fable|mythos|openai|openrouter|chatgpt|gpt-\d|gpt-4o|bedrock|x-stainless|claude-cli|claude-code)\b/i

/** Same screen for file and directory names under src/. */
export const PROVIDER_NAME_RE = /(anthropic|claude|openai|openrouter|gpt|gemini|mistral)/i

/** Recursively collect .ts files under a root, as root-relative paths. */
export function tsFilesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith(".ts")) out.push(relative(root, full))
    }
  }
  walk(root)
  return out.sort()
}

/**
 * Strip comments while preserving string/template contents. Tiny state
 * machine: handles '…', "…", `…` (with \-escapes; ${…} expression code is
 * left inline and still scanned), // line and /* block comments. Good
 * enough for fingerprint scanning; not a parser.
 */
export function stripComments(source: string): string {
  let out = ""
  let i = 0
  type Mode = "code" | "line" | "block" | "single" | "double" | "template"
  let mode: Mode = "code"
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    switch (mode) {
      case "code":
        if (c === "/" && next === "/") {
          mode = "line"
          i += 2
        } else if (c === "/" && next === "*") {
          mode = "block"
          i += 2
        } else {
          if (c === "'") mode = "single"
          else if (c === '"') mode = "double"
          else if (c === "`") mode = "template"
          out += c
          i++
        }
        break
      case "line":
        if (c === "\n") {
          mode = "code"
          out += c
        }
        i++
        break
      case "block":
        if (c === "*" && next === "/") {
          mode = "code"
          i += 2
        } else {
          if (c === "\n") out += c
          i++
        }
        break
      case "single":
      case "double":
      case "template": {
        const closer = mode === "single" ? "'" : mode === "double" ? '"' : "`"
        if (c === "\\") {
          out += c + (next ?? "")
          i += 2
        } else {
          if (c === closer) mode = "code"
          out += c
          i++
        }
        break
      }
    }
  }
  return out
}

/**
 * Scan a source root and return every file whose CODE (comments stripped)
 * matches {@link PROVIDER_TOKEN_RE}, excluding `exclude` (the test file
 * itself, which must name the tokens).
 */
export function scanProviderTokenViolations(root: string, exclude: ReadonlySet<string>): string[] {
  return tsFilesUnder(root).filter(
    (rel) =>
      !exclude.has(rel) &&
      PROVIDER_TOKEN_RE.test(stripComments(readFileSync(join(root, rel), "utf8"))),
  )
}
