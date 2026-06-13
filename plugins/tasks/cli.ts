#!/usr/bin/env bun

/**
 * Standalone CLI for the tasks plugin.
 *
 * Same surface as the in-agent {@link Task} tool, callable from a shell.
 * Useful for:
 *   - Inspecting / curating tasks without booting the full agent.
 *   - Quick adds / done flips during ad-hoc work.
 *   - Resuming a session from the shell to see where it left off.
 *
 * Run:
 *   bun run plugins/tasks/cli.ts <command> [args] [flags]
 *
 * Commands:
 * ```
 *   list                              Render the current task list.
 *   add <title...>                    Append a new task.
 *   start <id>                        Flip a task to doing.
 *   done <id>                         Mark a task done.
 *   status <id> <status> [reason...]  Set status (todo/doing/done/canceled).
 *   update <id> <title...>            Change a task's title.
 *   remove <id>                       Drop a task (cascades subtasks).
 *   reorder <id1> <id2> ...           Reorder top-level tasks.
 *   clear                             Wipe all (refuses if a task is doing).
 *   path                              Print the resolved file path.
 * ```
 *
 * Flags (global):
 * ```
 *   --sid <sid>                       Session id (default: $MINIMAL_AGENT_SESSION_ID)
 *   --home <path>                     Override the HOME dir (default: $HOME). Tasks file
 *                                     lives at <home>/.minimal-agent/sessions/<sid>.tasks.jsonl.
 *   --parent <id>                     For `add`: make this a subtask of <id>.
 *   --parallel                        For `start`: don't demote sibling doings.
 *   --force                           For `clear`: override the doing refusal.
 *   --no-color                        Disable ANSI colors.
 *   -f, --format text|json            Output format for `list`/`status`/etc. (default: text)
 *   -h, --help                        Show this help.
 * ```
 *
 * Exit codes:
 *   0  success
 *   1  usage error (bad flag, missing required arg)
 *   2  domain error (id not found, refused operation, etc.)
 *
 * @module tasks/cli
 */

import { isTaskStatus, type TaskStatus } from "./lib/parse.ts"
import { type RenderAction, renderBlock } from "./lib/render.ts"
import { TaskStore, TaskStoreError } from "./lib/store.ts"

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

interface Flags {
  command?:
    | "list"
    | "add"
    | "start"
    | "done"
    | "status"
    | "update"
    | "remove"
    | "reorder"
    | "clear"
    | "path"
  positional: string[]
  sid?: string
  home?: string
  parent?: string
  parallel: boolean
  force: boolean
  noColor: boolean
  format: "text" | "json"
  help: boolean
  errors: string[]
}

/** Parse the tasks-CLI argv into typed flags (command, filters, format). */
function parseArgv(argv: readonly string[]): Flags {
  const flags: Flags = {
    positional: [],
    parallel: false,
    force: false,
    noColor: false,
    format: "text",
    help: false,
    errors: [],
  }
  let i = 0
  if (i < argv.length && !argv[i].startsWith("-")) {
    flags.command = argv[i] as Flags["command"]
    i += 1
  }
  while (i < argv.length) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      flags.help = true
      i += 1
    } else if (a === "--sid") {
      flags.sid = argv[i + 1]
      i += 2
    } else if (a === "--home") {
      flags.home = argv[i + 1]
      i += 2
    } else if (a === "--parent") {
      flags.parent = argv[i + 1]
      i += 2
    } else if (a === "--parallel") {
      flags.parallel = true
      i += 1
    } else if (a === "--force") {
      flags.force = true
      i += 1
    } else if (a === "--no-color") {
      flags.noColor = true
      i += 1
    } else if (a === "-f" || a === "--format") {
      const next = argv[i + 1]
      if (next !== "text" && next !== "json") {
        flags.errors.push(`--format must be 'text' or 'json' (got "${next}")`)
      } else {
        flags.format = next
      }
      i += 2
    } else if (a.startsWith("-") && a !== "-") {
      flags.errors.push(`unknown flag: ${a}`)
      i += 1
    } else {
      flags.positional.push(a)
      i += 1
    }
  }
  return flags
}

