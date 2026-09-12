/**
 * Host-side slash-command dispatch + result application for the live REPL.
 *
 * Extracted from `src/host/repl-live-area.ts` to keep that file under its
 * `max-lines` budget. Behavior is unchanged: the `/compact` live sink is
 * forwarded only for the compact command, an unknown-but-parsed line falls
 * back to the prompt queue, and every result kind renders through the same
 * notice path.
 *
 * @module host/commands/dispatch-submit
 */

import { parseCommandLine } from "../../cli/slash-command-parse.ts"
import type { CommandDispatchOptions } from "../../plugins/loader/commands.ts"
import type { CommandResult } from "../../plugins/types.ts"
import { renderCommandNoticeBlock } from "../ui/command-notice.ts"

import {
  type CompactStreamDeps,
  createCompactStream,
  endQuietly,
  renderCompactNotice,
} from "./compact-submit.ts"

/** Structural view of the command registry the submit path needs. */
export interface DispatchSubmitHost {
  /** Dispatch a `/name` line; `null` means "not a registered command". */
  dispatchCommand(line: string, opts?: CommandDispatchOptions): Promise<CommandResult | null>
  /** Event bus used to announce an expanded `history-edit` prompt. */
  bus(): { emit(event: string, payload: { prompt: string }): void }
}

/** Collaborators the submit path needs from the live-area closure. */
export interface DispatchSubmitDeps {
  /** Command registry, or `null` when plugins are disabled. */
  loader: DispatchSubmitHost | null
  /** Writes fully rendered lines to scrollback. */
  writeNoticeLines: (lines: string[]) => void
  /** Live terminal width, read at call time. */
  liveCols: () => number | undefined
  /** Queues a prompt for the next model turn. */
  enqueuePrompt: (text: string, commitLines: string[], submittedAt?: Date) => void
  /** Echoes the submitted command line into scrollback with its timestamp. */
  flushCommandLine: (text: string, commitLines: string[], submittedAt: Date) => void
  /** Formatter geometry + raw sink for `/compact` live output. */
  compactStream: CompactStreamDeps
}

/**
 * Dispatch one submitted slash-command line and apply its result.
 *
 * @param deps - Registry, scrollback, queue, and compact-stream collaborators.
 * @param text - Raw submitted line.
 * @param commitLines - Lines to echo for the submission (may be empty).
 * @param submittedAt - Submission time; defaults to now.
 */
export async function dispatchCommandAndApply(
  deps: DispatchSubmitDeps,
  text: string,
  commitLines: string[] = [],
  submittedAt?: Date,
): Promise<void> {
  const loader = deps.loader
  if (!loader) return
  const submittedAtDate = submittedAt ?? new Date()
  deps.flushCommandLine(text, commitLines, submittedAtDate)
  let result: CommandResult | null
  const isCompactCmd = parseCommandLine(text)?.name === "compact"
  const compactStream = isCompactCmd ? createCompactStream(deps.compactStream) : null
  try {
    result = await loader.dispatchCommand(text, {
      cwd: process.cwd(),
      ...(compactStream
        ? { writeStream: compactStream.write, onSummaryAttempt: compactStream.onAttempt }
        : {}),
    })
  } catch (e) {
    deps.writeNoticeLines([`✗ command failed: ${e instanceof Error ? e.message : String(e)}`])
    return
  } finally {
    await endQuietly(compactStream)
  }
  if (!result) {
    deps.enqueuePrompt(text, commitLines, submittedAt)
    return
  }
  await applyCommandResult(deps, loader, text, result)
}

/**
 * Render one command result into scrollback.
 *
 * @param deps - Scrollback + compact-render collaborators.
 * @param loader - Registry, for the `history-edit` expand announcement.
 * @param text - Raw submitted line (selects the compact renderer).
 * @param result - Result returned by the command handler.
 */
async function applyCommandResult(
  deps: DispatchSubmitDeps,
  loader: DispatchSubmitHost,
  text: string,
  result: CommandResult,
): Promise<void> {
  switch (result.kind) {
    case "expand":
      // The typed `/cmd` line is already in scrollback; the expanded
      // prompt drives the turn with no extra commit lines.
      deps.enqueuePrompt(result.prompt, [])
      if (parseCommandLine(text)?.name === "history-edit") {
        loader.bus().emit("history.edit.expanded", { prompt: result.prompt })
      }
      return
    case "notice": {
      const block = result.block
      const rendered =
        block && parseCommandLine(text)?.name === "compact"
          ? await renderCompactNotice(block, deps.compactStream)
          : block
            ? renderCommandNoticeBlock(block, deps.liveCols())
            : []
      deps.writeNoticeLines([...rendered, ...(result.lines ?? [])])
      return
    }
    case "error":
      deps.writeNoticeLines([`✗ ${result.message}`])
      return
    case "none":
      return
    default: {
      throw new Error(`unhandled command result: ${JSON.stringify(result satisfies never)}`)
    }
  }
}
