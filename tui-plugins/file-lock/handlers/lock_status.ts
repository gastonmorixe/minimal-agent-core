/**
 * `LockStatus` — model-facing CRUD-ish tool for cooperative file locks.
 *
 * Companion to the auto-locking wired into `Edit` / `Write` in `src/tools.ts`.
 * The locks themselves are written + parsed by `src/file-lock.ts`; this
 * handler is a thin facade that exposes inventory, inspection, and clearance
 * operations to the model and (via the CLI) the human.
 *
 * Actions:
 *   - `list`        — every `*.locked` under `path` (default cwd), with holder
 *                     details and an inferred status (`held` / `stale-pid` /
 *                     `stale-time` / `corrupt` / `cross-host`).
 *   - `inspect`     — one lock by file path.
 *   - `clear-stale` — auto-prune locks the live acquirer would also break:
 *                     dead PID on this host OR older than `staleAfterMs`.
 *                     Corrupt lock files are also pruned (parse fails →
 *                     stale by definition).
 *   - `clear`       — force-remove a specific lock. Loud about whether the
 *                     holder appears alive, so the model can second-guess
 *                     before smashing a peer.
 *
 * The handler is read-mostly by design: only `clear` and `clear-stale`
 * mutate disk state, and both refuse to operate outside the requested
 * `path` subtree.
 *
 * Result shape: `tool_result` with both `content` (compact text/JSON for
 * the model) and `display` (pretty ANSI for the transcript). The two are
 * always semantically equivalent — the audience differs only in
 * formatting.
 *
 * @module file-lock/handlers/lock_status
 */

import { existsSync, unlinkSync } from "node:fs"
import { hostname } from "node:os"
import { isAbsolute, resolve } from "node:path"

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"

import {
  DEFAULT_STALE_AFTER_MS,
  defaultPidAlive,
  type ListedLock,
  listLocksUnder,
  lockPathFor,
  readLockFile,
} from "../../../src/file-lock.ts"

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set(["list", "inspect", "clear-stale", "clear"])
const VALID_FORMATS = new Set(["text", "json"])

type Action = "list" | "inspect" | "clear-stale" | "clear"

interface ParsedInput {
  action: Action
  path?: string
  format: "text" | "json"
}

interface Validation {
  ok: boolean
  value?: ParsedInput
  error?: string
}

function validate(raw: Record<string, unknown>): Validation {
  if (typeof raw.action !== "string" || !VALID_ACTIONS.has(raw.action)) {
    return {
      ok: false,
      error: `\`action\` must be one of: ${[...VALID_ACTIONS].join(", ")}`,
    }
  }
  const action = raw.action as Action

  let path: string | undefined
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path.length === 0) {
      return { ok: false, error: "`path` must be a non-empty string" }
    }
    path = raw.path
  }

  // `inspect` and `clear` require an explicit absolute path — without one
  // we can't unambiguously pick "the lock". `list` and `clear-stale` allow
  // omitting it (defaults to cwd).
  if ((action === "inspect" || action === "clear") && (!path || !isAbsolute(path))) {
    return {
      ok: false,
      error: `\`path\` is required for action="${action}" and must be absolute.`,
    }
  }

  let format: "text" | "json" = "text"
  if (raw.format !== undefined) {
    if (typeof raw.format !== "string" || !VALID_FORMATS.has(raw.format)) {
      return { ok: false, error: `\`format\` must be one of: text, json` }
    }
    format = raw.format as "text" | "json"
  }

  return { ok: true, value: { action, path, format } }
}

// ---------------------------------------------------------------------------
// Status inference
// ---------------------------------------------------------------------------

/**
 * Inferred status of a lock. Mirrors the live acquirer's stale logic so
 * the human/model sees the same verdict the next acquire would render.
 */
export type LockStatus = "held" | "stale-pid" | "stale-time" | "corrupt" | "cross-host"

export interface AnnotatedLock extends ListedLock {
  status: LockStatus
  ageMs: number | null
  reason?: string
}

