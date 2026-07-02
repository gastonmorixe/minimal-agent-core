/**
 * Live-area REPL renderer: the long-running orchestration function
 * that owns the compositor surface (scrollback + live area) and
 * pumps the model's streaming output through it.
 *
 * Hot path. Split out of `src/agent.ts` to keep that file under the
 * `max-lines` lint budget; not re-exported from `agent.ts` because
 * the only caller is `runRepl` in the sibling `./repl.ts`.
 *
 * @module agent/repl-live-area
 */

import { type AbortReason, abortBus } from "../abort-bus.ts"
import type { AskUserFn } from "../agent/preflight-pipeline.ts"
import type { TurnNotice } from "../agent/turn-notice.ts"
import type { AuthResult } from "../auth.ts"
import { isErrorDiagEmitted } from "../diagnostic-bus.ts"
import type { ModelInfo } from "../llm/transport/types.ts"
import type { ModeDeliveryEvent } from "../modes.ts"
import { PluginStream } from "../plugins/stream.ts"
import type { ResolvedLiveAreaSlot } from "../plugins/types.ts"
import { formatRestoredMessages } from "../queue-restore.ts"
import { loadQueue, QueueStore } from "../queue-store.ts"
import {
  prefixSubmittedAtLines,
  type SubmittedAtStyle,
  submittedAtEnabled,
} from "../scrollback-submitted-at.ts"
import { parseCommandLine } from "../slash-command-parse.ts"
import { GLOBAL_STATUS_BUS, StatusBus } from "../status.ts"

import { type AskUserHostEditor, createAskUserHost } from "./ask-user-host.ts"
import type { QueueKeyHandler } from "./editor/types.ts"
import { contextLengthExceededAdvice, parseContextLengthExceededError } from "./model-error.ts"
import type {
  ReplAgentLike,
  ReplCompositor,
  ReplEditor,
  ReplErrOutput,
  ReplOutput,
  StatusController,
} from "./repl.ts"
import { printGoodbye } from "./ui/chrome/goodbye-banner.ts"
import { buildModeChangeChip } from "./ui/chrome/mode-change-chip.ts"
import { buildPendingModeChangeDecoration } from "./ui/chrome/mode-change-pending-decoration.ts"
import { buildQueueDecorationLines } from "./ui/chrome/queue-decoration.ts"
import { coerceNoticeBlock, renderCommandNoticeBlock } from "./ui/command-notice.ts"
import { Formatter } from "./ui/formatter/formatter.ts"
import type { Spinner } from "./ui/spinner/index.ts"
import type { StatusSpinnerTheme } from "./ui/status/line-renderer.ts"
import { c, faintThinkingChunk, formatAbortedEcho } from "./ui/style/ansi.ts"
import { isOuterFrameClose } from "./ui/tool-transcript/format.ts"
import { renderTurnNotice } from "./ui/turn-notice.ts"

/**
 * Runs the interactive REPL on the compositor-based "live area" UI: a
 * persistent bottom-anchored editor with a status row, instead of the legacy
 * inline prompt. Owns the read-eval loop until the user quits, wiring
 * keybindings, slash commands, mode cycling, and abort handling around the
 * supplied agent. Blocks for the lifetime of the session.
 */
