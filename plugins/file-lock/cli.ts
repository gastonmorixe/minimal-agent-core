#!/usr/bin/env bun
/**
 * `file-lock` CLI : inspect/clear cooperative file locks from the shell.
 *
 * Subcommands mirror the `LockStatus` tool the agent exposes to the model:
 *
 *   list [PATH]                : walk PATH (default cwd) for *.locked files
 *   inspect <FILE>             : show one lock's holder (FILE is the path of
 *                                the protected file, NOT the .locked sibling)
 *   clear-stale [PATH]         : auto-remove locks the live acquirer would
 *                                also break (dead PID, time-stale, corrupt)
 *   clear <FILE>               : force-remove one lock (with a verdict)
 *   path                       : print the config path the auto-locker reads
 *
 * Global flags:
 *
 *   --json                     : JSON output (default: ANSI text)
 *   -h, --help                 : usage
 *
 * The CLI shares `lib`-equivalent code with the LockStatus handler: both
 * call into `runList` / `runInspect` / `runClearStale` / `runClear` from
 * `handlers/lock_status.ts`, so the behavior is byte-identical.
 *
 * Run via `bun run plugins/file-lock/cli.ts <cmd>` or, if symlinked
 * to a PATH location, `file-lock <cmd>`.
 */

import { hostname } from "node:os"
import { isAbsolute } from "node:path"

import { configPath as userConfigPath } from "../../src/config.ts"
import { DEFAULT_STALE_AFTER_MS } from "../../src/file-lock.ts"
import { parseJsonc } from "../../src/jsonc.ts"

import {
  type RunDeps,
  runClear,
  runClearStale,
  runInspect,
  runList,
} from "./handlers/lock_status.ts"

function readStaleAfterMs(): number {
  try {
    const fs = require("node:fs") as typeof import("node:fs")
    const p = userConfigPath()
    if (!fs.existsSync(p)) return DEFAULT_STALE_AFTER_MS
    const raw = fs.readFileSync(p, "utf-8")
    const parsed = parseJsonc(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== "object") return DEFAULT_STALE_AFTER_MS
    const plugins = (parsed as Record<string, unknown>).plugins as
      | Record<string, unknown>
      | undefined
    const block = plugins?.["file-lock"] as Record<string, unknown> | undefined
    const v = block?.staleAfterMs
    if (typeof v === "number" && v > 0) return v
    return DEFAULT_STALE_AFTER_MS
  } catch {
    return DEFAULT_STALE_AFTER_MS
  }
}

interface ParsedArgs {
  cmd: string
  positional: string[]
  json: boolean
  help: boolean
}

/** Parse the lock-CLI argv into command, positionals, and flags. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { cmd: "", positional: [], json: false, help: false }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === "--json") out.json = true
    else if (a === "-h" || a === "--help") out.help = true
    else rest.push(a)
  }
  out.cmd = rest[0] ?? ""
  out.positional = rest.slice(1)
  return out
}

const USAGE = `Usage:
  file-lock list [PATH]              # walk PATH (default cwd) for *.locked
  file-lock inspect <FILE>           # show one lock's holder
  file-lock clear-stale [PATH]       # remove stale/corrupt locks
  file-lock clear <FILE>             # force-remove one lock
  file-lock path                     # print config path used by the auto-locker

Flags:
  --json                             # JSON output (default: ANSI text)
  -h, --help                         # show this message`

export interface RunCliResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Run the CLI logic without actually writing to process.stdout/stderr or
 * exiting. Returns the would-be result for tests. The bin entry below
 * calls this and forwards to process.
 */
export function runCli(argv: readonly string[]): RunCliResult {
  const args = parseArgs(argv)
  if (args.help || !args.cmd) {
    return { exitCode: args.help ? 0 : args.cmd ? 0 : 2, stdout: USAGE + "\n", stderr: "" }
  }

  const format: "text" | "json" = args.json ? "json" : "text"
  const deps: RunDeps = {
    cwd: process.cwd(),
    hostname: () => hostname(),
    staleAfterMs: readStaleAfterMs(),
  }

  switch (args.cmd) {
    case "list": {
      const path = args.positional[0]
      const r = runList({ action: "list", path, format }, deps)
      return {
        exitCode: r.is_error ? 1 : 0,
        stdout: r.is_error ? "" : r.content + "\n",
        stderr: r.is_error ? r.content + "\n" : "",
      }
    }
    case "inspect": {
      const fp = args.positional[0]
      if (!fp) return errExit("inspect: <FILE> required")
      if (!isAbsolute(fp)) return errExit("inspect: <FILE> must be absolute")
      const r = runInspect({ action: "inspect", path: fp, format }, deps)
      return {
        exitCode: r.is_error ? 1 : 0,
        stdout: r.is_error ? "" : r.content + "\n",
        stderr: r.is_error ? r.content + "\n" : "",
      }
    }
    case "clear-stale": {
      const path = args.positional[0]
      const r = runClearStale({ action: "clear-stale", path, format }, deps)
      return {
        exitCode: r.is_error ? 1 : 0,
        stdout: r.is_error ? "" : r.content + "\n",
        stderr: r.is_error ? r.content + "\n" : "",
      }
    }
    case "clear": {
      const fp = args.positional[0]
      if (!fp) return errExit("clear: <FILE> required")
      if (!isAbsolute(fp)) return errExit("clear: <FILE> must be absolute")
      const r = runClear({ action: "clear", path: fp, format }, deps)
      return {
        exitCode: r.is_error ? 1 : 0,
        stdout: r.is_error ? "" : r.content + "\n",
        stderr: r.is_error ? r.content + "\n" : "",
      }
    }
    case "path": {
      return { exitCode: 0, stdout: userConfigPath() + "\n", stderr: "" }
    }
    default:
      return errExit(`unknown command: ${args.cmd}\n\n${USAGE}`)
  }
}

function errExit(msg: string): RunCliResult {
  return { exitCode: 2, stdout: "", stderr: msg + "\n" }
}

// ---------------------------------------------------------------------------
// Bin entry
// ---------------------------------------------------------------------------

// Run when invoked directly (i.e. not when imported by tests). The
// `import.meta.main` check is Bun-friendly and the same idiom used
// elsewhere in plugins (see memory/cli.ts).
if (import.meta.main) {
  const r = runCli(process.argv.slice(2))
  if (r.stdout.length > 0) process.stdout.write(r.stdout)
  if (r.stderr.length > 0) process.stderr.write(r.stderr)
  process.exit(r.exitCode)
}
