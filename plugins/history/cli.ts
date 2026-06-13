#!/usr/bin/env bun
/**
 * Standalone CLI for the history plugin.
 *
 * Useful for inspecting / curating prompt history without booting the
 * agent — e.g. "what did I ask yesterday", "wipe everything before the
 * demo", "export to JSON for a different tool to read".
 *
 * Run:
 *   bun run plugins/history/cli.ts <command> [args] [flags]
 *
 * Commands:
 *   list                           Print entries (newest first).
 *   search <query>                 Print entries whose text contains `query`.
 *   clear                          Delete the history file (with confirm).
 *   path                           Print the resolved file path.
 *   export                         Stream raw JSONL to stdout.
 *
 * Flags (global):
 *   -s, --scope <s>                project (default) | global
 *   --cwd <path>                   Working dir for project scope (default: $PWD)
 *   -L, --limit <n>                Show only the N most recent matches.
 *   -f, --format text|json         Output format (default: text)
 *   -h, --help                     Show this help.
 *
 * Exit codes:
 *   0  success
 *   1  usage error
 *   2  domain error
 *
 * @module history/cli
 */

import { existsSync, rmSync } from "node:fs"

import {
  globalHistoryPath,
  type HistoryEntry,
  loadEntries,
  projectHistoryPath,
} from "./lib/store.ts"

type Scope = "project" | "global"
type Format = "text" | "json"

interface ParsedArgs {
  command: string
  positionals: string[]
  scope: Scope
  cwd: string
  limit: number | null
  format: Format
  help: boolean
}

const USAGE = `Usage: bun run plugins/history/cli.ts <command> [args] [flags]

Commands:
  list                       Print entries (newest first).
  search <query>             Print entries whose text contains <query>.
  clear                      Delete the history file.
  path                       Print the resolved file path.
  export                     Stream raw JSONL to stdout.

Flags:
  -s, --scope <s>            project (default) | global
  --cwd <path>               Working dir for project scope (default: $PWD)
  -L, --limit <n>            Show only N most recent.
  -f, --format text|json     Output format (default: text)
  -h, --help                 Show this help.
`

/** Parse the history-CLI argv into a typed args record. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  let scope: Scope = "project"
  let cwd = process.cwd()
  let limit: number | null = null
  let format: Format = "text"
  let help = false
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      help = true
      i++
      continue
    }
    if (a === "-s" || a === "--scope") {
      const v = argv[i + 1]
      if (v !== "project" && v !== "global") throw new UsageError(`invalid scope: ${v}`)
      scope = v
      i += 2
      continue
    }
    if (a.startsWith("--scope=")) {
      const v = a.slice("--scope=".length)
      if (v !== "project" && v !== "global") throw new UsageError(`invalid scope: ${v}`)
      scope = v
      i++
      continue
    }
    if (a === "--cwd") {
      cwd = argv[i + 1] ?? cwd
      i += 2
      continue
    }
    if (a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length)
      i++
      continue
    }
    if (a === "-L" || a === "--limit") {
      const n = Number(argv[i + 1])
      if (!Number.isFinite(n) || n <= 0) throw new UsageError(`invalid --limit: ${argv[i + 1]}`)
      limit = Math.floor(n)
      i += 2
      continue
    }
    if (a.startsWith("--limit=")) {
      const n = Number(a.slice("--limit=".length))
      if (!Number.isFinite(n) || n <= 0)
        throw new UsageError(`invalid --limit: ${a.slice("--limit=".length)}`)
      limit = Math.floor(n)
      i++
      continue
    }
    if (a === "-f" || a === "--format") {
      const v = argv[i + 1]
      if (v !== "text" && v !== "json") throw new UsageError(`invalid format: ${v}`)
      format = v
      i += 2
      continue
    }
    if (a.startsWith("--format=")) {
      const v = a.slice("--format=".length)
      if (v !== "text" && v !== "json") throw new UsageError(`invalid format: ${v}`)
      format = v
      i++
      continue
    }
    if (a.startsWith("-")) throw new UsageError(`unknown flag: ${a}`)
    positionals.push(a)
    i++
  }
  return {
    command: positionals[0] ?? "list",
    positionals: positionals.slice(1),
    scope,
    cwd,
    limit,
    format,
    help,
  }
}

/** Raised for bad CLI usage; rendered as usage help plus exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

/** Raised for domain failures (missing session, bad id); exit code 1. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DomainError"
  }
}

function resolveFile(args: ParsedArgs): string {
  return args.scope === "global" ? globalHistoryPath() : projectHistoryPath(args.cwd)
}

/**
 * Format a single entry for `text` output. Multi-line entries get a
 * `↵` glyph between rows so the operator sees the shape without
 * splitting into multiple visible lines.
 */