function help(): string {
  return `tasks — per-session task list

Usage:
  bun run plugins/tasks/cli.ts <command> [args] [flags]

Commands:
  list                              Render the current task list.
  add <title...>                    Append a new task.
  start <id>                        Flip a task to doing.
  done <id>                         Mark a task done.
  status <id> <status> [reason...]  Set status (todo/doing/done/canceled).
  update <id> <title...>            Change a task's title.
  remove <id>                       Drop a task (cascades subtasks).
  reorder <id1> <id2> ...           Reorder top-level tasks.
  clear                             Wipe all (refuses if a task is doing).
  path                              Print the resolved file path.

Flags:
  --sid <sid>                       Session id (default: $MINIMAL_AGENT_SESSION_ID)
  --home <path>                     Override HOME (default: $HOME)
  --parent <id>                     For 'add': make this a subtask of <id>.
  --parallel                        For 'start': don't demote sibling doings.
  --force                           For 'clear': override the doing refusal.
  --no-color                        Disable ANSI colors.
  -f, --format text|json            Output format (default: text)
  -h, --help                        Show this help.
`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSid(flags: Flags): string | null {
  if (flags.sid) return flags.sid
  const env = process.env.MINIMAL_AGENT_SESSION_ID
  if (env && env.trim()) return env.trim()
  return null
}

function render(store: TaskStore, action: RenderAction, useAnsi: boolean): string {
  return renderBlock(store.views(), store.stats(), { ansi: useAnsi, action })
}

function resolveIdRef(raw: string): string | number {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

/** Dispatch the parsed flags to the matching task-store operation. */
function run(flags: Flags): { code: number; output: string } {
  if (flags.help || flags.command === undefined) {
    return { code: 0, output: help() }
  }
  if (flags.errors.length > 0) {
    return { code: 1, output: `tasks: ${flags.errors.join("; ")}\n` }
  }

  const storeDeps = flags.home ? { home: flags.home } : {}

  if (flags.command === "path") {
    const sid = getSid(flags)
    if (sid === null)
      return { code: 1, output: "tasks: --sid or MINIMAL_AGENT_SESSION_ID required\n" }
    return { code: 0, output: `${new TaskStore(sid, storeDeps).path}\n` }
  }

  const sid = getSid(flags)
  if (sid === null)
    return { code: 1, output: "tasks: --sid or MINIMAL_AGENT_SESSION_ID required\n" }
  const store = new TaskStore(sid, storeDeps)
  const useAnsi = !flags.noColor && process.stdout.isTTY === true

  try {
    switch (flags.command) {
      case "list": {
        if (flags.format === "json") {
          const out = {
            stats: store.stats(),
            tasks: store.list(),
          }
          return { code: 0, output: `${JSON.stringify(out, null, 2)}\n` }
        }
        return { code: 0, output: render(store, { kind: "list" }, useAnsi) }
      }
      case "add": {
        if (flags.positional.length === 0) {
          return { code: 1, output: "tasks: add requires a title\n" }
        }
        const title = flags.positional.join(" ")
        const parentId = flags.parent ? store.resolve(resolveIdRef(flags.parent))?.id : null
        if (flags.parent && !parentId) {
          return { code: 2, output: `tasks: parent "${flags.parent}" not found\n` }
        }
        const task = store.add({ title, parent: parentId ?? null })
        return { code: 0, output: render(store, { kind: "added", hash: task.id }, useAnsi) }
      }
      case "start": {
        if (flags.positional.length !== 1) {
          return { code: 1, output: "tasks: start requires exactly one id\n" }
        }
        const target = store.resolve(resolveIdRef(flags.positional[0]))
        if (target === null) {
          return { code: 2, output: `tasks: id "${flags.positional[0]}" not found\n` }
        }
        store.start(target.id, { parallel: flags.parallel })
        return { code: 0, output: render(store, { kind: "started", hash: target.id }, useAnsi) }
      }
      case "done": {
        if (flags.positional.length !== 1) {
          return { code: 1, output: "tasks: done requires exactly one id\n" }
        }
        const target = store.resolve(resolveIdRef(flags.positional[0]))
        if (target === null) {
          return { code: 2, output: `tasks: id "${flags.positional[0]}" not found\n` }
        }
        store.done(target.id)
        const s = store.stats()
        const action: RenderAction =
          target.parent === null && s.total > 0 && s.done === s.total
            ? { kind: "all_done" }
            : { kind: "marked_done", hash: target.id }
        return { code: 0, output: render(store, action, useAnsi) }
      }
      case "status": {
        if (flags.positional.length < 2) {
          return { code: 1, output: "tasks: status requires <id> <status> [reason]\n" }
        }
        const [idRaw, statusRaw, ...rest] = flags.positional
        if (!isTaskStatus(statusRaw)) {
          return { code: 1, output: `tasks: invalid status "${statusRaw}"\n` }
        }
        const target = store.resolve(resolveIdRef(idRaw))
        if (target === null) {
          return { code: 2, output: `tasks: id "${idRaw}" not found\n` }
        }
        const reason = rest.length > 0 ? rest.join(" ") : undefined
        store.setStatus(target.id, statusRaw as TaskStatus, reason)
        const verb: RenderAction =
          statusRaw === "done"
            ? { kind: "marked_done", hash: target.id }
            : statusRaw === "doing"
              ? { kind: "marked_doing", hash: target.id }
              : statusRaw === "canceled"
                ? { kind: "marked_canceled", hash: target.id }
                : { kind: "marked_todo", hash: target.id }
        return { code: 0, output: render(store, verb, useAnsi) }
      }
      case "update": {
        if (flags.positional.length < 2) {
          return { code: 1, output: "tasks: update requires <id> <new title>\n" }
        }
        const [idRaw, ...titleParts] = flags.positional
        const target = store.resolve(resolveIdRef(idRaw))
        if (target === null) {
          return { code: 2, output: `tasks: id "${idRaw}" not found\n` }
        }
        store.update(target.id, titleParts.join(" "))
        return { code: 0, output: render(store, { kind: "updated", hash: target.id }, useAnsi) }
      }
      case "remove": {
        if (flags.positional.length !== 1) {
          return { code: 1, output: "tasks: remove requires exactly one id\n" }
        }
        const target = store.resolve(resolveIdRef(flags.positional[0]))
        if (target === null) {
          return { code: 2, output: `tasks: id "${flags.positional[0]}" not found\n` }
        }
        store.remove(target.id)
        return { code: 0, output: render(store, { kind: "removed", hash: target.id }, useAnsi) }
      }
      case "reorder": {
        if (flags.positional.length < 2) {
          return { code: 1, output: "tasks: reorder requires 2+ ids\n" }
        }
        store.reorder(flags.positional.map(resolveIdRef))
        return { code: 0, output: render(store, { kind: "reordered" }, useAnsi) }
      }
      case "clear": {
        const before = store.stats().total
        store.clear(flags.force)
        return { code: 0, output: render(store, { kind: "cleared", count: before }, useAnsi) }
      }
      default: {
        return { code: 1, output: `tasks: unknown command "${flags.command}"\n${help()}` }
      }
    }
  } catch (e) {
    if (e instanceof TaskStoreError) {
      return { code: 2, output: `tasks: ${e.message.replace(/^TaskStore[.\s]*/, "")}\n` }
    }
    const msg = e instanceof Error ? e.message : String(e)
    return { code: 2, output: `tasks: ${msg}\n` }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export { parseArgv, run }

if (import.meta.main) {
  const flags = parseArgv(process.argv.slice(2))
  const { code, output } = run(flags)
  process.stdout.write(output)
  process.exit(code)
}
