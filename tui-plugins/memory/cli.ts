#!/usr/bin/env bun
/**
 * Standalone CLI for the memory plugin.
 *
 * Same CRUD as the in-agent {@link MemoryTool}, callable from a shell —
 * useful for:
 *   - Curating saved memories without booting the full agent.
 *   - Quick edits / removes from outside a session.
 *   - Stamping persistent ids onto legacy bullets (rewrite-ids).
 *   - Inspecting where a scope's file lives (path).
 *
 * Run:
 *   bun run tui-plugins/memory/cli.ts <command> [args] [flags]
 *
 * Commands:
 *   list                              List entries in a scope.
 *   read <id>                         Read one entry by id.
 *   add <body...>                     Append a new entry.
 *   edit <id> <body...>               Replace an entry's body.
 *   remove <id>                       Drop an entry.
 *   clear                             Wipe a scope (short-term only).
 *   rewrite-ids                       Stamp [#<id>] onto legacy bullets in-place.
 *   path                              Print the resolved file path.
 *
 * Flags (global):
 *   -s, --scope <s>                   global | project | short-term (default: project)
 *   --cwd <path>                      Working dir for project scope (default: $PWD)
 *   --sid <sid>                       Session id for short-term (default: $MINIMAL_AGENT_SESSION_ID)
 *   -f, --format text|json            Output format (default: text)
 *   --no-color                        Disable ANSI colors in text output
 *   -h, --help                        Show this help
 *
 * Flags (list only):
 *   -q, --query <s>                   Case-insensitive substring filter
 *   -L, --limit <n>                   Show only the N most recent matches
 *
 * Exit codes:
 *   0  success
 *   1  usage error (bad flag, missing required arg)
 *   2  domain error (id not found, refused operation, etc.)
 *
 * @module memory/cli
 */

import {
  bulletsToJson,
  bulletToJson,
  formatAdded,
  formatCleared,
  formatEdited,
  formatList,
  formatRead,
  formatRemoved,
} from "./lib/format.ts"
import {
  formatBullet,
  newPersistentId,
  parseFileWithLines,
  serializeFile,
} from "./lib/parse.ts"
import {
  globalMemoryPath,
  MemoryStore,
  projectMemoryPath,
  shortTermMemoryPath,
  type StoreKind,
} from "./lib/store.ts"