function formatEntryText(e: HistoryEntry): string {
  const flat = e.text.replace(/\n/g, " ↵ ")
  const exitTag = e.exit === "canceled" ? " [canceled]" : ""
  return `${e.ts} ${e.id} ${exitTag}${flat}`
}

/**
 * Apply `--limit` to a "newest-first" slice. `entries` arrives
 * oldest-first; we reverse and cap.
 */
function newestFirst(entries: HistoryEntry[], limit: number | null): HistoryEntry[] {
  const out = [...entries].reverse()
  if (limit !== null) out.length = Math.min(out.length, limit)
  return out
}

export interface RunIO {
  stdout: { write: (chunk: string) => unknown }
  stderr: { write: (chunk: string) => unknown }
  /**
   * Returns true to confirm a destructive op. Defaults to `true` in
   * non-interactive contexts; tests inject a fake.
   */
  confirm?: (prompt: string) => boolean
}

/**
 * CLI entrypoint: parses argv, dispatches the subcommand against the session
 * store, writes output through `io`, and returns the process exit code.
 */
export async function run(argv: string[], io: RunIO): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`error: ${e.message}\n${USAGE}`)
      return 1
    }
    throw e
  }
  if (args.help) {
    io.stdout.write(USAGE)
    return 0
  }

  switch (args.command) {
    case "list": {
      const path = resolveFile(args)
      const entries = newestFirst(loadEntries(path), args.limit)
      if (args.format === "json") {
        io.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
      } else if (entries.length === 0) {
        io.stdout.write("(no history)\n")
      } else {
        for (const e of entries) io.stdout.write(`${formatEntryText(e)}\n`)
      }
      return 0
    }
    case "search": {
      const query = args.positionals.join(" ").trim()
      if (query.length === 0) {
        io.stderr.write("error: search requires a query\n")
        return 1
      }
      const path = resolveFile(args)
      const all = loadEntries(path)
      const lowered = query.toLowerCase()
      const matches = newestFirst(
        all.filter((e) => e.text.toLowerCase().includes(lowered)),
        args.limit,
      )
      if (args.format === "json") {
        io.stdout.write(`${JSON.stringify(matches, null, 2)}\n`)
      } else if (matches.length === 0) {
        io.stdout.write(`(no matches for "${query}")\n`)
      } else {
        for (const e of matches) io.stdout.write(`${formatEntryText(e)}\n`)
      }
      return 0
    }
    case "clear": {
      const path = resolveFile(args)
      if (!existsSync(path)) {
        io.stdout.write("(already empty)\n")
        return 0
      }
      const confirm = io.confirm ?? (() => true)
      if (!confirm(`Delete ${path}? [y/N]`)) {
        io.stderr.write("aborted\n")
        return 2
      }
      try {
        rmSync(path)
      } catch (e) {
        io.stderr.write(`error: rm failed: ${e instanceof Error ? e.message : String(e)}\n`)
        return 2
      }
      io.stdout.write(`cleared ${path}\n`)
      return 0
    }
    case "path": {
      io.stdout.write(`${resolveFile(args)}\n`)
      return 0
    }
    case "export": {
      const path = resolveFile(args)
      const entries = loadEntries(path)
      for (const e of entries) io.stdout.write(`${JSON.stringify(e)}\n`)
      return 0
    }
    default: {
      io.stderr.write(`unknown command: ${args.command}\n${USAGE}`)
      return 1
    }
  }
}

// Module entry-point — only run when invoked directly via `bun run`.
if (import.meta.main) {
  const code = await run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  })
  process.exit(code)
}
