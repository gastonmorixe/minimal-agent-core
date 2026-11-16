/**
 * Cooperative file-lock wiring for Edit/Write tool execution.
 *
 * Config is sourced from `~/.minimal-agent/config.jsonc` under
 * `plugins["file-lock"]` (same key the loader uses to activate the companion
 * plugin), with sane defaults when missing. The lock spans only the
 * read-modify-write body, typically under 100ms.
 *
 * @module tools/file-lock
 */

import { existsSync, readFileSync } from "node:fs"

import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { configPath as userConfigPath } from "../config/config.ts"
import { acquireLock, LockAbortedError, LockTimeoutError } from "../infra/file-lock.ts"
import { getSessionId } from "../session/session-id.ts"
import { parseJsonc } from "../utils/jsonc.ts"

import { abortedText, lockFailedText, lockTimeoutText } from "./tool-result-text.ts"

/** Minimal result shape returned by lock-wrapped tool runs. */
export interface FileLockToolResult {
  content: string
  is_error?: boolean
  _aborted?: boolean
}

/** Minimal opts needed to honor abort while acquiring a lock. */
export interface FileLockOpts {
  signal?: AbortSignal
  /** Synthetic text resolver for the lock and abort results. Default: no provider. */
  text?: SyntheticTextResolver
}

/**
 * Resolved file-lock configuration. Sourced from
 * `~/.minimal-agent/config.jsonc` under `plugins["file-lock"]` (single
 * source of truth : the same key the loader reads to decide whether to
 * activate the companion plugin), with sane defaults when missing.
 *
 * Read once and cached: Edit/Write is hot-path, and the config does not
 * change mid-session.
 */
interface FileLockConfig {
  enabled: boolean
  tools: ReadonlySet<string>
  timeoutMs: number
  staleAfterMs: number
}

let _fileLockConfig: FileLockConfig | null = null

const ABORTED_RESULT = (text: SyntheticTextResolver): FileLockToolResult => ({
  content: abortedText(text),
  is_error: true,
  _aborted: true,
})

function fileLockConfig(): FileLockConfig {
  if (_fileLockConfig !== null) return _fileLockConfig
  // Hard env opt-out for tests / debugging. Doesn't pollute the config file.
  if (process.env.MINIMAL_AGENT_FILE_LOCK_DISABLED === "1") {
    _fileLockConfig = {
      enabled: false,
      tools: new Set(["Edit", "Write"]),
      timeoutMs: 30_000,
      staleAfterMs: 300_000,
    }
    return _fileLockConfig
  }
  const defaults: FileLockConfig = {
    enabled: true,
    tools: new Set(["Edit", "Write"]),
    timeoutMs: 30_000,
    staleAfterMs: 300_000,
  }
  // Read raw JSONC directly. `loadUserConfig()` validates and returns
  // only its whitelisted keys (model, effort, etc.) : `plugins.<id>` is
  // not in that whitelist, so we must read the raw file ourselves. This
  // matches the pattern in `loadDisabledPluginIds` (src/config.ts).
  try {
    const path = userConfigPath()
    if (!existsSync(path)) {
      _fileLockConfig = defaults
      return _fileLockConfig
    }
    const raw = readFileSync(path, "utf-8")
    const parsed = parseJsonc(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      _fileLockConfig = defaults
      return _fileLockConfig
    }
    const plugins = (parsed as Record<string, unknown>).plugins as
      | Record<string, unknown>
      | undefined
    const block = plugins?.["file-lock"] as Record<string, unknown> | undefined
    if (!block) {
      _fileLockConfig = defaults
      return _fileLockConfig
    }
    const enabled = block.enabled === false ? false : defaults.enabled
    const tools =
      Array.isArray(block.tools) && block.tools.every((t) => typeof t === "string")
        ? new Set(block.tools as string[])
        : defaults.tools
    const timeoutMs =
      typeof block.timeoutMs === "number" && block.timeoutMs > 0
        ? block.timeoutMs
        : defaults.timeoutMs
    const staleAfterMs =
      typeof block.staleAfterMs === "number" && block.staleAfterMs > 0
        ? block.staleAfterMs
        : defaults.staleAfterMs
    _fileLockConfig = { enabled, tools, timeoutMs, staleAfterMs }
    return _fileLockConfig
  } catch {
    _fileLockConfig = defaults
    return _fileLockConfig
  }
}

/** Test seam: drop the cached config so the next call re-reads the file/env. */
export function _resetFileLockConfigForTests(): void {
  _fileLockConfig = null
}

/**
 * Wrap a mutation tool's execution in a cooperative file lock.
 *
 * The lock spans only the body of `run()` : held for as long as the
 * read-modify-write takes, typically under 100ms. On lock failure, returns a
 * `tool_result` with `is_error: true` and a holder-rich diagnostic so the
 * model can decide to wait, inspect via `LockStatus`, or proceed elsewhere.
 *
 * Disabled gracefully when `plugins["file-lock"].enabled === false` or
 * `MINIMAL_AGENT_FILE_LOCK_DISABLED=1` is set in the environment : `run()`
 * is invoked directly with no lock.
 *
 * @param tool - Tool name used for lock metadata and error messages.
 * @param input - Raw tool input (must include `file_path` to lock).
 * @param opts - Per-call options (abort signal).
 * @param run - Mutation body to run while the lock is held.
 * @returns Result of `run`, or a lock/abort error result.
 */
export async function withFileLock<TResult extends FileLockToolResult = FileLockToolResult>(
  tool: string,
  input: Record<string, unknown>,
  opts: FileLockOpts,
  run: () => Promise<TResult>,
): Promise<TResult | FileLockToolResult> {
  const cfg = fileLockConfig()
  if (!cfg.enabled || !cfg.tools.has(tool)) return run()
  const filePath = input.file_path
  if (typeof filePath !== "string" || filePath.length === 0) {
    // Let the executor return its own validation error : we've nothing to lock.
    return run()
  }
  try {
    using _handle = await acquireLock(
      filePath,
      { sessionId: getSessionId(), tool },
      {
        timeoutMs: cfg.timeoutMs,
        staleAfterMs: cfg.staleAfterMs,
        signal: opts.signal,
      },
    )
    return await run()
  } catch (e) {
    const text = opts.text ?? EMPTY_SYNTHETIC_TEXT
    if (e instanceof LockTimeoutError) {
      const detail = e.message
      return { content: lockTimeoutText(text, tool, detail), is_error: true }
    }
    if (e instanceof LockAbortedError) {
      return ABORTED_RESULT(text)
    }
    // Any other thrown error from acquire (filesystem-level) : surface as
    // a tool error rather than letting it crash the dispatch loop.
    const detail = e instanceof Error ? e.message : String(e)
    return { content: lockFailedText(text, tool, detail), is_error: true }
  }
}
