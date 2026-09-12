/**
 * Host-side `/compact` submit wiring: the registry-less fallback path and the
 * framed-markdown notice rendering shared by both compact entry points.
 *
 * Extracted from `src/host/repl-live-area.ts` to keep that file under its
 * `max-lines` budget. Behavior is unchanged: the registry path forwards the
 * live sink into `dispatchCommand`, the fallback path calls `agent.compact`
 * directly, and both render the committed checkpoint through Formatter before
 * the notice frame.
 *
 * @module host/commands/compact-submit
 */

import {
  type CompactRequestOpts,
  type CompactStats,
  DEFAULT_KEEP_TAIL,
  parseCompactArgs,
} from "../../agent/context-compact.ts"
import type { CommandNoticeBlock } from "../../plugins/types.ts"
import { renderCommandNoticeBlock } from "../ui/command-notice.ts"

import { buildCompactNoticeBlock } from "./compact.ts"
import {
  type CompactStreamSink,
  createCompactStreamSink,
  formatMarkdownLines,
} from "./compact-stream.ts"

/** Geometry + sinks the live Markdown stream needs from the compositor. */
export interface CompactStreamDeps {
  /** Raw byte sink for the live area. Absent when no TUI is attached. */
  writeStream?: (chunk: string) => void
  /** Markdown formatter command (`mdstream`). Absent means no live render. */
  formatterCmd?: string[]
  /** Live terminal width, read at call time. */
  columns?: () => number | undefined
  /** Terminal rows for the formatter geometry. */
  rows?: number
}

/**
 * Build the live sink for one `/compact` invocation.
 *
 * @param deps - Compositor sinks + terminal geometry.
 * @returns The sink, or `null` when the host has no `writeStream`.
 */
export function createCompactStream(deps: CompactStreamDeps): CompactStreamSink | null {
  return createCompactStreamSink({
    writeStream: deps.writeStream,
    formatterCmd: deps.formatterCmd,
    columns: deps.columns?.(),
    rows: deps.rows,
  })
}

/**
 * Render a compact notice block with its body passed through Formatter, then
 * the notice frame. Falls back to the raw body when no formatter is set or
 * the formatter produced nothing.
 *
 * @param block - Notice block whose `body` is checkpoint Markdown.
 * @param deps - Formatter command + geometry.
 * @returns Fully framed notice lines ready for scrollback.
 */
export async function renderCompactNotice(
  block: CommandNoticeBlock,
  deps: CompactStreamDeps,
): Promise<string[]> {
  if (!deps.formatterCmd) return renderCommandNoticeBlock(block, deps.columns?.())
  const md = block.body?.join("\n") ?? ""
  const formatted = await formatMarkdownLines(md, deps.formatterCmd, {
    columns: deps.columns?.(),
    rows: deps.rows,
  })
  const framed = formatted ? { ...block, body: formatted } : block
  return renderCommandNoticeBlock(framed, deps.columns?.())
}

/** Collaborators the registry-less `/compact` fallback needs. */
export interface CompactFallbackDeps extends CompactStreamDeps {
  /** Compact entry point on the live agent. */
  compact: (opts?: CompactRequestOpts) => Promise<CompactStats>
  /** Writes fully rendered lines to scrollback. */
  writeNoticeLines: (lines: string[]) => void
}

/**
 * Run `/compact` when no host command is registered (plugins disabled).
 * Fire-and-forget: the caller's submit event must not block.
 *
 * @param argv - Raw argv text after the command name.
 * @param deps - Agent compact entry point plus scrollback/stream sinks.
 */
export function startCompactFallback(argv: string, deps: CompactFallbackDeps): void {
  const parsedArgs = parseCompactArgs(argv)
  if (parsedArgs.error) {
    deps.writeNoticeLines([`✗ ${parsedArgs.error}`])
    return
  }
  const mode = parsedArgs.mode ?? "local"
  const keepTail = parsedArgs.keepTail ?? DEFAULT_KEEP_TAIL
  const focus = parsedArgs.focus?.trim() ? parsedArgs.focus : undefined
  const stream = createCompactStream(deps)
  void (async () => {
    try {
      deps.writeNoticeLines(["Compacting context…"])
      const stats = await deps.compact({
        reason: "manual",
        mode,
        keepTail,
        ...(focus ? { focus } : {}),
        ...(stream ? { writeStream: stream.write, onSummaryAttempt: stream.onAttempt } : {}),
      })
      await endQuietly(stream)
      deps.writeNoticeLines(
        await renderCompactNotice(buildCompactNoticeBlock(stats, { mode, keepTail, focus }), deps),
      )
    } catch (e) {
      await endQuietly(stream)
      deps.writeNoticeLines([`✗ compact failed: ${e instanceof Error ? e.message : String(e)}`])
    }
  })()
}

/**
 * Close a stream sink without letting formatter teardown mask the result.
 *
 * @param stream - Sink to end, or `null`.
 */
export async function endQuietly(stream: CompactStreamSink | null): Promise<void> {
  try {
    await stream?.end()
  } catch {
    // Formatter teardown must not hide the compact result.
  }
}