export async function runReplLiveArea(
  agent: ReplAgentLike,
  opts: {
    formatterCmd?: string[]
    output?: ReplOutput
    errOutput?: ReplErrOutput
    statusBus?: StatusBus
    statusRenderer?: StatusController | null
    spinner?: Spinner<StatusSpinnerTheme>
    auth?: AuthResult
    listModels?: (auth: AuthResult) => Promise<ModelInfo[]>
    compositor?: ReplCompositor
    editor?: ReplEditor
    /**
     * Bytes captured from stdin BEFORE the editor's data listener was
     * attached (typically during the term-caps DECRPM probe at startup).
     * Re-emitted to `process.stdin` immediately after `editor.start()` so
     * a fast-typing user doesn't lose the first keystroke of the session.
     */
    initialStdinBytes?: string
    /**
     * Session id used in the goodbye banner's `--resume <id>` hint. When
     * the user quits (confirmed Ctrl+C×2 OR escape-hatch), the banner is
     * printed AFTER the editor/compositor teardown so it lands in normal
     * scrollback. Omit / empty → degraded copy without the resume line.
     */
    sessionId?: string
    scrollbackSubmittedAt?: SubmittedAtStyle
  },
): Promise<void> {
  if (!opts.compositor || !opts.editor) {
    throw new Error("runRepl: useLiveArea requires both compositor and editor")
  }
  const compositor = opts.compositor
  const editor = opts.editor
  const statusBus = opts.statusBus ?? GLOBAL_STATUS_BUS
  const modeManager = agent.modes?.() ?? null
  const showSubmittedAt = submittedAtEnabled(opts.scrollbackSubmittedAt)

  // Wire mode cycling (Shift+Tab forward, Ctrl+Shift+Tab back) to the
  // editor. Mirrors the legacy `runRepl` wiring so users get the same UX
  // whether or not the live area is active. We also subscribe to mode
  // changes so the editor's prompt prefix repaints with the active mode's
  // label and color.
  const continuationPromptForRebuild = process.env.MINIMAL_AGENT_CONTINUATION_PROMPT ?? "  "
  const baseArrow = `${c.bold(c.pink("❯"))} `
  if (
    modeManager &&
    modeManager.hasModes() &&
    typeof editor.setModeCycleHandlers === "function" &&
    typeof editor.setPrompt === "function"
  ) {
    const repaintPrompt = () => {
      editor.setPrompt?.(modeManager.promptPrefix(baseArrow), continuationPromptForRebuild)
    }
    modeManager.subscribe(repaintPrompt)
    // Pending-widget refresh on every toggle. The widget peeks
    // ModeManager state synchronously, so as long as we re-call
    // renderDecoration the band picks up the new pending state.
    // Only matters while a turn is in flight (renderDecoration is a
    // no-op at idle). Cheap : peekPendingAttachment is a single
    // pointer compare + object allocation.
    modeManager.subscribe(() => renderDecoration())
    // Race-defense: when the user presses Enter, EditorController.submit
    // calls this builder to fetch the FRESHEST prompt prefix and bakes
    // that into the scrollback commitLines. Without this, a mode
    // toggle could race with the Enter keypress and the cached
    // `renderer.prompt` could be one tick behind. The mode-change
    // attachment that ships with the turn always reflects the
    // active mode at consume-time, so the prefix MUST match.
    editor.setCommitPromptBuilder?.(() => modeManager.promptPrefix(baseArrow))
    // Delivery subscription : paints the scrollback chip the instant
    // the model is told about the change (consumePendingAttachment
    // returns a non-null block). Replaces the old send-time peek
    // pattern, which painted optimistically and missed mid-turn ASAP
    // deliveries and Alt+M interrupts.
    modeManager.onDeliver(renderDeliveredModeChangeChip)
    // Also clear the pending widget when delivery fires (peek now
    // returns null, so renderDecoration re-renders to nothing for the
    // mode row). Same listener for both effects keeps the wiring
    // narrow.
    modeManager.onDeliver(() => renderDecoration())
    editor.setModeCycleHandlers(
      () => modeManager.cycleNext(),
      () => modeManager.cyclePrev(),
    )
    // Alt+M : interrupt-and-apply-mode. Fires only when there's a
    // pending mode change AND a turn is in flight. Otherwise no-op
    // (cycling and ASAP delivery already cover the other cases).
    //
    // The handler enqueues a zero-text item (drained as a mode-only
    // continuation turn by the main loop : `agent.run("")` with
    // attachments-only) and aborts the in-flight request. The next
    // `queue.shift()` iteration picks up the zero-text item, which
    // ships only the `<ma::agent::mode-change>` attachment that
    // `consumePendingAttachment` will yield. No prose, no repetition,
    // cache-safe.
    if (typeof editor.setModeInterruptHandler === "function") {
      editor.setModeInterruptHandler(() => {
        const pending = modeManager.peekPendingAttachment()
        if (pending == null) return
        if (!running) {
          // Idle path: nothing to interrupt. The next user submit
          // will carry the attachment naturally.
          return
        }
        // Enqueue a synthetic zero-text item. The agent loop's
        // `if (!text.trim()) return` filter in onSubmit is bypassed
        // : we push directly. `commitLines` is empty so nothing is
        // written to scrollback for this synthetic turn (the chip
        // path in `flushPendingModeChangeChip` lands the mode-change
        // chip itself).
        queue.push({ text: "", commitLines: [] })
        // Synthetic zero-text items get persisted too; loadQueue filters
        // them out on restore, so they're effectively no-ops across
        // sessions but the bookkeeping stays uniform with real submits.
        persistQueue()
        renderDecoration()
        // Abort the in-flight request. The next turn iteration will
        // call agent.run("") which becomes a mode-change-only turn.
        abortBus.requestAbort({ kind: "programmatic", tag: "mode-interrupt" })
        wakeWaiter()
      })
    }
    // Apply the current prompt immediately in case a default mode is
    // already active at startup.
    repaintPrompt()

    // No mode-toggle decoration subscriber. The prompt-prefix repaint
    // (the other `onChange` subscriber above) is the live cue, and
    // `flushPendingModeChangeChip` (defined below) writes the chip to
    // scrollback at send time. There is intentionally NO "queued mode
    // change" band : it duplicated the prompt prefix at idle and
    // duplicated the scrollback chip on send, so it only added noise.
  }
  // Live-area status defaults to a LiveAreaStatusController that paints the
  // spinner+label as the top row of the live area. Tests can pass `null` to
  // disable, or supply their own controller.
  let statusRenderer: StatusController | null
  if (opts && "statusRenderer" in opts) {
    statusRenderer = opts.statusRenderer ?? null
  } else {
    const { LiveAreaStatusController } = await import("./ui/status/live-area-controller.ts")
    if (typeof editor.setStatus !== "function") {
      throw new Error("runRepl: editor.setStatus is required when statusRenderer is omitted")
    }
    const sink: { setStatus(text: string | null): void } = {
      setStatus: (t) => editor.setStatus?.(t),
    }
    statusRenderer = new LiveAreaStatusController(statusBus, sink, {
      spinner: opts.spinner,
    })
  }
  const loader = agent.pluginLoader()

  // Host-side listener for `editor.buffer.set` — plugins (e.g. a future
  // Ctrl+R search modal in `history`) may need to replace the editor
  // buffer OUTSIDE the `editor.key` flow (where they can already do so
  // via `result.buffer`). Payload: `{text}`. setBuffer parks the cursor
  // at end-of-buffer; plugins that need finer cursor placement should
  // use the `editor.key` payload's `result.cursor` instead.
  //
  // No-op when no plugins are loaded; the listener never fires.
  if (loader) {
    loader.hooks().on(
      "editor.buffer.set",
      (payload: unknown) => {
        if (!payload || typeof payload !== "object") return
        const p = payload as { text?: unknown }
        if (typeof p.text !== "string") return
        if (typeof editor.setBuffer === "function") editor.setBuffer(p.text)
      },
      { caller: "agent", priority: 5000, label: "agent:editor.buffer.set" },
    )

    // Host-side listener for `editor.footer.set` — overlays (slash-menu
    // is the first user) paint into the editor's footer band by emitting
    // on this channel. Payload `{lines: string[]}`. Empty array clears.
    //
    // CRITICAL: route to the dedicated `overlay` footer layer, NOT the
    // default layer. The default layer is owned by the FooterAggregator
    // (quota row + diagnostic surface) — if we wrote there, the next
    // quota-status tick would overwrite the menu mid-typing. The overlay
    // layer sits ABOVE default in z-order, so an overlay obscures the
    // quota row while open and the quota row pops back when the overlay
    // clears. ARMED (Ctrl+C confirm) still wins over both.
    loader.hooks().on(
      "editor.footer.set",
      (payload: unknown) => {
        if (!payload || typeof payload !== "object") return
        const p = payload as { lines?: unknown }
        if (!Array.isArray(p.lines)) return
        if (!p.lines.every((l) => typeof l === "string")) return
        const lines = p.lines as string[]
        // Dynamic import keeps the agent free of editor-controller
        // module references when no plugins ever emit on this channel.
        import("./editor-controller.ts")
          .then(({ FOOTER_LAYER_OVERLAY, FOOTER_PRIORITY_OVERLAY }) => {
            const e = editor as unknown as {
              setFooterLayer?: (id: string, lines: string[], opts?: { priority?: number }) => void
              clearFooterLayer?: (id: string) => void
            }
            if (lines.length === 0) {
              if (typeof e.clearFooterLayer === "function") {
                e.clearFooterLayer(FOOTER_LAYER_OVERLAY)
              }
              return
            }
            if (typeof e.setFooterLayer === "function") {
              e.setFooterLayer(FOOTER_LAYER_OVERLAY, lines, {
                priority: FOOTER_PRIORITY_OVERLAY,
              })
            } else if (typeof editor.setFooterLines === "function") {
              // Back-compat path: older editor without layer support.
              editor.setFooterLines(lines)
            }
          })
          .catch(() => {
            // Best-effort fallback when the import fails.
            if (typeof editor.setFooterLines === "function") {
              editor.setFooterLines(lines)
            }
          })
      },
      { caller: "agent", priority: 5000, label: "agent:editor.footer.set" },
    )

    // Host-side listeners for `editor.overlay.open` / `editor.overlay.close`
    // — interactive command TUIs (/config, /usage) take MODAL ownership of
    // the input line. While owned the editor hides the prompt row + cursor,
    // blocks submit (so the typed `/cmd` can't leak to scrollback), and
    // routes every key to the overlay's `editor.key` handler. Payload
    // `{owner}` is the opening plugin's id; close is owner-checked so a stale
    // handler can't tear down a different overlay. No-op on editors without
    // the methods (older host / non-live REPL).
    const overlayCapable = editor as unknown as {
      openOverlay?: (owner: string) => void
      closeOverlay?: (owner: string) => void
    }
    loader.hooks().on(
      "editor.overlay.open",
      (payload: unknown) => {
        if (!payload || typeof payload !== "object") return
        const owner = (payload as { owner?: unknown }).owner
        if (typeof owner !== "string" || owner.length === 0) return
        overlayCapable.openOverlay?.(owner)
      },
      { caller: "agent", priority: 5000, label: "agent:editor.overlay.open" },
    )
    loader.hooks().on(
      "editor.overlay.close",
      (payload: unknown) => {
        if (!payload || typeof payload !== "object") return
        const owner = (payload as { owner?: unknown }).owner
        if (typeof owner !== "string" || owner.length === 0) return
        overlayCapable.closeOverlay?.(owner)
      },
      { caller: "agent", priority: 5000, label: "agent:editor.overlay.close" },
    )
  }

  // Build the askUser callback for the agent's preflight pipeline.
  //
  // The provider (today: Anthropic) may detect issues that need user
  // resolution before the network call (e.g. thinking blocks signed by
  // a different model than the current request targets, from a session
  // fork chain that switched --model mid-conversation). When that
  // happens, the agent opens a modal in the editor's footer overlay
  // layer via this callback and waits for the user's choice.
  //
  // Wiring conditions:
  //  - The editor must expose `setFooterLayer` / `clearFooterLayer`
  //    (the real `EditorController` does; some fakes in tests do not).
  //  - A plugin loader (and thus a Hooks bus) must be present so we
  //    can subscribe to `editor.key`.
  //
  // When either condition fails, `askUser` stays undefined and the
  // agent skips preflight, sending the request as-is. That preserves
  // existing behavior in headless / test setups and surfaces any
  // provider-side error the normal way.
  let askUser: AskUserFn | undefined
  const editorWithLayers = editor as unknown as Partial<AskUserHostEditor>
  if (loader && typeof editorWithLayers.setDecorationLines === "function") {
    // Pause the activity row while a modal is up (so a stale "Thinking" doesn't
    // tick above it). The LiveAreaStatusController implements these; a custom
    // statusRenderer that doesn't is simply skipped (optional-chained).
    const sr = statusRenderer as
      | (StatusController & {
          pauseForOverlay?(label: string | null): void
          resumeFromOverlay?(): void
        })
      | null
    askUser = createAskUserHost({
      editor: editorWithLayers as AskUserHostEditor,
      hooks: loader.hooks(),
      pauseActivity: () => sr?.pauseForOverlay?.(c.dim("⏸ paused — waiting for your input")),
      resumeActivity: () => sr?.resumeFromOverlay?.(),
    })
  }

  // Initial live-area height: 1 row (the prompt). The editor will grow it
  // as needed via setLiveHeight().
  compositor.mount(1)
  editor.start()
  // Replay stdin bytes captured while term-caps held raw mode : but ONLY
  // bytes that look like real keystrokes, never bytes that look like a
  // terminal reply (ESC-prefixed CSI/OSC). The DECRPM probe sometimes
  // races the timeout: the reply lands JUST after we resolve, gets
  // captured as "unparsed", and re-emitting it injects `^[ [ ? 2026 ; 1 $ y`
  // into the editor : which can read as a Ctrl+`[` (Esc) followed by
  // garbage and, depending on key bindings, cancel the editor or
  // submit/clear the buffer. Since real typeahead during the 80ms probe
  // is extremely rare and ESC-leading garbage is the common failure
  // mode, we discard ESC-leading buffers entirely.
  if (
    opts.initialStdinBytes &&
    opts.initialStdinBytes.length > 0 &&
    !opts.initialStdinBytes.startsWith("\x1b")
  ) {
    process.stdin.emit("data", opts.initialStdinBytes)
  }
  statusRenderer?.start()

  // Footer band setup is deferred to AFTER `editor.on("submit", ...)`
  // registration below : the dynamic imports here suspend execution
  // for ≥3 microtask cycles, and any stdin bytes that arrive during
  // that window fire the editor's "submit" event into the void
  // (no listener attached yet). Tests that submit immediately after
  // `runRepl(...)` + 2 `await Promise.resolve()` ticks would lose
  // their first keystroke. We pre-declare the locals here so the
  // `finally` block at end-of-fn can still reference them.
  const slotRows = loader?.getLiveAreaSlots() ?? []
  let liveAreaScheduler: import("./ui/status/live-area-scheduler.ts").LiveAreaScheduler | null =
    null
  let tuiDiagnosticSurface:
    | import("./ui/status/diagnostic-surface.ts").TuiDiagnosticSurface
    | null = null

  // Ready banner is now written from `src/index.ts` via direct stdout
  // BEFORE the compositor mounts and BEFORE any resume replay. See
  // `buildReadyBanner` in `../ui/chrome/ready-banner.ts` for the rationale (on
  // resume the banner used to land below the replayed content because
  // the replay had already streamed straight to stdout pre-mount;
  // moving the banner to the top of the scrollback phase fixes that).
  //
  // The trailing `\n\n` in the banner provides the one blank row of
  // breathing room above whatever comes next (resume separator or
  // prompt), so we no longer need to emit it here.

  // Submit queue: keystrokes never block, but we serialize agent turns.
  // Each queue item carries BOTH the user's text (for the agent) AND the
  // pre-rendered scrollback lines (for the TUI). The scrollback write is
  // deferred from EditorController.submit() to TURN START / drain time
  // here, so a queued prompt never appears in BOTH the scrollback and
  // the queue widget at the same time (Bug 393).
  type QueueItem = { text: string; commitLines: string[]; submittedAt?: string }
  const queue: QueueItem[] = []
  // Persist the queue to <sid>.queue on every mutation so submits typed
  // during a busy turn survive process exit (clean Ctrl+C or crash). The
  // store is a no-op when no sessionId was provided (ad-hoc runs, some
  // tests). See src/queue-store.ts for on-disk format + crash semantics;
  // the empty-array snapshot deletes the file, so a clean drain leaves
  // no stale state behind.
  const queueStore = opts.sessionId ? new QueueStore(opts.sessionId) : null
  const persistQueue = (): void => {
    queueStore?.save(queue)
  }
  // Restore any items left behind by a prior crash/exit on this sid.
  // Items will surface visually the first time the main loop sets
  // `running = true` (renderDecoration is a no-op at idle). Synthetic
  // zero-text items pushed by the Alt+M mode-interrupt path are NOT
  // restored (loadQueue filters them out); their pending-mode state from
  // the prior session is gone too, so replaying them would be a no-op.
  if (queueStore) {
    for (const item of loadQueue(opts.sessionId as string)) {
      queue.push(item)
    }
    // We do NOT persist here; the file we just loaded from already
    // contains exactly these items, so a re-save is wasted I/O.
  }
  /** Flush a queue item's pre-rendered scrollback lines, if any. */
  const flushQueueItemToScrollback = (item: QueueItem): void => {
    if (item.commitLines.length === 0) return
    if (typeof compositor.writeStream !== "function") return
    const lines =
      showSubmittedAt && item.submittedAt
        ? prefixSubmittedAtLines(item.commitLines, new Date(item.submittedAt))
        : item.commitLines
    // Matches the lead `EditorController.submit` used to emit before
    // the scrollback-write was deferred here : `\n\n\n` for two blank
    // rows of breathing room (capBlankLines collapses to ≤2 in actual
    // scrollback), trailing `\n` to terminate the prompt line.
    compositor.writeStream(`\n\n\n${lines.join("\n")}\n`)
  }
  /**
   * Subscriber that paints the mode-change scrollback chip the
   * instant the model is actually TOLD about the change (via
   * `ModeManager.consumePendingAttachment`). The chip is the
   * "model now knows" cue, not the "user toggled" cue.
   *
   * Wired via `modeManager.onDeliver(...)` further up. Declared as a
   * `function` (hoisted) so the subscription site can reference it
   * earlier in the function body than the body itself sits.
   *
   * Net-zero toggles never deliver, so this writes nothing for them.
   */
  function renderDeliveredModeChangeChip(event: ModeDeliveryEvent): void {
    if (modeManager == null) return
    if (typeof compositor.writeStream !== "function") return
    const fromLabel =
      event.fromId == null
        ? "default"
        : (modeManager.modeById(event.fromId)?.label ?? event.fromId.toUpperCase())
    const toLabel =
      event.toId == null
        ? "default"
        : (modeManager.modeById(event.toId)?.label ?? event.toId.toUpperCase())
    const chip = buildModeChangeChip({
      fromLabel,
      toLabel,
      fromFgOpen: modeManager.resolvedForId(event.fromId)?.label.fgOpen ?? null,
      toFgOpen: modeManager.resolvedForId(event.toId)?.label.fgOpen ?? null,
      at: event.at,
    })
    compositor.writeStream(`\n${chip}\n`)
  }
  let cancelled = false
  /** When non-null, the goodbye banner uses this reason in the closer copy. */
  let quitReason: "confirmed" | "escape-hatch" | null = null
  let resolveWaiter: (() => void) | null = null
  const wakeWaiter = () => {
    const r = resolveWaiter
    resolveWaiter = null
    if (r) r()
  }

  // Track whether a turn is currently running. Submits that arrive while
  // running become queued user input : eligible for mid-turn injection at
  // the next agent tool-loop boundary (see drainQueuedUserText below) AND
  // surfaced visually above the editor prompt via setDecorationLines.
  let running = false

  // Selected row in the submit-queue navigation overlay, or null when the
  // overlay is closed. Driven by `queueKeyHandler` (↑ opens it / moves the
  // selection); read by `renderDecoration` to paint the highlight bar +
  // action hints. Always reset to null when a turn ends so a new turn's
  // queue starts in the plain (non-interactive) display.
  let queueNavIndex: number | null = null

  /**
   * Paint the queued-message decoration block between the live-area
   * status row and the editor prompt. Only rendered while a turn is in
   * flight : at idle the main loop drains items immediately so there
   * would be nothing to queue. Byte-exact layout lives in the pure
   * builder `buildQueueDecorationLines` in `src/ui/chrome/queue-decoration.ts`.
   */
  const renderDecoration = (): void => {
    if (typeof editor.setDecorationLines !== "function") return
    if (!running) {
      // Even when no turn is in flight, a mode toggle made WHILE no turn
      // was running has no pending state to render : the next user submit
      // ships the attachment and `consumePendingAttachment` clears the
      // pending flag in the same tick. So at idle the band is always empty.
      editor.setDecorationLines([])
      return
    }
    const lines: string[] = []
    // Pending mode-change widget (Phase 3 of the mode-system overhaul).
    // Renders only when:
    //   - a ModeManager is wired,
    //   - the active mode differs from `lastAdvertisedModeId`,
    //   - a turn is in flight (`running === true`, this branch).
    // Cleared automatically the instant `consumePendingAttachment`
    // delivers (the next renderDecoration call sees peek === null).
    // Sits ABOVE the queued-user-text widget so the two stacks read
    // top-to-bottom by "salience": mode > queued text.
    if (modeManager != null) {
      const row = buildPendingModeChangeDecoration(
        modeManager.peekPendingAttachment(),
        (id) => (id == null ? "default" : (modeManager.modeById(id)?.label ?? id.toUpperCase())),
        (id) => modeManager.resolvedForId(id)?.label.fgOpen ?? null,
      )
      if (row != null) lines.push(row)
    }
    // Clamp / clear the nav selection against the LIVE queue so a
    // mid-turn drain (drainQueuedUserText) or any out-of-band mutation
    // can't leave a stale or out-of-range highlight.
    if (queueNavIndex !== null) {
      if (queue.length === 0) queueNavIndex = null
      else queueNavIndex = Math.max(0, Math.min(queue.length - 1, queueNavIndex))
    }
    const cols = opts.output?.columns ?? process.stdout.columns
    for (const ql of buildQueueDecorationLines(
      queue.map((q) => q.text),
      {
        selectedIndex: queueNavIndex,
        cols,
      },
    )) {
      lines.push(ql)
    }
    editor.setDecorationLines(lines)
  }

  // Submit-queue navigation overlay. Wired into the editor via
  // `setQueueKeyHandler`; the editor consults this BEFORE its default
  // handling of ↑ / ↓ / Enter / Esc / printable keys. The handler is the
  // single source of truth for "is the overlay open" (`queueNavIndex`),
  // so when it's closed every key but an opening ↑ passes straight
  // through (`handled: false`).
  //
  // Gestures (all only meaningful while a turn is in flight, which is the
  // only time items sit queued):
  //   ↑ on an empty prompt      → 1 item: dequeue it back to the input;
  //                                >1 items: open the overlay (select last)
  //   ↑ / ↓ (overlay open)      → move the selection
  //   d / Enter (overlay open)  → dequeue the selected item to the input
  //   x (overlay open)          → remove (discard) the selected item
  //   k (overlay open)          → dequeue ALL to the input (numbered)
  //   Esc (overlay open)        → close the overlay, queue untouched
  //
  // Every queue mutation calls persistQueue() so the on-disk <sid>.queue
  // snapshot stays in lockstep (a dequeue clears it from persistence).
  const queueKeyHandler: QueueKeyHandler = (key, ctx) => {
    if (key === "ArrowUp") {
      if (queueNavIndex === null) {
        // Opening gesture: only from an empty prompt with the cursor at
        // the top, so ↑ inside a draft still moves the cursor / recalls
        // history.
        if (!ctx.atTop || ctx.buffer.length > 0) return { handled: false }
        if (queue.length === 0) return { handled: false }
        if (queue.length === 1) {
          const item = queue.shift()
          persistQueue()
          renderDecoration()
          return { handled: true, buffer: item ? item.text : "" }
        }
        // >1: open the overlay on the most-recently-queued (bottom) row,
        // matching the "↑ = reach back" mental model.
        queueNavIndex = queue.length - 1
        renderDecoration()
        return { handled: true }
      }
      queueNavIndex = Math.max(0, queueNavIndex - 1)
      renderDecoration()
      return { handled: true }
    }
    // Everything below is overlay-only.
    if (queueNavIndex === null) return { handled: false }
    const idx = Math.max(0, Math.min(queue.length - 1, queueNavIndex))
    switch (key) {
      case "ArrowDown":
        queueNavIndex = Math.min(queue.length - 1, queueNavIndex + 1)
        renderDecoration()
        return { handled: true }
      case "Enter":
      case "d": {
        const item = queue.splice(idx, 1)[0]
        queueNavIndex = null
        persistQueue()
        renderDecoration()
        return { handled: true, buffer: item ? item.text : "" }
      }
      case "x": {
        queue.splice(idx, 1)
        persistQueue()
        if (queue.length === 0) queueNavIndex = null
        else queueNavIndex = Math.min(idx, queue.length - 1)
        renderDecoration()
        return { handled: true }
      }
      case "k": {
        const texts = queue.splice(0).map((q) => q.text)
        queueNavIndex = null
        persistQueue()
        renderDecoration()
        return { handled: true, buffer: formatRestoredMessages(texts) }
      }
      case "Escape":
        queueNavIndex = null
        renderDecoration()
        return { handled: true }
      default:
        // Any other printable while open: swallow so the overlay stays
        // modal (the hint row teaches the real keys). Control keys never
        // reach this handler.
        return { handled: true }
    }
  }
  if (typeof editor.setQueueKeyHandler === "function") {
    editor.setQueueKeyHandler(queueKeyHandler)
  }

  /**
   * Write a block of pre-formatted notice lines to scrollback (no model
   * turn). Used for deterministic slash-command results. Mirrors the
   * blank-row breathing room `flushQueueItemToScrollback` uses.
   */
  const writeNoticeLines = (lines: string[]): void => {
    if (lines.length === 0) return
    if (typeof compositor.writeStream !== "function") return
    compositor.writeStream(`\n\n${lines.join("\n")}\n`)
  }

  /** The live terminal width, for width-aware renderers (e.g. notice wrapping). */
  const liveCols = (): number | undefined => opts.output?.columns ?? process.stdout.columns

  /** The normal "queue this text as a user prompt" path. */
  const enqueuePrompt = (text: string, commitLines: string[], submittedAt?: Date): void => {
    queue.push({ text, commitLines, submittedAt: (submittedAt ?? new Date()).toISOString() })
    // Persist BEFORE any other side effect so a crash between push and
    // the next instruction still recovers the submit on next resume.
    persistQueue()
    renderDecoration()
    wakeWaiter()
    // Fan out to the plugin bus so subscribers (notably the `history`
    // plugin) see every submit. Fire-and-forget — the bus is microtask-
    // deferred, never blocks this onSubmit path. We emit AFTER the
    // queue push so subscribers observe the same queue ordering the
    // agent will process.
    if (loader) {
      loader.bus().emit("prompt.submitted", {
        text,
        cwd: process.cwd(),
        sid: opts.sessionId ?? null,
        exit: "submitted",
        queuePos: queue.length - 1,
      })
    }
  }

  /**
   * Dispatch a registered slash command out-of-band and apply its result.
   * The user's typed line is committed to scrollback first (so they see
   * `❯ /loop …`), then: `expand` re-enters the prompt queue as a turn,
   * `notice`/`error` print to scrollback with no turn, `none` is silent.
   * A null result (shouldn't happen — we pre-checked `hasCommand`) falls
   * back to treating the text as a normal prompt.
   */
  const dispatchCommandAndApply = async (
    text: string,
    commitLines: string[],
    submittedAt?: Date,
  ): Promise<void> => {
    if (!loader) return
    const submittedAtIso = (submittedAt ?? new Date()).toISOString()
    flushQueueItemToScrollback({ text, commitLines, submittedAt: submittedAtIso })
    let result: Awaited<ReturnType<typeof loader.dispatchCommand>>
    try {
      result = await loader.dispatchCommand(text, { cwd: process.cwd() })
    } catch (e) {
      writeNoticeLines([`✗ command failed: ${e instanceof Error ? e.message : String(e)}`])
      return
    }
    if (!result) {
      enqueuePrompt(text, commitLines, submittedAt)
      return
    }
    switch (result.kind) {
      case "expand":
        // The typed `/cmd` line is already in scrollback; the expanded
        // prompt drives the turn with no extra commit lines.
        enqueuePrompt(result.prompt, [])
        break
      case "notice":
        writeNoticeLines([
          ...(result.block ? renderCommandNoticeBlock(result.block, liveCols()) : []),
          ...(result.lines ?? []),
        ])
        break
      case "error":
        writeNoticeLines([`✗ ${result.message}`])
        break
      case "none":
        break
      default: {
        throw new Error(`unhandled command result: ${JSON.stringify(result satisfies never)}`)
      }
    }
  }

  const onSubmit = (text: string, commitLines: string[] = [], submittedAt?: Date): void => {
    if (!text.trim()) return
    // Slash-command interception (REPL-scoped). A submitted line that
    // parses as `/<name>` AND names a registered command is dispatched
    // out-of-band; everything else (unknown `/foo`, pasted `/usr/bin`,
    // ordinary prose) falls through to the normal prompt queue. The
    // dispatch is async + fire-and-forget so the editor's sync submit
    // event never blocks.
    if (loader) {
      const parsed = parseCommandLine(text)
      if (parsed && loader.hasCommand(parsed.name)) {
        void dispatchCommandAndApply(text, commitLines, submittedAt)
        return
      }
    }
    enqueuePrompt(text, commitLines, submittedAt)
  }
  const onCancel = (reason?: string): void => {
    cancelled = true
    if (reason === "confirmed" || reason === "escape-hatch") {
      quitReason = reason
    }
    wakeWaiter()
  }

  editor.on("submit", onSubmit)
  editor.on("cancel", onCancel)

  // Out-of-band prompt injection. Any plugin (notably `schedule`'s
  // heartbeat) can emit `prompt.inject` on the shared bus to enqueue a
  // prompt as if the user had typed it. We route it through the SAME
  // `onSubmit` path, so an injected prompt: (a) is blank-guarded,
  // (b) lands in the persisted queue (crash/resume safe), (c) wakes an
  // idle waiter, and (d) drains only at a turn boundary — i.e. it fires
  // BETWEEN turns, never mid-response, matching the scheduled-tasks
  // contract. The host is the sole queue owner (Mediator); injectors
  // never touch the queue directly. Disposed in the `finally` below.
  let disposePromptInject: (() => void) | null = null
  let disposeCommandRun: (() => void) | null = null
  let disposeNotification: (() => void) | null = null
  if (loader) {
    disposePromptInject = loader
      .bus()
      .on<{ text?: unknown; source?: unknown }>("prompt.inject", (ctx) => {
        const text = typeof ctx.payload?.text === "string" ? ctx.payload.text : ""
        // onSubmit already drops blank/whitespace-only text.
        onSubmit(text)
      })

    // Async, between-turns USER notification (a framed scrollback toast),
    // NOT a model turn. Any plugin emits `notification.emit` with a
    // CommandNoticeBlock the host frames with its own chrome (so plugins
    // never hand-draw borders or write to ctx.stderr) plus an optional plain
    // `text` the host persists as a session `note` record so the toast
    // survives resume. The intercom arrival is the first consumer. We render
    // straight to scrollback via the same `writeNoticeLines` path slash
    // commands use; this fires off the agent turn loop, so it lands BETWEEN
    // turns exactly like the old stderr write did, but framed + persisted +
    // routed through the compositor (no live-area tearing).
    disposeNotification = loader
      .bus()
      .on<{ block?: unknown; text?: unknown; source?: unknown }>("notification.emit", (ctx) => {
        const block = coerceNoticeBlock(ctx.payload?.block)
        if (block) writeNoticeLines(renderCommandNoticeBlock(block, liveCols()))
        // Persist the plain-text form (audit / resume). Note records are
        // metadata: never folded into the model's message history.
        const text = typeof ctx.payload?.text === "string" ? ctx.payload.text.trim() : ""
        if (text.length > 0) agent.appendNote?.(text)
      })

    // Direct command dispatch from an overlay (the slash-menu picks a
    // command row). Routes through the registry path WITHOUT the editor
    // buffer / submit, so one Enter dispatches the command (opening its TUI)
    // instead of the fragile rewrite-buffer-then-submit dance that raced the
    // async menu re-open. A registered `/cmd` line dispatches; anything else
    // is ignored (the menu only emits this for command rows). The typed line
    // is NOT committed to scrollback here — interactive commands paint their
    // own overlay; the leak the user reported was exactly that scrollback
    // commit firing for `/config`.
    disposeCommandRun = loader.bus().on<{ line?: unknown }>("command.run", (ctx) => {
      const line = typeof ctx.payload?.line === "string" ? ctx.payload.line.trim() : ""
      if (line.length === 0) return
      const parsed = parseCommandLine(line)
      if (!parsed || !loader.hasCommand(parsed.name)) return
      void dispatchCommandAndApply(line, [])
    })
  }

  // Footer band: two producers share the editor's `setFooterLines` —
  // (1) plugin-contributed slots driven by `LiveAreaScheduler` (the
  // quota row), and (2) the `TuiDiagnosticSurface` (the last-warn /
  // last-err summary). They merge through `FooterAggregator` so the
  // editor receives a single combined `[diagnostic..., plugin...]`
  // array on every change. Diagnostic lines come FIRST so a stale
  // warning never gets shoved off-screen by a freshly-painted quota
  // line.
  //
  // The plugin scheduler is gated on (a) at least one slot existing
  // AND (b) the editor supporting `setFooterLines`. The diagnostic
  // surface is unconditional — even a no-plugin run can encounter
  // auth refresh storms or other diag-emitting code paths.
  //
  // Setup runs AFTER `editor.on("submit"/"cancel", ...)` registration
  // so the dynamic imports here cannot orphan a fast-arriving submit
  // event (see the comment above the `slotRows` declaration).
  if (typeof editor.setFooterLines === "function") {
    const { FooterAggregator } = await import("./ui/status/footer-aggregator.ts")
    const { TuiDiagnosticSurface } = await import("./ui/status/diagnostic-surface.ts")
    const { getDiagnosticBus } = await import("../diagnostic-bus.ts")

    const aggregator = new FooterAggregator(
      (lines) => editor.setFooterLines?.(lines),
      // setDecoration is unused by the diagnostic surface (header
      // band stays owned by the queue display); the plugin sink's
      // setDecorationLines passthrough still works for any slot
      // that requests `position: "header"` (the scheduler falls
      // back to footer with a one-time notice; future cuts can
      // route real header slots here).
      (lines) => editor.setDecorationLines?.(lines),
    )

    tuiDiagnosticSurface = new TuiDiagnosticSurface()
    tuiDiagnosticSurface.bindSink(aggregator.diagnosticSink())
    tuiDiagnosticSurface.attach(getDiagnosticBus())

    if (slotRows.length > 0) {
      const { LiveAreaScheduler } = await import("./ui/status/live-area-scheduler.ts")
      liveAreaScheduler = new LiveAreaScheduler(
        slotRows as ResolvedLiveAreaSlot[],
        aggregator.pluginSink(),
        {
          // Loader's event bus drives `refreshOn` slot events
          // (e.g. `quota.headersReceived` from `client.ts`).
          bus: loader?.bus(),
          // Same frozen AgentContext the loader threads through every
          // other plugin context. Live-area slots see `ctx.agent` with
          // the SAME values as a TUI handler in the same session.
          agent: loader?.agentContext(),
          // Singleton diagnostic bus picks up the scheduler's own
          // timeout / failure / recovery events. Tests inject an
          // isolated bus; production defaults to the singleton.
          // (Left implicit so the default kicks in.)
        },
      )
      liveAreaScheduler.start()
    }
  }

  // Terminal-resize handling. Without this, after a terminal shrink the
  // footer band + queued-message decoration rows keep their old (now
  // over-wide) layout and corrupt the live region until the next repaint.
  // On every SIGWINCH-driven `resize` event we (1) tell the editor to
  // reflow its prompt/footer at the new width (`notifyResize`) and (2)
  // re-run `renderDecoration` so the queue/mode-change rows recompute
  // against `process.stdout.columns`. Both are cheap, so no debounce is
  // needed (and there's no debounce util in scope to reuse). The listener
  // is removed in the `finally` below, alongside the other subscription
  // disposals, so it never leaks; `resizeDisposed` guards the handler
  // against firing during/after teardown.
  let resizeDisposed = false
  const onTerminalResize = (): void => {
    if (resizeDisposed) return
    editor.notifyResize?.()
    renderDecoration()
  }
  process.stdout.on("resize", onTerminalResize)

  try {
    while (!cancelled) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve
        })
        continue
      }
      const item = queue.shift()
      if (item === undefined) continue
      // Persist the now-shorter queue. The window between this save and
      // the agent's appendUser call (in run()) is a few microseconds of
      // synchronous code; a hard crash in that gap loses ONE item.
      // Acceptable: the pre-store behavior lost every queued item on
      // every exit. See queue-store.ts module doc for the full rationale.
      persistQueue()
      const text = item.text
      // Flush the deferred scrollback commit NOW (the editor stopped
      // writing at submit time : Bug 393). For queued items this is
      // when they first appear in scrollback; for direct submits it's
      // microseconds after Enter, indistinguishable from the old behavior.
      // Decoration must be re-rendered AFTER the shift so the queue widget
      // shrinks by one row in lockstep with the scrollback commit.
      // Mode-change chip is NOT painted here : it's painted by the
      // `modeManager.onDeliver(...)` subscription (see
      // `renderDeliveredModeChangeChip` above), which fires from inside
      // `agent.run` when `consumePendingAttachment` actually returns a
      // block. That makes the chip the "model now knows" cue, not the
      // "user pressed Enter" cue. The two are usually the same instant
      // for queue-drain turns (consume happens microseconds after
      // queue.shift), but they diverge for ASAP mid-turn deliveries
      // and Alt+M interrupts : we want the chip to reflect those too.
      flushQueueItemToScrollback(item)
      renderDecoration()

      const statusText = modeManager ? modeManager.statusLabel("Thinking") : "Thinking"
      const turnStatus = statusBus.create(statusText, {
        notificationId: "agent.thinking",
        category: "agent",
      })

      let turnError: unknown = null
      let lastChunkEndedWithNewline = false
      let wroteOutput = false

      // If --formatter was passed, spawn one per turn so markdown state
      // resets between user messages. The formatter's stdout is fed into
      // compositor.writeStream so it lands above the pinned live area.
      //
      // **Per text-block lifecycle, not per turn.** Inside one `run()` a
      // turn can produce multiple text blocks (text → tool → text → …).
      // Mdstream's `partial` paragraph buffer is keyed to ONE process and
      // would otherwise accumulate every text-block into one paragraph;
      // at `finish()` it then re-renders the *combined* buffer, smashing
      // unrelated sentences together with no separator. We respawn the
      // formatter on every `onTextStop` boundary (defined below) : each
      // text block gets its own subprocess, each gets its own `finish()`,
      // each paragraph commits independently and on its own row.
      let formatter: Formatter | null = null
      // Some formatters (notably mdstream) emit a trailing `\n\n` at the end
      // of a render to ensure block-level separation. In our REPL that lands
      // as TWO blank rows between the response and the next prompt instead
      // of one. We solve this by buffering trailing `\n` chunks: any run of
      // `\n` characters at the tail of a chunk is held back, and flushed
      // only when more body content arrives (preserving internal blank
      // lines). At end-of-turn we flush at most a single `\n`.
      let pendingTrailingNewlines = ""
      const flushTrailingNewlines = () => {
        if (pendingTrailingNewlines.length > 0) {
          compositor.writeStream(pendingTrailingNewlines)
          lastChunkEndedWithNewline = pendingTrailingNewlines.endsWith("\n")
          pendingTrailingNewlines = ""
        }
      }
      const writeFormatterChunk = (s: string) => {
        if (s.length === 0) return
        let i = s.length
        while (i > 0 && s[i - 1] === "\n") i--
        const body = s.slice(0, i)
        const tail = s.slice(i)
        if (body.length > 0) {
          // Body resumes after a tail-only run; flush any held newlines
          // verbatim so the internal layout is preserved.
          flushTrailingNewlines()
          compositor.writeStream(body)
        }
        pendingTrailingNewlines += tail
      }
      // Shared sink + decoder: lifted out of the original
      // `if (opts.formatterCmd)` block so `spawnMainFormatter()` (below) can
      // reuse them when respawning at text-block boundaries.
      const formatterDecoder = new TextDecoder()
      const compositorSink: Pick<NodeJS.WriteStream, "write"> & {
        columns?: number
        rows?: number
      } = {
        get columns() {
          return opts.output?.columns ?? process.stdout.columns
        },
        get rows() {
          return opts.output?.rows ?? process.stdout.rows
        },
        write: ((chunk: string | Uint8Array) => {
          const s = typeof chunk === "string" ? chunk : formatterDecoder.decode(chunk)
          writeFormatterChunk(s)
          return true
        }) as NodeJS.WriteStream["write"],
      }
      const spawnMainFormatter = (): Formatter | null => {
        if (!opts.formatterCmd) return null
        const f = new Formatter(opts.formatterCmd, compositorSink)
        f.start()
        return f
      }
      formatter = spawnMainFormatter()

      // Track the last kind of write so we can insert a blank-line separator
      // at text↔transcript boundaries. Without this, streamed markdown butts
      // directly against `└` lines (and vice versa), which the user reads as
      // "missing empty line between tool call and response".
      let lastKind: "none" | "text" | "transcript" = "none"

      const writeDirectSink = (s: string) => {
        if (s.length === 0) return
        // First write of the turn: insert a blank row of breathing room
        // above the response text. Mirrors the legacy `runRepl` baseSink
        // (`!wroteOutput` clause). Without this the response butts directly
        // under the just-committed `❯ <prompt>` row in scrollback. The
        // separator is unnecessary when the first content is a transcript
        // line (the agent prepends `\n` to tool headers); only text needs
        // the explicit kick.
        if (!wroteOutput) compositor.writeStream("\n")
        if (lastKind === "transcript") {
          // Transcript lines always end with `\n`; one more `\n` here yields
          // exactly one blank line between the `└ ...` and the next text.
          compositor.writeStream("\n")
        }
        wroteOutput = true
        lastChunkEndedWithNewline = s.endsWith("\n")
        lastKind = "text"
        compositor.writeStream(s)
      }

      const baseSink = (s: string) => {
        if (s.length === 0) return
        // See `writeDirectSink` for the rationale on the !wroteOutput kick.
        if (!wroteOutput) compositor.writeStream("\n")
        if (lastKind === "transcript") {
          // Transcript lines always end with `\n`; one more `\n` here yields
          // exactly one blank line between the `└ ...` and the next text.
          compositor.writeStream("\n")
        }
        wroteOutput = true
        lastChunkEndedWithNewline = s.endsWith("\n")
        lastKind = "text"
        if (formatter) formatter.write(s)
        else compositor.writeStream(s)
      }
      const ps = loader ? new PluginStream(baseSink, loader, process.cwd()) : null
      let thinkingFormatter: Formatter | null = null
      const thinkingDecoder = new TextDecoder()
      const thinkingOutput: Pick<NodeJS.WriteStream, "write"> & {
        columns?: number
        rows?: number
      } = {
        get columns() {
          return opts.output?.columns ?? process.stdout.columns
        },
        get rows() {
          return opts.output?.rows ?? process.stdout.rows
        },
        write: ((chunk: string | Uint8Array) => {
          const s = typeof chunk === "string" ? chunk : thinkingDecoder.decode(chunk)
          writeDirectSink(faintThinkingChunk(s))
          return true
        }) as NodeJS.WriteStream["write"],
      }
      const ensureThinkingFormatter = (): Formatter | null => {
        if (!opts.formatterCmd) return null
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
        // Transitioning from text to transcript: the formatter may have
        // held back a trailing `\n`/`\n\n` in `pendingTrailingNewlines`
        // (mdstream-style block-end run). Flush it FIRST so the text
        // section ends with its proper line terminator before the tool
        // header : otherwise the text line and the tool's `╭` would
        // collide on adjacent rows with no blank between them. The
        // capBlankLines cap in the compositor still ensures we never
        // get more than one blank row from the combined `\n` run.
        if (lastKind === "text") {
          flushTrailingNewlines()
          if (!lastChunkEndedWithNewline) {
            compositor.writeStream("\n")
            lastChunkEndedWithNewline = true
          }
        }
        // When lastKind === "none" we do NOT add an extra `\n`: the agent's
        // tool header already starts with `\n`, and submit() flushed the
        // prompt with a trailing `\n`. Those two together yield exactly
        // one blank row between the prompt and `╭`. Adding another `\n`
        // here (as we do in baseSink for streamed text, which has no
        // leading newline) would produce two blank rows.
        //
        // Block-close glyph `╰` is followed by an extra `\n` so the live
        // area below (status row, next tool block, or text) gets one
        // blank row of breathing room above it. capBlankLines in the
        // compositor caps the run at 2 ` \n`s = 1 visible blank, so
        // adjacent `╰`-then-`╭` doesn't pile up to two blank rows. This
        // closes the "missing blank between `╰ shown 10/20 L` and
        // `● Thinking`" visual bug (May 2026).
        const isBlockClose = isOuterFrameClose(line)
        compositor.writeStream(isBlockClose ? `${line}\n\n` : `${line}\n`)
        lastKind = "transcript"
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
        writeDirectSink("\n")
      }
      // Abnormal termination (refusal / content filter): the core hands
      // us the semantic notice; render it as a loud banner through the
      // same transcript writer tool blocks use so boundary/newline
      // bookkeeping (lastKind, pending trailing newlines) stays correct.
      const onNotice = (notice: TurnNotice): void => {
        onTranscriptLine(renderTurnNotice(notice))
      }
      // Mark the turn as running so submits arriving from this point on are
      // captured as queued user input rather than racing into the next
      // queue.shift() iteration. The decoration is rendered on every queue
      // mutation; clearing happens in the finally below.
      running = true
      renderDecoration()
      // drain: splice ALL pending items into one combined injection. We
      // batch because the user's typical mental model when queuing
      // multiple messages mid-turn is "give the model all this extra
      // context at once" rather than "respond to each as a separate
      // turn". If they wanted serialization they'd wait for a response
      // between submits. Items not drained here (because no tool boundary
      // ever fired) fall through to next-turn processing via the
      // existing FIFO queue.shift() loop.
      const drainQueuedUserText = (): string | null => {
        if (queue.length === 0) return null
        const drained = queue.splice(0)
        // Persist the now-empty queue. Same micro-race-window caveat as
        // the turn-start shift above; agent.ts's `appendUser` for the
        // injected text follows on the same synchronous tick.
        persistQueue()
        // Flush each drained item's pre-rendered scrollback lines IN ORDER
        // before injecting their combined text into the agent. The user
        // sees their queued prompts materialize in scrollback at the moment
        // they're handed to the agent (mid-turn drain at a tool boundary) :
        // mirrors what a sequence of solo turns would look like.
        // Mode-change chip is painted by the delivery subscription
        // (renderDeliveredModeChangeChip), not here : the subscription
        // fires from inside agent.run when consumePendingAttachment
        // returns a block, which is the actual "model now knows"
        // moment. See the onDeliver wiring further up.
        for (const item of drained) flushQueueItemToScrollback(item)
        renderDecoration()
        return drained.map((i) => i.text).join("\n\n")
      }
      // onQueueInject: NO-OP. Scrollback writes for drained items happen
      // inside drainQueuedUserText (above). The hook is retained as a
      // notification point in case future code wants to react to the
      // injection, but it must not write to scrollback : that would
      // double-commit the prompts (Bug 393, second-order regression).
      const onQueueInject = (_qtext: string): void => {
        /* intentionally empty : see comment above */
      }
      // Begin a turn on the global abort bus. From this point on, the
      // editor's bare-Esc / Ctrl+C handlers (see `EditorController`) will
      // route to `abortBus.requestAbort(...)` instead of clearing the
      // buffer or emitting `cancel`. We pass `ctrl.signal` into `agent.run`
      // so an abort tears down the SDK stream AND any in-flight tool
      // (Bash child gets SIGTERM → SIGKILL escalation, Read/Write/etc.
      // throw before further IO).
      //
      // Also tell the abort-quit FSM the turn has started — this transitions
      // it from idle/armed → working, and dismisses any armed footer that
      // may still be visible from a prior idle-confirm window.
      editor.notifyTurnStart?.()
      const ctrl = abortBus.beginTurn()
      let aborted = false
      // Whether the abort was a programmatic mode-interrupt (Alt+M) rather
      // than a genuine user "stop". Computed inside the listener where the
      // reason is concretely typed : avoids union flow-narrowing issues on
      // a closure-captured `let`.
      let abortWasModeInterrupt = false
      const onBusAbort = (reason: AbortReason): void => {
        aborted = true
        abortWasModeInterrupt = reason.kind === "programmatic" && reason.tag === "mode-interrupt"
      }
      abortBus.once("abort", onBusAbort)
      // Per-text-block formatter boundary. See the `spawnMainFormatter`
      // doc-cluster and the `onTextStop` field on `SendMessageOptions`:
      // ends the current main formatter (awaited : drains mdstream's
      // `finish()` output through `drainOutput` → `compositorSink`
      // synchronously w.r.t. our control flow) and respawns a fresh one
      // so the *next* text block starts with an empty `partial` paragraph
      // buffer. Without this, two text blocks in one `run()` get smashed
      // together at end-of-run by mdstream's final re-render.
      const onTextStop = async (): Promise<void> => {
        if (!formatter && !opts.formatterCmd) return
        const old = formatter
        formatter = null
        if (old) await old.end()
        // Discard the OLD formatter's trailing tail. The next text block
        // (if any) starts with a freshly-spawned formatter; any pending
        // `\n\n` from the OLD render belongs to the boundary between this
        // text block and whatever follows (tool, end-of-turn). We handle
        // those boundaries explicitly: `onTranscriptLine` adds its own
        // `\n` when crossing text→transcript, the `!wroteOutput` kick
        // in `baseSink` adds the leading `\n` for transcript→text, and
        // `EditorController.submit` provides the `\n\n\n` lead for
        // turn-end → next-prompt. Holding the OLD pending here just
        // double-counts the boundary and overshoots blanks.
        pendingTrailingNewlines = ""
        formatter = spawnMainFormatter()
      }
      try {
        const gen = agent.run(text, {
          signal: ctrl.signal,
          onTranscriptLine,
          onThinkingStart,
          onThinkingChunk,
          onThinkingStop,
          onTextStop,
          onNotice,
          drainQueuedUserText,
          onQueueInject,
          ...(askUser ? { askUser } : {}),
        })
        while (true) {
          const { done, value } = await gen.next()
          if (done) break
          if (ps) {
            const p = ps.feed(value)
            if (p) await p
          } else {
            baseSink(value)
          }
        }
      } catch (err) {
        turnError = err
      } finally {
        // Always end the turn FIRST so the bus is in a clean state for the
        // next iteration even if endThinkingFormatter / formatter.end()
        // throw. `off` keeps the listener count stable across turns.
        abortBus.off("abort", onBusAbort)
        abortBus.endTurn()
        // Tell the abort-quit FSM the turn settled. In the natural case
        // this transitions working → idle. If a Ctrl+C abort already
        // pushed us into armed:post-abort, the FSM stays armed (its
        // turn-end transition while armed is a no-op).
        editor.notifyTurnEnd?.()
        running = false
        // Close any open queue-nav overlay : the next turn's queue (if
        // any) starts in the plain display, never with a stale selection.
        queueNavIndex = null
        renderDecoration()
        turnStatus.clear()
        // Flush the PluginStream on EVERY turn-exit path (B-104). Previously
        // `ps.end()` ran only on the success path, so on an abort or a
        // turnError the scanner's buffered tail (already-emitted plugin
        // output held mid-scan) was silently dropped from scrollback. Ending
        // it here, in the finally, drains that tail through `baseSink` →
        // formatter before `endThinkingFormatter`/`formatter.end()` run,
        // matching the old success-path ordering. It runs exactly once per
        // turn (the success-only call was removed), so there's no double-end,
        // and it lands AFTER the abort-bus/FSM cleanup above so the "end the
        // turn first" invariant survives even if this flush throws.
        if (ps) await ps.end()
        await endThinkingFormatter()
        if (formatter) await formatter.end()
        // Discard the formatter's trailing-newline buffer entirely. The
        // compositor's drawLiveSeq handles the response→prompt boundary:
        // when the body ends mid-line (streamCol > 0) it emits a `\r\n`
        // line terminator so the live area starts at col 0. Writing our
        // own `\n` here would add an extra blank row. We still mark
        // `lastChunkEndedWithNewline` so the post-turn terminator below
        // doesn't fire either: the held tail represents the formatter's
        // intent to terminate, and the compositor handles the rest.
        if (pendingTrailingNewlines.length > 0) {
          pendingTrailingNewlines = ""
          lastChunkEndedWithNewline = true
        }
        compositor.flushStream?.()
      }

      // Abort path: distinguish user-initiated cancellation from a real
      // error. `agent.run` throws `Error("aborted")` with `name === "AbortError"`
      // when the signal trips. We swallow it, emit a single dim footer,
      // restore the in-flight prompt (PLUS any still-queued submits) to
      // the editor so the user can edit and resubmit, and rollback the
      // orphan user turn.
      const isAbortError =
        aborted || (turnError instanceof Error && (turnError as Error).name === "AbortError")
      if (isAbortError) {
        // Clear the stale `api.retry` / `api.stream-stalled` banner left by
        // the aborted attempt. An aborted retry never reaches its
        // `api.retry-success` recovery Notice, so the TuiDiagnosticSurface
        // warn slot would otherwise stay pinned across this abort and every
        // following turn (the stale-banner bug from the abort recording).
        tuiDiagnosticSurface?.clear()
        // Tell the agent the turn was cancelled by the USER (not a
        // programmatic mode-interrupt) so the NEXT run() emits a
        // model-visible `<ma::agent::turn-aborted />` marker. Without this the
        // model has no trace it was interrupted and may silently resume the
        // old plan (the "model can't tell it was aborted" gap from the
        // abort recording). Alt+M mode-interrupt is excluded: that abort is
        // an internal delivery mechanism, not a user "stop".
        if (!abortWasModeInterrupt) agent.notePreviousTurnAborted?.()
        // Make sure the abort echo starts on its own line. We separate
        // whenever ANY response text was written this turn, not only when
        // `lastChunkEndedWithNewline` is false: the trailing-newline flag can
        // be stale (a streamed line may have ended mid-row), and the old
        // guard let the echo collide with the last streamed line — e.g.
        // `↳ stream stalled — retrying …  ✘ ABORTED …` sharing one row in
        // the abort recording. A redundant blank line is harmless; a
        // collision is not. (`ps` is now flushed in the finally on every
        // exit path including abort — B-104 — so any buffered plugin tail
        // has already updated `wroteOutput`/`lastChunkEndedWithNewline`.)
        if (wroteOutput) compositor.writeStream("\n")
        // Render the faint+strikethrough echo of the rolled-back submission.
        // The visual semantics are unambiguous: the struck-through block
        // shows what got aborted; the next bold `❯ ` prompt (which appears
        // right below once the editor restores the buffer via setBuffer)
        // is the live editor showing the same text, available for edit and
        // re-submission. No separate "prompt restored to editor" line is
        // needed : the editor's own redraw is the proof.
        const activeMode = modeManager?.active()
        const modeLabel = activeMode?.label ?? activeMode?.id ?? null
        compositor.writeStream(`${formatAbortedEcho(text, { activeModeLabel: modeLabel })}\n`)
        if (agent.rollbackPendingTurn) agent.rollbackPendingTurn()
        // Dequeue EVERYTHING back to the prompt: the in-flight text first,
        // then any messages still queued behind it, so an abort never
        // silently drops queued submits. Numbered when there's more than
        // one (see formatRestoredMessages); a lone item restores verbatim,
        // so the no-queue case is byte-identical to the old setBuffer(text).
        // splice(0) empties the queue and persistQueue() clears the on-disk
        // snapshot in the same tick.
        const queuedTexts = queue.splice(0).map((q) => q.text)
        persistQueue()
        const restored = formatRestoredMessages([text, ...queuedTexts])
        if (typeof editor.setBuffer === "function") editor.setBuffer(restored)
      } else if (turnError) {
        const msg = turnError instanceof Error ? turnError.message : String(turnError)
        // When the throw already routed through `diag.error(...)` the
        // ScrollbackDiagnosticSink has already painted a rich
        // gutter-bracketed block ABOVE this point in scrollback. A
        // second bare `error <msg>` line here would just duplicate
        // the same string in plain red. Skip it; the rich block is
        // the user's signal that this turn failed.
        if (!isErrorDiagEmitted(turnError)) {
          compositor.writeStream(`\n  ${c.boldRed("error")} ${msg}\n`)
        }
        if (parseContextLengthExceededError(msg)) {
          compositor.writeStream(
            `  ${c.boldYellow("!")} ${c.yellow(contextLengthExceededAdvice(agent.getModel?.()))}\n`,
          )
        }
        if (agent.rollbackPendingTurn) agent.rollbackPendingTurn()
      } else if (wroteOutput && !lastChunkEndedWithNewline) {
        // Terminate the partial response line so the next stream write (or
        // the editor's submit flush) starts at column 0. No extra blank
        // line: the live-area prompt sits directly below the response.
        // When the response already ended with `\n` we skip this entirely
        // : avoids both the extra blank row AND the erase/redraw flicker
        // of an unnecessary writeStream call.
        compositor.writeStream("\n")
      }
    }
  } finally {
    // Remove the resize listener FIRST and flag it disposed so any
    // in-flight `resize` event can't touch the editor/compositor while
    // they're being torn down below.
    resizeDisposed = true
    process.stdout.off("resize", onTerminalResize)
    disposePromptInject?.()
    disposeCommandRun?.()
    disposeNotification?.()
    liveAreaScheduler?.stop()
    tuiDiagnosticSurface?.detach()
    statusRenderer?.stop()
    editor.stop()
    compositor.unmount()
    // Goodbye banner — print AFTER teardown so the terminal is in normal
    // mode and the framed block lands in scrollback. Only printed when a
    // user-confirmed quit fired (Ctrl+C×2 / escape-hatch); a clean
    // program-end (no quit) leaves no banner so the user can see whatever
    // last output the agent produced.
    if (quitReason !== null) {
      printGoodbye({
        sessionId: opts.sessionId ?? null,
        reason: quitReason,
      })
    }
  }
}

/**
 * Detect "model: <id>" not_found_error responses from the Messages API.
 * Returns the offending model id, or null if the error is unrelated.
 *
 * Example payload (status 404):
 *   `API 404: {"type":"error","error":{"type":"not_found_error","message":"model: claude-haiku-4-7"},...}`
 */
