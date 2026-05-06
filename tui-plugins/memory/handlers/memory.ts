/**
 * Inline-tag handler for `<tui::memory [scope="global"|"project"]>...</tui::memory>`.
 *
 * Behavior:
 *   1. Append the body as a new bullet to the user's memory file. The target
 *      depends on the `scope` attribute:
 *        - scope="global"   → ~/.minimal-agent/memory.md
 *        - scope="project"  → ~/.minimal-agent/projects/<absolute-cwd>/memory.md  (default)
 *      The directory is created if missing.
 *   2. Render a short confirmation line in place of the tag span so the
 *      user can see the save happened. The body itself is not echoed.
 *
 * Memory files are reloaded into the system prompt at every session start
 * by this plugin's `memory_load` prompt fragment (handlers/load.ts).
 *
 * Safety:
 *   - The handler refuses to write under `ctx.packageDir` (defensive: this
 *     was the previous bug — the plugin used to mutate its own embedded
 *     `PROMPT.md`, dirtying the shipped repo and leaking the assistant's
 *     personal memories to every user of the agent).
 *   - Empty bodies are no-ops.
 *   - Multi-line bodies are collapsed to a single line so each bullet stays
 *     compact and the model is gently nudged toward short, actionable notes.
 *
 * Write failures surface as a one-line ANSI error so saves aren't silently lost.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"

import { globalMemoryPath, projectMemoryPath } from "./load.ts"

type Scope = "global" | "project"

/**
 * Local-time ISO 8601 string with seconds and timezone offset, e.g.
 * `2026-05-05T21:06:20-04:00`. Mirrors the format used by the env-info
 * plugin's `date_iso` field, so timestamps in saved memories are
 * grep-able against session-start snapshots.
 *
 * `Date.prototype.toISOString()` always emits UTC (`Z`) — we want local
 * time so a memory bullet reads naturally to the user without timezone
 * conversion. Exposed for tests; production callers pass `new Date()`.
 */
export function localIsoSeconds(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0")
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const ss = pad(d.getSeconds())
  // `getTimezoneOffset` returns minutes WEST of UTC (so EDT = +240).
  // ISO offset is signed the other way (EDT = `-04:00`), hence the negation.
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? "+" : "-"
  const absMin = Math.abs(offMin)
  const oh = pad(Math.floor(absMin / 60))
  const om = pad(absMin % 60)
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${oh}:${om}`
}

function parseScope(attrs: Record<string, string>): Scope {
  const raw = (attrs.scope ?? "").trim().toLowerCase()
  if (raw === "global") return "global"
  // Default = project. Most lessons learned during a session apply to the
  // codebase the session is running against, not the user's whole life.
  return "project"
}

function targetPath(scope: Scope, cwd: string): string {
  return scope === "global" ? globalMemoryPath() : projectMemoryPath(cwd)
}

export default async function memoryHandler(
  ctx: TUIContext,
): Promise<TUIResult> {
  if (ctx.trigger.type !== "inline_tag") {
    return { kind: "rendered", ansi: "" }
  }

  const body = ctx.trigger.body.trim()
  if (body.length === 0) {
    return { kind: "rendered", ansi: "" }
  }

  const scope = parseScope(ctx.trigger.attrs)
  const path = targetPath(scope, ctx.cwd)

  // Defensive: never let a memory write mutate the shipped plugin tree.
  // This shouldn't be reachable through normal config, but if `cwd` ever
  // resolves under `packageDir` (e.g. a test fixture), bail loudly.
  if (path.startsWith(`${ctx.packageDir}/`) || path === ctx.packageDir) {
    const ansi = `\x1b[31m· memory save refused: target inside plugin dir (${path})\x1b[0m\n`
    ctx.stderr.write(`[memory] refused write under packageDir: ${path}\n`)
    return { kind: "rendered", ansi }
  }

  // Collapse to a single line so the bullet stays clean. Multi-line memories
  // are joined with spaces; the model is instructed to keep them short.
  const oneLine = body.replace(/\s+/g, " ")
  // Prefix every newly-saved bullet with a local-time ISO timestamp (with
  // seconds) so memories carry temporal context when reloaded next session
  // — useful for spotting stale notes and ordering related observations.
  //
  // Backward compatibility: legacy bullets (saved before this change, or
  // hand-edited by the user) have no `[<ts>] ` prefix. The load fragment
  // (handlers/load.ts) treats the file as opaque text and never parses
  // bullets, so old and new formats coexist freely in the same file.
  const ts = localIsoSeconds()
  const bullet = `- [${ts}] ${oneLine}\n`

  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, bullet, "utf-8")

    const preview = oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine
    const tag = scope === "global" ? "global" : "project"
    const ansi = `\x1b[2m· memory saved [${tag}]: ${preview}\x1b[0m\n`
    return { kind: "rendered", ansi }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ctx.stderr.write(`[memory] save failed: ${msg}\n`)
    const ansi = `\x1b[31m· memory save failed: ${msg}\x1b[0m\n`
    return { kind: "rendered", ansi }
  }
}