/** Annotate a listed lock with the verdict our live acquirer would reach. */
export function annotate(
  lock: ListedLock,
  ourHost: string,
  staleAfterMs: number,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
  now: () => number = Date.now,
): AnnotatedLock {
  if (lock.holder === null) {
    return { ...lock, status: "corrupt", ageMs: null, reason: "lock file is unreadable / corrupt" }
  }
  const ageMs = now() - lock.holder.acquiredAtMs
  if (lock.holder.host !== ourHost) {
    // Across hosts we can't probe PID. Time-only verdict.
    if (ageMs > staleAfterMs) {
      return {
        ...lock,
        status: "stale-time",
        ageMs,
        reason: `${Math.round(ageMs / 1000)}s old (>${Math.round(staleAfterMs / 1000)}s) on ${lock.holder.host}`,
      }
    }
    return { ...lock, status: "cross-host", ageMs, reason: `held on ${lock.holder.host}` }
  }
  if (!pidAlive(lock.holder.pid)) {
    return { ...lock, status: "stale-pid", ageMs, reason: `pid ${lock.holder.pid} not alive` }
  }
  if (ageMs > staleAfterMs) {
    return {
      ...lock,
      status: "stale-time",
      ageMs,
      reason: `${Math.round(ageMs / 1000)}s old (>${Math.round(staleAfterMs / 1000)}s)`,
    }
  }
  return { ...lock, status: "held", ageMs }
}

// ---------------------------------------------------------------------------
// Action implementations (pure logic with injectable seams; the default
// export wires them through `TUIContext`)
// ---------------------------------------------------------------------------

export interface RunDeps {
  /** Where to look. */
  cwd: string
  /** Our hostname; injectable for tests. */
  hostname: () => string
  /** Stale time threshold in ms. */
  staleAfterMs: number
  /** PID liveness probe; injectable for tests. */
  pidAlive?: (pid: number) => boolean
  /** Time provider; injectable for tests. */
  now?: () => number
}

export interface RunResult {
  content: string
  display: string
  is_error?: boolean
}

export function runList(input: ParsedInput, deps: RunDeps): RunResult {
  const root = input.path ?? deps.cwd
  if (!existsSync(root)) {
    return errorResult(`path does not exist: ${root}`)
  }
  const found = listLocksUnder(root)
  const annotated = found.map((l) =>
    annotate(l, deps.hostname(), deps.staleAfterMs, deps.pidAlive, deps.now),
  )
  if (input.format === "json") {
    return {
      content: JSON.stringify({ root, count: annotated.length, locks: annotated }, null, 2),
      display: renderListText(root, annotated),
    }
  }
  const text = renderListText(root, annotated)
  return { content: text, display: text }
}

export function runInspect(input: ParsedInput, deps: RunDeps): RunResult {
  const filePath = input.path
  if (!filePath) return errorResult("`path` required for inspect")
  const lockPath = lockPathFor(filePath)
  if (!existsSync(lockPath)) {
    const msg = `No lock at ${lockPath}`
    return { content: msg, display: msg }
  }
  const holder = readLockFile(lockPath)
  const ann = annotate(
    { lockPath, filePath, holder },
    deps.hostname(),
    deps.staleAfterMs,
    deps.pidAlive,
    deps.now,
  )
  if (input.format === "json") {
    return {
      content: JSON.stringify(ann, null, 2),
      display: renderInspectText(ann),
    }
  }
  const text = renderInspectText(ann)
  return { content: text, display: text }
}

export function runClearStale(input: ParsedInput, deps: RunDeps): RunResult {
  const root = input.path ?? deps.cwd
  if (!existsSync(root)) return errorResult(`path does not exist: ${root}`)
  const found = listLocksUnder(root)
  const annotated = found.map((l) =>
    annotate(l, deps.hostname(), deps.staleAfterMs, deps.pidAlive, deps.now),
  )
  const removed: AnnotatedLock[] = []
  const kept: AnnotatedLock[] = []
  for (const a of annotated) {
    if (a.status === "stale-pid" || a.status === "stale-time" || a.status === "corrupt") {
      try {
        unlinkSync(a.lockPath)
        removed.push(a)
      } catch {
        kept.push(a) // unlink failed — surface as still-there
      }
    } else {
      kept.push(a)
    }
  }
  if (input.format === "json") {
    return {
      content: JSON.stringify(
        { root, removed: removed.length, kept: kept.length, removedLocks: removed, keptLocks: kept },
        null,
        2,
      ),
      display: renderClearStaleText(root, removed, kept),
    }
  }
  const text = renderClearStaleText(root, removed, kept)
  return { content: text, display: text }
}

