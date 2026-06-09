#!/usr/bin/env bun

/**
 * Standalone debug CLI for the WebSearch plugin.
 *
 * Shares the same provider layer as the tool handler — useful for:
 *   - Confirming a provider's API key is wired correctly without firing
 *     up the full TUI.
 *   - Running searches from a shell without depending on the fish
 *     `search_online` helper.
 *   - Visually inspecting the formatter's ANSI output.
 *
 * Run:
 *   bun run plugins/web-search/cli.ts <query> [flags]
 *
 * Flags (all optional):
 *   -t, --type web|news        Search vertical (default: web)
 *   -L, --limit N              Number of results 1..20 (default: 10)
 *   -O, --offset N             Page index 0..9 (default: 0)
 *   -C, --country CC           ISO-2 country code or ALL
 *   -l, --lang LL              2-char language code
 *   -F, --freshness FRESH      pd|pw|pm|py or YYYY-MM-DDtoYYYY-MM-DD
 *   -S, --safesearch off|moderate|strict
 *   -p, --provider ID          Force a single provider (overrides chain)
 *   -f, --format text|json     Output format (default: text)
 *   --no-color                 Disable ANSI colors in text output
 *   -h, --help                 Show this help and exit
 *
 * Exit codes:
 *   0  success (one or more hits, or empty result from a working provider)
 *   1  CLI usage error (bad flag, missing query)
 *   2  all providers failed (no API key, network down, etc.)
 *
 * @module web-search/cli
 */

import { defaultConfig, loadWebSearchConfig, type WebSearchConfig } from "./config.ts"
import { formatJsonString, formatText } from "./format.ts"
import { buildChain, runChain, WebSearchAllFailedError } from "./providers/registry.ts"
import type { SearchOptions, SearchType } from "./providers/types.ts"

interface Flags {
  query?: string
  type: SearchType
  count: number
  offset?: number
  country?: string
  lang?: string
  freshness?: string
  safesearch?: "off" | "moderate" | "strict"
  provider?: string
  format: "text" | "json"
  color: boolean
  help: boolean
}

const HELP = `web-search — search the web from a shell.

Usage:
  bun run plugins/web-search/cli.ts <query> [flags]

Flags:
  -t, --type web|news        Search vertical (default: web)
  -L, --limit N              Number of results 1..20 (default: 10)
  -O, --offset N             Page index 0..9 (default: 0)
  -C, --country CC           ISO-2 country code or ALL
  -l, --lang LL              2-char language code
  -F, --freshness FRESH      pd|pw|pm|py or YYYY-MM-DDtoYYYY-MM-DD
  -S, --safesearch off|moderate|strict
  -p, --provider ID          Force a single provider (overrides config chain)
  -f, --format text|json     Output format (default: text)
  --no-color                 Disable ANSI colors in text output
  -h, --help                 Show this help

Examples:
  bun run plugins/web-search/cli.ts "rust async runtime"
  bun run plugins/web-search/cli.ts "EU AI act" -t news -L 5
  bun run plugins/web-search/cli.ts "topic" -f json | jq '.hits[0].url'
`

