/**
 * Top-level REPL types and the `runRepl` entry point.
 *
 * `runRepl` is the orchestration shell: it wires up auth, session
 * restore, status surfaces, the live-area renderer, and the model
 * picker into a single interactive loop driven by a `RawInput`
 * stream. The heavy lifting of the live-area composition lives in
 * the sibling `./repl-live-area.ts` module.
 *
 * Split out of `src/agent.ts` to keep that file under the
 * `max-lines` lint budget. The public surface (`ReplAgentLike`,
 * `StatusController`, `runRepl`) is re-exported from `agent.ts` for
 * back-compat with existing consumers.
 *
 * @module agent/repl
 */

import type { TurnNotice } from "../agent/turn-notice.ts"
import type { AuthResult } from "../auth/auth.ts"
import { isErrorDiagEmitted } from "../bus/diagnostic-bus.ts"
import { GLOBAL_STATUS_BUS, StatusBus } from "../bus/status.ts"
import { RawInput } from "../input/input.ts"
import { listLiveModelsForPicker } from "../llm/list-models.ts"
import type { ModelInfo, StreamedResponse } from "../llm/transport/types.ts"
import { ModeManager } from "../modes/modes.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { PluginStream } from "../plugins/stream.ts"
import type { ManifestMode } from "../plugins/types.ts"

import type { QueueKeyHandler } from "./editor/types.ts"
import {
  contextLengthExceededAdvice,
  parseContextLengthExceededError,
  parseModelNotFoundError,
  parseModelUnavailableError,
} from "./model-error.ts"
import { runReplLiveArea } from "./repl-live-area.ts"
import { Formatter } from "./ui/formatter/formatter.ts"
import { promptModelPicker } from "./ui/model-picker.ts"
import type { Spinner } from "./ui/spinner/index.ts"
import { StatusRenderer, type StatusSpinnerTheme } from "./ui/status/line-renderer.ts"
import { c, faintThinkingChunk } from "./ui/style/ansi.ts"
import { renderTurnNotice } from "./ui/turn-notice.ts"

type MaybePromise<T> = T | Promise<T>

export interface ReplAgentLike {
  pluginLoader(): PluginLoader | null
  /** Optional: mode manager for prompt/status/cycling integration. */
  modes?(): ModeManager | null
  /** Optional: convenience for the active mode (if any). */
  getActiveMode?(): ManifestMode | null
  run(
    userText: string,
    opts?: {
      onTranscriptLine?: (line: string) => void
      onThinkingStart?: () => MaybePromise<void>
      onThinkingChunk?: (chunk: string) => MaybePromise<void>
      onThinkingStop?: () => MaybePromise<void>
      onTextStop?: () => MaybePromise<void>
      /**
       * Optional. Fires for out-of-band conditions (refusal / content
       * filter, output-budget events, tool-rounds cap, reflection acks)
       * with the semantic {@link TurnNotice}. The REPLs render each kind
       * via `renderTurnNotice`; when a host omits the hook the agent core
       * falls back to a style-free `onTranscriptLine` one-liner.
       */
      onNotice?: (notice: TurnNotice) => MaybePromise<void>
      drainQueuedUserText?: () => string | null
      onQueueInject?: (text: string) => void
      /**
       * Optional cancellation signal. The live-area REPL forwards
       * {@link AbortBus.beginTurn}'s controller signal here so a user-press
       * Esc / Ctrl+C tears down the SDK stream and any in-flight tool
       * (Bash child gets SIGTERM → SIGKILL escalation).
       */
      signal?: AbortSignal
      /**
       * Optional host-provided callback the agent invokes when the
       * provider's preflight surfaces an issue that needs user
       * resolution (e.g. Anthropic detected thinking-block signatures
       * from a different model). The host opens a modal in the live
       * area and resolves with the chosen option id (`null` to cancel).
       *
       * Live-area REPL wires this when both a `setFooterLayer`-capable
       * editor and a plugin loader (Hooks bus) are present; headless
       * setups leave it undefined and skip preflight entirely.
       */
      askUser?: (issue: import("../llm/provider.ts").PreflightIssue) => Promise<string | null>
    },
  ): AsyncGenerator<string, StreamedResponse, undefined>
  /** Optional: current model id (for diagnostics/recovery prompts). */
  getModel?(): string
  /** Optional: switch model in place after a failure. */
  setModel?(model: string): void
  /** Optional: discard trailing user turn after a failed send. */
  rollbackPendingTurn?(): boolean
  /**
   * Optional: record that the just-settled turn was aborted by the USER
   * (Esc / Ctrl+C), so the agent's NEXT run() emits a model-visible
   * `<ma::agent::turn-aborted />` marker. Not called for programmatic
   * mode-interrupt aborts (Alt+M).
   */
  notePreviousTurnAborted?(): void
  /**
   * Optional: append a free-form `note` record to the session JSONL. Used by
   * the host's `notification.emit` listener to persist a user-facing toast
   * (e.g. an intercom arrival) so it survives resume. Note records are
   * metadata: they are NOT folded into the model's message history on replay.
   * No-op when the agent has no session store (ad-hoc runs, tests).
   */
  appendNote?(text: string): void
}