export function runClear(input: ParsedInput, deps: RunDeps): RunResult {
  const filePath = input.path
  if (!filePath) return errorResult("`path` required for clear")
  const lockPath = lockPathFor(filePath)
  if (!existsSync(lockPath)) {
    const msg = `No lock to clear at ${lockPath}`
    return { content: msg, display: msg }
  }
  const holder = readLockFile(lockPath)
  const ann = annotate(
    { lockPath, filePath, holder },
    deps.hostname(),
    deps.staleAfterMs,
    deps.pidAlive,
    deps.now,
  )
  try {
    unlinkSync(lockPath)
  } catch (e) {
    return errorResult(`unlink failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  // Loud diagnostic when we just smashed a "held" lock — model should see
  // this in the result so it can flag the action to the user.
  const verdict = ann.status === "held" ? "WARNING: holder appears alive" : "OK"
  if (input.format === "json") {
    return {
      content: JSON.stringify({ removed: true, verdict, ...ann }, null, 2),
      display: renderClearText(ann, verdict),
    }
  }
  const text = renderClearText(ann, verdict)
  return { content: text, display: text }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Minimal ANSI helpers — we don't pull in the full palette here, just a
// few tokens for the transcript. The handler runs without colors when
// piped (TTY detection is the agent's job).
const dim = (s: string): string => `\x1b[2m${s}\x1b[22m`
const bold = (s: string): string => `\x1b[1m${s}\x1b[22m`
const red = (s: string): string => `\x1b[31m${s}\x1b[39m`
const yellow = (s: string): string => `\x1b[33m${s}\x1b[39m`
const green = (s: string): string => `\x1b[32m${s}\x1b[39m`
const cyan = (s: string): string => `\x1b[36m${s}\x1b[39m`

function statusBadge(s: LockStatus): string {
  switch (s) {
    case "held":
      return red("● held")
    case "stale-pid":
      return yellow("○ stale (pid)")
    case "stale-time":
      return yellow("○ stale (time)")
    case "corrupt":
      return yellow("○ corrupt")
    case "cross-host":
      return cyan("◌ cross-host")
  }
  return green(s)
}

function formatAge(ms: number | null): string {
  if (ms === null) return "?"
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  if (s < 3600) return `${(s / 60).toFixed(1)}min`
  return `${(s / 3600).toFixed(1)}h`
}

function renderListText(root: string, locks: AnnotatedLock[]): string {
  if (locks.length === 0) return dim(`No locks under ${root}.`)
  const lines: string[] = []
  lines.push(bold(`Locks under ${root}: ${locks.length}`))
  for (const l of locks) {
    lines.push(formatLockLine(l))
  }
  return lines.join("\n")
}

function formatLockLine(l: AnnotatedLock): string {
  const age = formatAge(l.ageMs)
  if (!l.holder) {
    return `  ${statusBadge(l.status)}  ${l.filePath}  ${dim(`(${l.reason ?? "?"})`)}`
  }
  const owner = `${l.holder.harness}/${l.holder.tool} pid=${l.holder.pid} sid=${l.holder.sessionId.slice(0, 8)} host=${l.holder.host}`
  const trail = l.reason ? ` ${dim(`(${l.reason})`)}` : ""
  return `  ${statusBadge(l.status)}  ${l.filePath}  ${dim(`age=${age}`)}  ${dim(owner)}${trail}`
}

function renderInspectText(l: AnnotatedLock): string {
  const lines: string[] = []
  lines.push(bold(`Lock: ${l.filePath}`))
  lines.push(`  status:    ${statusBadge(l.status)}`)
  if (l.reason) lines.push(`  reason:    ${dim(l.reason)}`)
  lines.push(`  lockPath:  ${dim(l.lockPath)}`)
  if (l.holder) {
    lines.push(`  holder:`)
    lines.push(`    harness:    ${l.holder.harness}`)
    lines.push(`    sessionId:  ${l.holder.sessionId}`)
    lines.push(`    pid:        ${l.holder.pid}`)
    lines.push(`    host:       ${l.holder.host}`)
    lines.push(`    tool:       ${l.holder.tool}`)
    if (l.holder.callId) lines.push(`    callId:     ${l.holder.callId}`)
    lines.push(`    acquiredAt: ${l.holder.acquiredAt}`)
    if (l.ageMs !== null) lines.push(`    age:        ${formatAge(l.ageMs)}`)
  }
  return lines.join("\n")
}

function renderClearStaleText(
  root: string,
  removed: AnnotatedLock[],
  kept: AnnotatedLock[],
): string {
  const lines: string[] = []
  lines.push(bold(`clear-stale under ${root}`))
  lines.push(`  removed: ${removed.length}`)
  for (const r of removed) lines.push(`    ${green("✓")} ${r.filePath}  ${dim(r.reason ?? "")}`)
  lines.push(`  kept:    ${kept.length}`)
  for (const k of kept) lines.push(`    ${dim("·")} ${formatLockLine(k).trimStart()}`)
  return lines.join("\n")
}

function renderClearText(l: AnnotatedLock, verdict: string): string {
  const top =
    verdict === "OK"
      ? green(`✓ cleared lock on ${l.filePath}`)
      : red(`! cleared lock on ${l.filePath}`)
  const detail = l.reason ?? l.status
  const verdictLine = verdict === "OK" ? dim(`(${detail})`) : red(verdict)
  return [top, `  ${verdictLine}`].join("\n")
}

function errorResult(msg: string): RunResult {
  return {
    content: `LockStatus error: ${msg}`,
    display: red(`LockStatus error: ${msg}`),
    is_error: true,
  }
}

// ---------------------------------------------------------------------------
// Default export — adapter from TUIContext to runX functions
// ---------------------------------------------------------------------------

export default async function lockStatusHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return {
      kind: "tool_result",
      content: "LockStatus: unsupported trigger type (expected tool)",
      is_error: true,
    }
  }
  const v = validate(ctx.trigger.input)
  if (!v.ok || !v.value) {
    return {
      kind: "tool_result",
      content: `LockStatus error: ${v.error}`,
      is_error: true,
    }
  }
  const input = v.value
  const deps: RunDeps = {
    cwd: ctx.cwd,
    hostname: () => hostname(),
    staleAfterMs: resolveStaleAfterMs(ctx),
  }

  let r: RunResult
  switch (input.action) {
    case "list":
      r = runList(input, deps)
      break
    case "inspect":
      r = runInspect(input, deps)
      break
    case "clear-stale":
      r = runClearStale(input, deps)
      break
    case "clear":
      r = runClear(input, deps)
      break
    default: {
      // Exhaustiveness — should be unreachable given validate().
      const _never: never = input.action
      void _never
      return {
        kind: "tool_result",
        content: `LockStatus error: unknown action`,
        is_error: true,
      }
    }
  }
  return { kind: "tool_result", content: r.content, display: r.display, is_error: r.is_error }
}

/**
 * Resolve the stale threshold from the same config the auto-locker uses.
 * Read once per call (cheap; the config block is small) so the user can
 * tweak `staleAfterMs` between turns and `LockStatus` reflects it.
 *
 * The mismatch path — handler reads cwd/cwd/.minimal-agent/config.jsonc
 * but `tools.ts` reads $HOME/.minimal-agent/config.jsonc — is impossible
 * because both go through `configPath()` from `src/config.ts` which
 * reads `MINIMAL_AGENT_CONFIG` env first, then `os.homedir()`.
 */
function resolveStaleAfterMs(_ctx: TUIContext): number {
  // Lazy import: keeps the handler file's static dep set tight to
  // file-lock + types. The config helpers are tiny and synchronous.
  try {
    // Use a real require to keep this file ESM-compatible under bun-test.
    const cfg = require("../../../src/config.ts") as typeof import("../../../src/config.ts")
    const path = cfg.configPath()
    const fs = require("node:fs") as typeof import("node:fs")
    if (!fs.existsSync(path)) return DEFAULT_STALE_AFTER_MS
    const raw = fs.readFileSync(path, "utf-8")
    const jsonc = require("../../../src/jsonc.ts") as typeof import("../../../src/jsonc.ts")
    const parsed = jsonc.parseJsonc(raw) as Record<string, unknown> | null
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

// Re-export resolve helpers for tests / CLI reuse.
export { resolve as _resolvePath }