/** Argv parser. Returns parsed flags or throws a usage-error string. */
export function parseArgs(argv: string[]): Flags {
  const out: Flags = {
    type: "web",
    count: 10,
    format: "text",
    color: process.stdout.isTTY === true,
    help: false,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const need = (name: string): string => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith("-")) throw new Error(`flag ${name} requires a value`)
      i++
      return v
    }
    switch (a) {
      case "-h":
      case "--help":
        out.help = true
        break
      case "-t":
      case "--type": {
        const v = need(a)
        if (v !== "web" && v !== "news") throw new Error(`--type must be web|news (got: ${v})`)
        out.type = v
        break
      }
      case "-L":
      case "--limit": {
        const n = Number(need(a))
        if (!Number.isFinite(n) || n < 1 || n > 20) throw new Error("--limit must be 1..20")
        out.count = Math.floor(n)
        break
      }
      case "-O":
      case "--offset": {
        const n = Number(need(a))
        if (!Number.isFinite(n) || n < 0) throw new Error("--offset must be >= 0")
        out.offset = Math.floor(n)
        break
      }
      case "-C":
      case "--country":
        out.country = need(a)
        break
      case "-l":
      case "--lang":
        out.lang = need(a)
        break
      case "-F":
      case "--freshness":
        out.freshness = need(a)
        break
      case "-S":
      case "--safesearch": {
        const v = need(a)
        if (v !== "off" && v !== "moderate" && v !== "strict") {
          throw new Error("--safesearch must be off|moderate|strict")
        }
        out.safesearch = v
        break
      }
      case "-p":
      case "--provider":
        out.provider = need(a)
        break
      case "-f":
      case "--format": {
        const v = need(a)
        if (v !== "text" && v !== "json") throw new Error("--format must be text|json")
        out.format = v
        break
      }
      case "--no-color":
        out.color = false
        break
      default:
        if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`)
        positional.push(a)
    }
  }
  if (positional.length > 0) out.query = positional.join(" ")
  return out
}

/** Build the effective config: load user config, then apply CLI overrides. */
function effectiveConfig(flags: Flags): WebSearchConfig {
  const base = loadWebSearchConfig()
  // CLI provider override: rewrite the chain to a single id.
  if (flags.provider) {
    return { ...base, providers: [flags.provider] }
  }
  return base
}

/** Build the SearchOptions from CLI flags + config defaults. */
function effectiveOpts(flags: Flags, config: WebSearchConfig): SearchOptions {
  const d = config.defaults
  return {
    type: flags.type,
    count: flags.count ?? d.count ?? 10,
    offset: flags.offset ?? d.offset,
    freshness: flags.freshness ?? d.freshness,
    country: flags.country ?? d.country,
    lang: flags.lang ?? d.lang,
    safesearch: flags.safesearch ?? d.safesearch,
  }
}

/** Pretty-print a chain failure for terminal use. */
function reportFailure(err: WebSearchAllFailedError): string {
  const lines = ["web-search: all providers failed:"]
  for (const f of err.failures) lines.push(`  - ${f.providerId}: ${f.message}`)
  if (err.failures.length === 0) {
    lines.push(
      '  (no providers configured. Set plugins["web-search"].providers in ~/.minimal-agent/config.jsonc)',
    )
  } else if (err.failures.every((f) => f.kind === "not_configured")) {
    lines.push("")
    lines.push("Hint: set BRAVE_API_KEY in your environment, or add an `apiKey` to")
    lines.push('plugins["web-search"].brave in ~/.minimal-agent/config.jsonc.')
  }
  return lines.join("\n")
}

/**
 * Entry point. Returns an exit code; doesn't call `process.exit` itself
 * so it can be unit-tested by importing and calling directly.
 */
export async function main(
  argv: string[],
  io: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  let flags: Flags
  try {
    flags = parseArgs(argv)
  } catch (e) {
    io.stderr.write(`error: ${(e as Error).message}\n\n${HELP}`)
    return 1
  }

  if (flags.help) {
    io.stdout.write(HELP)
    return 0
  }

  if (!flags.query) {
    io.stderr.write(`error: missing <query>\n\n${HELP}`)
    return 1
  }

  // If the user has no config at all, we still want the default ["brave"]
  // chain — `loadWebSearchConfig` handles that. `defaultConfig` is here as
  // a fallback safety net only.
  const config = effectiveConfig(flags)
  const opts = effectiveOpts(flags, config)
  const chain = buildChain(config, undefined, (m) => io.stderr.write(`[web-search] ${m}\n`))

  if (chain.length === 0) {
    io.stderr.write(`${reportFailure(new WebSearchAllFailedError([]))}\n`)
    return 2
  }

  const ac = new AbortController()
  const onSig = () => ac.abort()
  process.once("SIGINT", onSig)
  process.once("SIGTERM", onSig)

  try {
    const resp = await runChain(flags.query, opts, chain, ac.signal, process.env, (m) =>
      io.stderr.write(`[web-search] ${m}\n`),
    )
    if (flags.format === "json") {
      io.stdout.write(formatJsonString(resp))
    } else {
      io.stdout.write(formatText(resp, { ansi: flags.color }))
    }
    return 0
  } catch (err) {
    if (err instanceof WebSearchAllFailedError) {
      io.stderr.write(`${reportFailure(err)}\n`)
      return 2
    }
    io.stderr.write(`error: ${(err as Error).message}\n`)
    return 2
  } finally {
    process.off("SIGINT", onSig)
    process.off("SIGTERM", onSig)
  }
}

// Keep the safety net referenced — silences "defaultConfig unused" for linters
// that don't know `loadWebSearchConfig` already returns the default.
void defaultConfig

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