export type ReplOutput = Pick<NodeJS.WriteStream, "write"> & {
  isTTY?: boolean
  columns?: number
  rows?: number
}

export type ReplErrOutput = Pick<NodeJS.WriteStream, "write">

/**
 * Minimal subset of StatusRenderer that runRepl interacts with. Extracted
 * so tests can swap in a spy without building a full renderer.
 */
export interface StatusController {
  start(): void
  stop(): void
  suspend(): void
  resume(): void
}

export type ReplInput = Pick<RawInput, "read">

/**
 * Subset of {@link Compositor} that {@link runRepl} needs in live-area mode.
 * Decoupled so tests can supply a fake without escape-sequence assertions.
 */
export interface ReplCompositor {
  mount(initialLiveHeight: number): void
  unmount(): void
  writeStream(chunk: string): void
  flushStream?(): void
  withSuspendedLiveArea<T>(fn: () => T | Promise<T>): Promise<T>
}

/**
 * Subset of {@link EditorController} that {@link runRepl} needs in
 * live-area mode. The controller emits `submit` (with text) and `cancel`.
 */
export interface ReplEditor {
  start(): void
  stop(): void
  /**
   * Submit event. The optional `commitLines` argument carries the
   * pre-rendered scrollback lines for the just-submitted prompt :
   * the host writes them to scrollback at TURN START (or tool-boundary
   * drain time for queued items), NOT at submit time, so a prompt that
   * sits queued does not appear in both scrollback and the queue widget
   * (Bug 393). Listeners that only care about `text` can ignore it.
   */
  on(
    event: "submit",
    listener: (text: string, commitLines?: string[], submittedAt?: Date) => void,
  ): unknown
  on(event: "cancel", listener: (reason?: string) => void): unknown
  /**
   * Emitted by the abort-quit FSM when the user has confirmed a quit
   * (second Ctrl+C inside the 10s armed window OR the escape-hatch
   * "rapid double Ctrl+C"). Reason indicates which path fired. The
   * legacy `"cancel"` event is also emitted for back-compat (with the
   * same reason argument).
   */
  on(event: "quit", listener: (reason: "confirmed" | "escape-hatch") => void): unknown
  off?(event: "submit" | "cancel" | "quit", listener: (...args: unknown[]) => void): unknown
  /** Called by the live-area status controller to push the spinner row. */
  setStatus?(text: string | null): void
  /** Called after terminal resize so live-area rows can reflow immediately. */
  notifyResize?(): void
  /**
   * Optional. Wire Shift+Tab / Ctrl+Shift+Tab to mode cycling. Live-area
   * REPL calls this when the agent has any modes loaded. Editors without
   * mode support can omit it.
   */
  setModeCycleHandlers?(forward: (() => void) | null, backward: (() => void) | null): void
  /**
   * Optional. Wire Alt+M (interrupt-and-apply-mode). When the user
   * toggles modes mid-turn and doesn't want to wait for the ASAP
   * delivery boundary (next tool round / stream end), they press
   * Alt+M and the handler:
   *
   *   1. Enqueues a synthetic zero-text item so the next loop
   *      iteration runs as a mode-only continuation turn (`agent.run("")`
   *      drains it and ships the pending `<ma::agent::mode-change>` attachment).
   *   2. Aborts the in-flight request via the abort bus.
   *
   * Orphan-tool_use cleanup is NOT handled here. If the assistant
   * had already streamed a `tool_use` block when the abort fired,
   * the orphan is repaired on the next `agent.run()` call by
   * {@link Agent.repairOrphanedToolUse} (prepended synthetic
   * "aborted by user" `tool_result` blocks). One repair site,
   * applied uniformly to every abort path : Esc, Ctrl+C, Alt+M.
   *
   * Pass `null` to detach. Editors without this binding ignore Alt+M
   * silently (no literal `m` is inserted).
   */
  setModeInterruptHandler?(handler: (() => void) | null): void
  /**
   * Optional. Wire the submit-queue navigation hook. The live-area REPL
   * passes a handler that owns the dequeue / remove / dequeue-all
   * overlay driven from the prompt:
   *
   *   - `↑` at an empty prompt dequeues the sole queued item back to the
   *     input, or (with more than one queued) opens a selection overlay.
   *   - In the overlay: `↑`/`↓` move the selection, `d`/`Enter` dequeue
   *     the selected item to the input, `x` removes it, `k` dequeues all
   *     (numbered), `Esc` closes the overlay.
   *
   * The handler returns `{handled, buffer?}`; the editor applies
   * `buffer` via `setBuffer` and skips its default key handling when
   * `handled`. Pass `null` to detach. Editors without this binding (the
   * legacy REPL, test fakes) simply never offer queue navigation.
   */
  setQueueKeyHandler?(handler: QueueKeyHandler | null): void
  /**
   * Optional. Wire a fresh-prompt builder for `submit`'s commit-render
   * call. Closes the prompt-prefix race where a mode toggle
   * immediately before Enter could leave the cached prefix one
   * repaint behind. When unset, the editor uses its cached prompt.
   */
  setCommitPromptBuilder?(builder: (() => string) | null): void
  /**
   * Optional. Update the editor's prompt prefix (e.g. when the active mode
   * changes). Repaint should happen synchronously inside the call.
   */
  setPrompt?(prompt: string, continuationPrompt?: string): void
  /**
   * Optional. Render decoration rows between the status row and the editor
   * prompt : used by the REPL to display the queued-message buffer (lines
   * the user submitted while the agent was streaming, awaiting injection
   * at the next safe boundary). Pass `[]` to clear.
   */
  setDecorationLines?(lines: string[]): void
  /**
   * Optional. Render footer rows BELOW the editor input in the live area.
   * Used by plugin-contributed live-area slots (see `liveAreaSlots` in
   * the manifest schema) to surface ambient status : quota %, git
   * branch state, background-job progress : without competing with
   * what the user is typing. Pass `[]` to clear.
   *
   * Editors without footer support can omit this; the live-area
   * scheduler in `runReplLiveArea` no-ops when it's missing.
   */
  setFooterLines?(lines: string[]): void
  /**
   * Optional. Restore the editor buffer to a given text. Used by the abort
   * flow (`runReplLiveArea` → `handleAbort`) so that when the user cancels
   * an in-flight turn, the prompt they just sent is put back into the editor
   * for tweaking and resubmission. Cursor lands at the end of the inserted
   * text.
   */
  setBuffer?(text: string): void
  /**
   * Optional. Take MODAL ownership of the input line for an interactive
   * command overlay (/config, /usage). While owned, the editor hides the
   * prompt row + cursor, blocks `submit()`, and routes every key (including
   * printables + Backspace) through the `editor.key` hook so the overlay
   * drives its own draft instead of the shared prompt buffer. Host wiring
   * for the `editor.overlay.open` bus channel. `owner` is a stable id (the
   * opening plugin's id); a different owner replaces the current one.
   */
  openOverlay?(owner: string): void
  /**
   * Optional. Release modal ownership held by `owner` (host wiring for
   * `editor.overlay.close`). Owner-checked + idempotent: a close from a
   * non-owner is ignored. Restores the prompt + cursor.
   */
  closeOverlay?(owner: string): void
  /**
   * Optional. Notify the editor's abort-quit FSM that a turn has started.
   * The FSM transitions idle/armed → working and dismisses any armed
   * footer. No-op when the editor doesn't implement quit-confirm.
   */
  notifyTurnStart?(): void
  /**
   * Optional. Notify the editor that a turn has settled (success, error,
   * or aborted). Transitions working → idle (or stays armed if a Ctrl+C
   * abort had already pushed us into armed:post-abort).
   */
  notifyTurnEnd?(): void
}