import { existsSync, readFileSync, writeFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

interface Flags {
  command?:
    | "list"
    | "read"
    | "add"
    | "edit"
    | "remove"
    | "clear"
    | "rewrite-ids"
    | "path"
  positional: string[]
  scope: StoreKind
  cwd: string
  sid?: string
  format: "text" | "json"
  color: boolean
  help: boolean
  query?: string
  limit?: number
}

const VALID_SCOPES = new Set<StoreKind>(["global", "project", "short-term"])
const VALID_COMMANDS = new Set([
  "list",
  "read",
  "add",
  "edit",
  "remove",
  "clear",
  "rewrite-ids",
  "path",
])

const HELP = `memory — manage saved memories from a shell.

Usage:
  bun run tui-plugins/memory/cli.ts <command> [args] [flags]

Commands:
  list                              List entries in a scope.
  read <id>                         Read one entry by id.
  add <body...>                     Append a new entry.
  edit <id> <body...>               Replace an entry's body.
  remove <id>                       Drop an entry.
  clear                             Wipe a scope (short-term only).
  rewrite-ids                       Stamp [#<id>] onto legacy bullets in-place.
  path                              Print the resolved file path.

Flags (global):
  -s, --scope <s>                   global | project | short-term (default: project)
  --cwd <path>                      Working dir for project scope (default: $PWD)
  --sid <sid>                       Session id for short-term (default: $MINIMAL_AGENT_SESSION_ID)
  -f, --format text|json            Output format (default: text)
  --no-color                        Disable ANSI colors in text output
  -h, --help                        Show this help

Flags (list only):
  -q, --query <s>                   Case-insensitive substring filter
  -L, --limit <n>                   Show only the N most recent matches

Examples:
  bun run tui-plugins/memory/cli.ts list
  bun run tui-plugins/memory/cli.ts list -s global -L 5
  bun run tui-plugins/memory/cli.ts read lwq8tg-a8f3
  bun run tui-plugins/memory/cli.ts add "user prefers concise replies" -s global
  bun run tui-plugins/memory/cli.ts edit lwq8tg-a8f3 "revised body"
  bun run tui-plugins/memory/cli.ts remove lwq8tg-a8f3
  bun run tui-plugins/memory/cli.ts clear -s short-term --sid <sid>
  bun run tui-plugins/memory/cli.ts rewrite-ids -s project
  bun run tui-plugins/memory/cli.ts path -s project --cwd ~/Projects/app
`

class UsageError extends Error {}

/**
 * Argv parser. Walks `argv` once, gathering flags and positionals.
 * Throws a {@link UsageError} on any malformed input — `main` catches and
 * prints HELP.
 */
export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    positional: [],
    scope: "project",
    cwd: process.cwd(),
    sid: process.env.MINIMAL_AGENT_SESSION_ID,
    format: "text",
    color: process.stdout.isTTY ?? false,
    help: false,
  }

  // First non-flag positional is the command. Subsequent positionals
  // are command-specific args (id, body parts, etc.).
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      flags.help = true
      i++
      continue
    }
    if (a === "--no-color") {
      flags.color = false
      i++
      continue
    }
    if (a === "-s" || a === "--scope") {
      const v = argv[++i]
      if (!v) throw new UsageError(`${a} requires a value`)
      if (!VALID_SCOPES.has(v as StoreKind)) {
        throw new UsageError(`unknown scope: ${v} (valid: ${[...VALID_SCOPES].join(", ")})`)
      }
      flags.scope = v as StoreKind
      i++
      continue
    }
    if (a === "--cwd") {
      const v = argv[++i]
      if (!v) throw new UsageError("--cwd requires a value")
      flags.cwd = v
      i++
      continue
    }
    if (a === "--sid") {
      const v = argv[++i]
      if (!v) throw new UsageError("--sid requires a value")
      flags.sid = v
      i++
      continue
    }
    if (a === "-f" || a === "--format") {
      const v = argv[++i]
      if (v !== "text" && v !== "json") {
        throw new UsageError(`--format must be text|json (got: ${v})`)
      }
      flags.format = v
      i++
      continue
    }
    if (a === "-q" || a === "--query") {
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${a} requires a value`)
      flags.query = v
      i++
      continue
    }
    if (a === "-L" || a === "--limit") {
      const v = argv[++i]
      if (!v) throw new UsageError(`${a} requires a value`)
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1) {
        throw new UsageError(`--limit must be a positive integer (got: ${v})`)
      }
      flags.limit = n
      i++
      continue
    }
    if (a?.startsWith("-")) {
      throw new UsageError(`unknown flag: ${a}`)
    }
    // Positional.
    if (flags.command === undefined) {
      if (!VALID_COMMANDS.has(a!)) {
        throw new UsageError(
          `unknown command: ${a} (valid: ${[...VALID_COMMANDS].join(", ")})`,
        )
      }
      flags.command = a as Flags["command"]
    } else {
      flags.positional.push(a!)
    }
    i++
  }

  return flags
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

function makeStore(flags: Flags): MemoryStore {
  if (flags.scope === "global") return MemoryStore.global({ sid: flags.sid ?? null })
  if (flags.scope === "short-term") {
    if (!flags.sid) {
      throw new UsageError(
        "scope=short-term requires --sid (or $MINIMAL_AGENT_SESSION_ID)",
      )
    }
    return MemoryStore.shortTerm(flags.sid)
  }
  return MemoryStore.project(flags.cwd, { sid: flags.sid ?? null })
}

function pathForScope(flags: Flags): string {
  if (flags.scope === "global") return globalMemoryPath()
  if (flags.scope === "short-term") {
    if (!flags.sid) {
      throw new UsageError(
        "scope=short-term requires --sid (or $MINIMAL_AGENT_SESSION_ID)",
      )
    }
    return shortTermMemoryPath(flags.sid)
  }
  return projectMemoryPath(flags.cwd)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface IO {
  stdout: { write: (s: string) => void }
  stderr: { write: (s: string) => void }
}

function cmdList(flags: Flags, io: IO): number {
  const store = makeStore(flags)
  const all = store.list()
  const filtered = flags.query
    ? all.filter((b) => b.body.toLowerCase().includes(flags.query!.toLowerCase()))
    : all
  const sliced = flags.limit && filtered.length > flags.limit
    ? filtered.slice(-flags.limit)
    : filtered

  if (flags.format === "json") {
    io.stdout.write(
      `${JSON.stringify(
        { scope: flags.scope, total: filtered.length, shown: sliced.length, bullets: bulletsToJson(sliced) },
        null,
        2,
      )}\n`,
    )
  } else {
    io.stdout.write(formatList(sliced, { scope: flags.scope, ansi: flags.color, total: filtered.length }))
  }
  return 0
}

function cmdRead(flags: Flags, io: IO): number {
  const id = flags.positional[0]
  if (!id) {
    io.stderr.write("error: read requires <id>\n")
    return 1
  }
  const store = makeStore(flags)
  const b = store.read(id)
  if (b === null) {
    io.stderr.write(`error: no bullet with id="${id}" in scope="${flags.scope}"\n`)
    return 2
  }
  if (flags.format === "json") {
    io.stdout.write(`${JSON.stringify({ scope: flags.scope, bullet: bulletToJson(b) }, null, 2)}\n`)
  } else {
    io.stdout.write(formatRead(b, flags.scope, flags.color))
  }
  return 0
}

function cmdAdd(flags: Flags, io: IO): number {
  const body = flags.positional.join(" ")
  if (body.trim().length === 0) {
    io.stderr.write("error: add requires <body>\n")
    return 1
  }
  const store = makeStore(flags)
  const { bullet, evicted } = store.add(body)
  if (flags.format === "json") {
    io.stdout.write(
      `${JSON.stringify({ scope: flags.scope, id: bullet.id, ts: bullet.ts, evicted: evicted.length }, null, 2)}\n`,
    )
  } else {
    io.stdout.write(formatAdded(bullet, flags.scope, evicted.length, flags.color))
  }
  return 0
}

function cmdEdit(flags: Flags, io: IO): number {
  const id = flags.positional[0]
  const body = flags.positional.slice(1).join(" ")
  if (!id || body.trim().length === 0) {
    io.stderr.write("error: edit requires <id> <body>\n")
    return 1
  }
  const store = makeStore(flags)
  const updated = store.edit(id, body)
  if (updated === null) {
    io.stderr.write(`error: no bullet with id="${id}" in scope="${flags.scope}"\n`)
    return 2
  }
  if (flags.format === "json") {
    io.stdout.write(`${JSON.stringify({ scope: flags.scope, bullet: bulletToJson(updated) }, null, 2)}\n`)
  } else {
    io.stdout.write(formatEdited(updated, flags.scope, flags.color))
  }
  return 0
}

function cmdRemove(flags: Flags, io: IO): number {
  const id = flags.positional[0]
  if (!id) {
    io.stderr.write("error: remove requires <id>\n")
    return 1
  }
  const store = makeStore(flags)
  const removed = store.remove(id)
  if (removed === null) {
    io.stderr.write(`error: no bullet with id="${id}" in scope="${flags.scope}"\n`)
    return 2
  }
  if (flags.format === "json") {
    io.stdout.write(`${JSON.stringify({ scope: flags.scope, removed: bulletToJson(removed) }, null, 2)}\n`)
  } else {
    io.stdout.write(formatRemoved(removed, flags.scope, flags.color))
  }
  return 0
}

function cmdClear(flags: Flags, io: IO): number {
  if (flags.scope !== "short-term") {
    io.stderr.write(
      `error: clear is only allowed for scope="short-term" (refused: ${flags.scope}). Use repeated remove(id) for persistent scopes.\n`,
    )
    return 2
  }
  const store = makeStore(flags)
  const count = store.clear()
  if (flags.format === "json") {
    io.stdout.write(`${JSON.stringify({ scope: flags.scope, cleared: count }, null, 2)}\n`)
  } else {
    io.stdout.write(formatCleared(count, flags.scope, flags.color))
  }
  return 0
}

function cmdRewriteIds(flags: Flags, io: IO): number {
  if (flags.scope === "short-term") {
    io.stderr.write(
      `error: rewrite-ids is only meaningful for global/project (short-term ids are integers, not synthetic).\n`,
    )
    return 2
  }
  const path = pathForScope(flags)
  if (!existsSync(path)) {
    io.stdout.write(`(no file at ${path}; nothing to rewrite)\n`)
    return 0
  }
  const before = readFileSync(path, "utf-8")
  const lines = parseFileWithLines(before)
  let stamped = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l?.kind !== "bullet") continue
    if (!l.bullet.isLegacy) continue
    // Mint a fresh persistent id and rewrite the line. The bullet's
    // existing ts/sid are preserved (they were `null` for many legacy
    // bullets, which is fine — `formatBullet` omits null fields).
    const id = newPersistentId()
    const newRaw = formatBullet({
      id,
      ts: l.bullet.ts,
      sid: l.bullet.sid,
      body: l.bullet.body,
    })
    lines[i] = {
      kind: "bullet",
      bullet: { ...l.bullet, id, isLegacy: false, raw: newRaw },
      raw: newRaw,
    }
    stamped++
  }
  if (stamped === 0) {
    io.stdout.write(`(no legacy bullets found in ${path})\n`)
    return 0
  }
  writeFileSync(path, serializeFile(lines), "utf-8")
  if (flags.format === "json") {
    io.stdout.write(`${JSON.stringify({ scope: flags.scope, path, stamped }, null, 2)}\n`)
  } else {
    io.stdout.write(`stamped ${stamped} legacy bullet(s) in ${path}\n`)
  }
  return 0
}

function cmdPath(flags: Flags, io: IO): number {
  const path = pathForScope(flags)
  if (flags.format === "json") {
    io.stdout.write(`${JSON.stringify({ scope: flags.scope, path }, null, 2)}\n`)
  } else {
    io.stdout.write(`${path}\n`)
  }
  return 0
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Entry point. Returns an exit code; doesn't call `process.exit` itself
 * so it can be unit-tested.
 */
export async function main(
  argv: string[],
  io: IO = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let flags: Flags
  try {
    flags = parseArgs(argv)
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`error: ${e.message}\n\n${HELP}`)
      return 1
    }
    throw e
  }

  if (flags.help || flags.command === undefined) {
    io.stdout.write(HELP)
    return flags.command === undefined && !flags.help ? 1 : 0
  }

  try {
    switch (flags.command) {
      case "list":
        return cmdList(flags, io)
      case "read":
        return cmdRead(flags, io)
      case "add":
        return cmdAdd(flags, io)
      case "edit":
        return cmdEdit(flags, io)
      case "remove":
        return cmdRemove(flags, io)
      case "clear":
        return cmdClear(flags, io)
      case "rewrite-ids":
        return cmdRewriteIds(flags, io)
      case "path":
        return cmdPath(flags, io)
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`error: ${e.message}\n`)
      return 1
    }
    const msg = e instanceof Error ? e.message : String(e)
    io.stderr.write(`error: ${msg}\n`)
    return 2
  }
  return 1
}

// Run when invoked directly (`bun run tui-plugins/memory/cli.ts ...`).
// Bun sets `import.meta.main = true` in this case.
if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