/**
 * Run an interactive read-eval-print loop with full tool execution.
 *
 * Reads lines from stdin, sends each non-empty line to the agent via
 * {@link Agent.run}, and prints streamed text chunks to stdout. Tool
 * calls and outputs are logged to stderr. Exit with Ctrl+C.
 *
 * **Formatter integration**: if `opts.formatterCmd` is provided, each user
 * turn pipes the streamed text through that external process (see
 * {@link Formatter}). A fresh formatter is spawned per turn so the
 * markdown rendering state resets between user messages : this avoids
 * the formatter getting confused by stale state from previous turns.
 *
 * The `opts` bag's most common field is `formatterCmd`, an optional
 * formatter argv (e.g. `["mdstream"]`); the rest are dependency-injection
 * seams (input/output streams, editor, compositor, spinner, status bus).
 *
 * @param agent - Initialized agent instance
 *
 * @example
 * ```ts
 * await runRepl(agent);
 * await runRepl(agent, { formatterCmd: ["mdstream"] });
 * await runRepl(agent, { formatterCmd: ["bat", "--language=md", "--paging=never"] });
 * ```
 */
export async function runRepl(
  agent: ReplAgentLike,
  opts?: {
    formatterCmd?: string[]
    input?: ReplInput
    output?: ReplOutput
    errOutput?: ReplErrOutput
    statusBus?: StatusBus
    statusRenderer?: StatusController | null
    /**
     * Optional spinner instance used by the default StatusRenderer /
     * LiveAreaStatusController. Ignored when `statusRenderer` is also
     * provided. Comes from `--spinner <preset>` at the CLI layer.
     */
    spinner?: Spinner<StatusSpinnerTheme>
    /**
     * Auth used to fetch the available model list when a "model not found"
     * error happens. When omitted, the picker is skipped and we just print
     * the error and continue.
     */
    auth?: AuthResult
    /** Override for testing: defaults to the provider plugins' live catalogs. */
    listModels?: (auth: AuthResult) => Promise<ModelInfo[]>
    /**
     * Enable the persistent live-area UI: the multiline input is pinned to
     * the bottom of the terminal and stays visible while the agent works.
     * Requires `compositor` and `editor` (or sensible defaults wired by the
     * caller). When false (the legacy default), `runRepl` reads turns one
     * at a time via {@link RawInput} and writes streamed output straight to
     * stdout : same as before.
     */
    useLiveArea?: boolean
    compositor?: ReplCompositor
    editor?: ReplEditor
    /** Forwarded to {@link runReplLiveArea}; see its docs. */
    initialStdinBytes?: string
    /**
     * Forwarded to {@link runReplLiveArea} for the goodbye banner. When
     * provided, a quit (confirmed Ctrl+C×2 or escape-hatch) prints the
     * resume hint with this id. Omit / empty → degraded copy.
     */
    sessionId?: string
    /** Forwarded to live-area scrollback rendering. */
    scrollbackSubmittedAt?: false | "off" | "inline-locale"
  },
): Promise<void> {
  if (opts?.useLiveArea) {
    return runReplLiveArea(agent, opts)
  }
  const output = opts?.output ?? process.stdout
  const errOutput = opts?.errOutput ?? process.stderr
  const statusBus = opts?.statusBus ?? GLOBAL_STATUS_BUS
  const continuationPrompt = process.env.MINIMAL_AGENT_CONTINUATION_PROMPT ?? ""
  const baseArrow = `${c.bold(c.pink("❯"))} `
  const modeManager = agent.modes?.() ?? null
  const buildPrompt = (): string => (modeManager ? modeManager.promptPrefix(baseArrow) : baseArrow)
  // ❯
  const input = opts?.input ?? new RawInput(buildPrompt(), continuationPrompt)
  const statusRenderer: StatusController | null =
    opts && "statusRenderer" in opts
      ? (opts.statusRenderer ?? null)
      : output.isTTY === false
        ? null
        : new StatusRenderer(statusBus, output, { spinner: opts?.spinner })

  statusRenderer?.start()

  // Wire mode cycling: Shift+Tab cycles forward, Ctrl+Shift+Tab cycles back.
  //
  // The cycle handler runs in two contexts:
  //
  // 1. While the user is at the prompt (input is in "reading" mode): the
  //    apply() return value triggers a re-render so the new prompt prefix
  //    appears immediately.
  // 2. While a turn is streaming (input is in "ambient" mode): the prompt
  //    isn't drawn yet, so we just update the stored prompt string. The
  //    next call to `read()` will draw it.
  //
  // To deliver case 2 we put RawInput in ambient mode for the entire REPL
  // via enable() below. enable() takes persistent stdin ownership.
  if (modeManager && modeManager.hasModes() && input instanceof RawInput) {
    const onChange = () => {
      input.setPrompt(buildPrompt(), continuationPrompt)
      // If we're at the prompt, repaint so the new label appears live.
      input.redraw()
    }
    modeManager.subscribe(onChange)
    // No eager scrollback chip in the legacy REPL: a chip per toggle
    // would commit intermediate transitions the model never saw (ASK →
    // default → ASK with no send between would leave three stale chips
    // in scrollback). The prompt-prefix repaint above is the live cue;
    // session-replay reconstructs chips from `<mode-change>` blocks in
    // the message log on resume, so the historical record is intact.
    input.setModeCycleHandlers(
      () => modeManager.cycleNext(),
      () => modeManager.cyclePrev(),
    )
  }
  if (input instanceof RawInput) input.enable()

  // Ready banner is now written from `src/index.ts` BEFORE any resume
  // replay (see `buildReadyBanner` in `../ui/chrome/ready-banner.ts`). This REPL
  // entry point no longer emits it : keeps the banner at the top of
  // scrollback for both fresh starts and `--resume` sessions instead of
  // landing below the replayed content.

  const loader = agent.pluginLoader()

  try {
    while (true) {
      const text = await input.read()
      if (text === null) break

      if (!text.trim()) continue

      // Main response formatter : see `runReplLiveArea` for the full
      // rationale on per-text-block lifecycle (mdstream's `partial`
      // paragraph buffer would otherwise concatenate two unrelated
      // text blocks within one `run()` and smash them together at
      // end-of-turn). Lifted into a factory so `onTextStop` (below)
      // can end+respawn at every text-block seam.
      let formatter: Formatter | null = null
      const spawnMainFormatter = (): Formatter | null => {
        if (!opts?.formatterCmd) return null
        const f = new Formatter(opts.formatterCmd, output)
        f.start()
        return f
      }
      formatter = spawnMainFormatter()

      let wroteOutput = false
      let lastChunkEndedWithNewline = false
      const statusText = modeManager ? modeManager.statusLabel("Thinking") : "Thinking"
      const turnStatus = statusBus.create(statusText, {
        notificationId: "agent.thinking",
        category: "agent",
      })

      // See live-area REPL for the rationale: track text↔transcript
      // boundaries so we always render exactly one blank line between
      // streamed markdown and tool transcript blocks.
      let lastKind: "none" | "text" | "transcript" = "none"

      const writeDirectSink = (s: string) => {
        if (s.length === 0) return
        // Ensure visual separator between status/prompt and response text.
        if (!wroteOutput) {
          statusRenderer?.suspend()
          output.write("\n")
        }
        if (lastKind === "transcript") {
          statusRenderer?.suspend()
          // Use errOutput so the blank line lands in the same stream as the
          // transcript that preceded it (legacy mode splits stdout/stderr).
          errOutput.write("\n")
        }
        wroteOutput = true
        lastChunkEndedWithNewline = s.endsWith("\n")
        lastKind = "text"
        statusRenderer?.suspend()
        output.write(s)
      }

      const baseSink = (s: string) => {
        if (s.length === 0) return
        // Ensure visual separator between status/prompt and response text.
        if (!wroteOutput) {
          statusRenderer?.suspend()
          output.write("\n")
        }
        if (lastKind === "transcript") {
          statusRenderer?.suspend()
          // Use errOutput so the blank line lands in the same stream as the
          // transcript that preceded it (legacy mode splits stdout/stderr).
          errOutput.write("\n")
        }
        wroteOutput = true
        lastChunkEndedWithNewline = s.endsWith("\n")
        lastKind = "text"
        statusRenderer?.suspend()
        if (formatter) formatter.write(s)
        else output.write(s)
      }
      const pluginStream = loader ? new PluginStream(baseSink, loader, process.cwd()) : null
      let thinkingFormatter: Formatter | null = null
      const thinkingOutput = {
        get columns() {
          return output.columns
        },
        get rows() {
          return output.rows
        },
        write: ((chunk: string | Uint8Array) => {
          const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
          writeDirectSink(faintThinkingChunk(s))
          return true
        }) as NodeJS.WriteStream["write"],
      }
      const ensureThinkingFormatter = (): Formatter | null => {
        if (!opts?.formatterCmd) return null
        if (!thinkingFormatter) {
          thinkingFormatter = new Formatter(opts.formatterCmd, thinkingOutput)
          thinkingFormatter.start()
        }
        return thinkingFormatter
      }
      const endThinkingFormatter = async (): Promise<void> => {
        if (!thinkingFormatter) return
        const active = thinkingFormatter
        thinkingFormatter = null
        await active.end()
      }

      const onTranscriptLine = (line: string): void => {
        // Coordinate stderr transcript with the stdout spinner: clear the
        // spinner line before the write so nothing races the stream, then
        // resume so the next tool/round keeps its spinner.
        statusRenderer?.suspend()
        if (lastKind === "text" && !lastChunkEndedWithNewline) {
          // Close partial text line before transcript begins. The agent's
          // tool header (`\n  ┌ ...`) then yields a blank separator.
          output.write("\n")
          lastChunkEndedWithNewline = true
        }
        errOutput.write(`${line}\n`)
        lastKind = "transcript"
        statusRenderer?.resume()
      }
      const onThinkingStart = (): void => {
        ensureThinkingFormatter()
      }
      const onThinkingChunk = (chunk: string): void => {
        const active = ensureThinkingFormatter()
        if (active) active.write(chunk)
        else writeDirectSink(faintThinkingChunk(chunk))
      }
      const onThinkingStop = async (): Promise<void> => {
        await endThinkingFormatter()
        // Guarantee exactly one blank line between the reasoning block and the
        // response text. Reasoning streams through `writeDirectSink` (lastKind
        // = "text"), so the text↔transcript separator never fires for the
        // following response. A lone "\n" only closes the reasoning line when
        // it didn't already end in one, leaving zero blank rows. Emit the
        // second newline in that case so the separation is always present.
        writeDirectSink(lastChunkEndedWithNewline ? "\n" : "\n\n")
      }
      // Per-text-block formatter boundary. See `runReplLiveArea` for the
      // full rationale; this is the legacy `runRepl` (non-live-area) twin.
      const onTextStop = async (): Promise<void> => {
        if (!formatter && !opts?.formatterCmd) return
        const old = formatter
        formatter = null
        if (old) await old.end()
        formatter = spawnMainFormatter()
      }

      let turnError: unknown = null
      try {
        const gen = agent.run(text, {
          onTranscriptLine,
          onThinkingStart,
          onThinkingChunk,
          onThinkingStop,
          onTextStop,
          onNotice: (notice: TurnNotice) => {
            onTranscriptLine(renderTurnNotice(notice))
          },
        })
        while (true) {
          const { done, value } = await gen.next()
          if (done) break
          if (pluginStream) {
            const p = pluginStream.feed(value)
            if (p) await p
          } else {
            baseSink(value)
          }
        }
        if (pluginStream) await pluginStream.end()
      } catch (err) {
        turnError = err
      } finally {
        turnStatus.clear()
        statusRenderer?.resume()
        await endThinkingFormatter()
        if (formatter) await formatter.end()
      }

      if (turnError) {
        const msg = turnError instanceof Error ? turnError.message : String(turnError)
        statusRenderer?.suspend()
        // Same gating as the live-REPL path: when the throw already
        // routed through `diag.error(...)`, the ScrollbackDiagnosticSink
        // has rendered the failure as a rich block. Skip the bare
        // fallback line to avoid duplicating the message.
        if (!isErrorDiagEmitted(turnError)) {
          errOutput.write(`\n  ${c.boldRed("error")} ${msg}\n`)
        }
        // Discard the failed user turn so the next attempt doesn't send
        // two back-to-back user messages (the API rejects that).
        if (agent.rollbackPendingTurn) agent.rollbackPendingTurn()

        if (parseContextLengthExceededError(msg)) {
          errOutput.write(
            `  ${c.boldYellow("!")} ${c.yellow(contextLengthExceededAdvice(agent.getModel?.()))}\n`,
          )
        }

        // Detect errors that indicate the current model selection won't
        // work for this account (unknown model, or a beta the subscription
        // can't use) and offer the model picker again.
        const modelErr =
          parseModelNotFoundError(msg) ?? parseModelUnavailableError(msg, agent.getModel?.())
        if (modelErr && opts?.auth && agent.setModel) {
          const lister = opts.listModels ?? (() => listLiveModelsForPicker())
          try {
            const models = await lister(opts.auth)
            const picked = await promptModelPicker(
              models,
              agent.getModel?.() ?? modelErr,
              errOutput,
            )
            if (picked) {
              agent.setModel(picked)
              errOutput.write(`  ${c.boldGreen("ok")} model set to ${c.cyan(picked)}\n`)
            } else {
              errOutput.write(
                `  ${c.dim("kept current model")} ${c.cyan(agent.getModel?.() ?? "")}\n`,
              )
            }
          } catch (listErr) {
            errOutput.write(
              `  ${c.boldRed("error")} could not list models: ${listErr instanceof Error ? listErr.message : String(listErr)}\n`,
            )
          }
        }
        statusRenderer?.resume()
        output.write("\n")
        continue
      }

      // Terminate the partial response line so the next prompt starts at
      // column 0. No extra blank separator : the prompt sits directly
      // below the response. Skip when the response already ended with `\n`
      // (or we wrote nothing at all).
      if (wroteOutput && !lastChunkEndedWithNewline) output.write("\n")
    }
  } finally {
    statusRenderer?.stop()
    if (input instanceof RawInput) input.disable()
  }

  output.write(`\n${c.dim("Goodbye.")}\n`)
}

/**
 * Live-area REPL: the multiline input is pinned to the bottom of the
 * terminal and stays visible across agent work. Streamed output is written
 * through the {@link ReplCompositor} (which scrolls inside a region above
 * the live area), and the {@link ReplEditor} stays mounted for the entire
 * session : submits emit events; the buffer clears in place.
 *
 * Submits arriving while a turn is in flight are queued and processed in
 * order. A `cancel` event ends the loop cleanly.
 *
 * Required opts: `compositor`, `editor`. The caller is responsible for
 * starting the editor's I/O (we call `editor.start()` here) and for
 * providing a compositor that has not yet been mounted.
 */
