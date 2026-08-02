/**
 * Live-area REPL boot for the CLI entry point.
 *
 * Builds the full interactive TTY stack — terminal capability probes
 * (DEC 2026 synchronized output, Nerd-glyph cell width), the
 * {@link Compositor}, the {@link StdioInterceptor}, the
 * {@link EditorController} with paste/clipboard/draft wiring, resize
 * fan-out, and the optional Auto-ASK controller — then hands control
 * to `runRepl` with the live area enabled.
 *
 * Split out of `src/index.ts` to keep that file under the `max-lines`
 * lint budget. Behavior is byte-identical to the previous inline
 * block; only the location changed.
 *
 * @module startup/live-repl
 */

import type { runRepl } from "../../agent/agent.ts"
import type { AuthResult } from "../../auth/auth.ts"
import { getGlobalEventBus } from "../../bus/global-bus.ts"
import type { UserConfig } from "../../config/config.ts"
import { clipboardText } from "../../media/clipboard.ts"
import { mediaPasteInterceptor } from "../../media/paste-intercept.ts"
import { AutoAskController } from "../../modes/auto-ask.ts"
import type { ModeManager } from "../../modes/modes.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import { getSessionId } from "../../session/session-id.ts"
import type { ReplAgentLike } from "../repl.ts"
import type { Spinner } from "../ui/spinner/index.ts"
import type { StatusSpinnerTheme } from "../ui/status/line-renderer.ts"
import { c } from "../ui/style/ansi.ts"

/** Inputs for {@link runLiveAreaRepl}. */
export interface LiveAreaReplOptions {
  /** The constructed agent / InteractiveSession the REPL drives. */
  agent: ReplAgentLike
  /** The `runRepl` entry from `../agent.ts` (passed in to avoid an import cycle). */
  repl: typeof runRepl
  /** Resolved formatter argv, or `undefined` for raw output. */
  formatterCmd: string[] | undefined
  /** The session's auth result (threaded into the REPL status line). */
  auth: AuthResult
  /** Optional status spinner preset instance. */
  spinner: Spinner<StatusSpinnerTheme> | undefined
  /** Raw CLI args (read for `--show-hidden-chars`). */
  args: string[]
  /** The loaded user config (nerdGlyphCells, autoAsk). */
  userConfig: UserConfig
  /** The mode manager, or `null` when no plugin modes loaded. */
  modeManager: ModeManager | null
  /** True when any plugin contributed tools / prompt / modes. */
  hasPlugins: boolean
  /** The plugin loader (hooks facade for the editor). */
  loader: PluginLoader
  /** Unsent draft restored from a resumed session, or `null`. */
  pendingDraft: string | null
}

/**
 * Probe the terminal, assemble the compositor + editor + interceptor
 * stack, and run the live-area REPL until exit. The interceptor is
 * uninstalled and the resize listener removed on the way out, even
 * when the REPL throws.
 */
export async function runLiveAreaRepl(opts: LiveAreaReplOptions): Promise<void> {
  const {
    agent,
    repl,
    formatterCmd,
    auth,
    spinner,
    args,
    userConfig,
    modeManager,
    hasPlugins,
    loader,
    pendingDraft,
  } = opts
  const { Compositor } = await import("../ui/compositor.ts")
  const { EditorController } = await import("../editor-controller.ts")
  const { StdioInterceptor } = await import("../ui/stdio-interceptor.ts")
  const { detectSynchronizedOutput } = await import("../ui/term-caps.ts")
  const { probeNerdGlyphCells, setNerdGlyphCells } = await import(
    "../../terminal/nerd-glyph-width.ts"
  )

  // Probe the terminal for DEC mode 2026 (synchronized output) BEFORE
  // creating the editor. Detection puts stdin into raw mode briefly,
  // sends a DECRPM query, and parses the reply. If the terminal supports
  // it, the Compositor wraps each redraw batch in BSU/ESU so the user
  // sees a single atomic frame instead of erase→write→redraw flicker.
  // Any typeahead bytes that arrived during the probe are saved and
  // re-emitted to the editor below so a fast-typing user doesn't lose
  // a keystroke. Disabled (and detection is skipped) when MINIMAL_AGENT_NO_SYNC=1.
  const syncProbe =
    process.env.MINIMAL_AGENT_NO_SYNC === "1"
      ? { syncOutput: false, unparsed: "" }
      : await detectSynchronizedOutput(process.stdin as any, process.stdout as any)

  // Resolve PUA Nerd-Font glyph cell width. Precedence:
  //   env MINIMAL_AGENT_NERD_GLYPH_CELLS  >  config.nerdGlyphCells  >  probe
  //
  // The env / config values "1" and "2" force the width without probing.
  // "auto" (or unset) runs the probe; on probe failure / non-TTY / inside
  // tmux the module default (`1`) survives. We re-use stdin in raw mode
  // here -- detectSynchronizedOutput already raw'd it -- and chain the
  // probes with `alreadyRaw: true` so we don't double-toggle.
  const envCells = process.env.MINIMAL_AGENT_NERD_GLYPH_CELLS
  const cfgCells = userConfig.nerdGlyphCells
  let nerdProbeUnparsed = ""
  if (envCells === "1" || cfgCells === 1) {
    setNerdGlyphCells(1)
  } else if (envCells === "2" || cfgCells === 2) {
    setNerdGlyphCells(2)
  } else if (envCells === undefined || envCells === "auto" || cfgCells === "auto") {
    const r = await probeNerdGlyphCells(process.stdin as any, process.stdout as any, {
      alreadyRaw: true,
    })
    nerdProbeUnparsed = r.unparsed
    // r.cells is null on failure → module-level default (`1`) is preserved.
  } else if (envCells === "0" || envCells === "off" || envCells === "false") {
    // Treat falsy values as "skip probe, keep default" -- matches
    // MINIMAL_AGENT_NO_SYNC's stance for the sync probe.
    // (No-op: setNerdGlyphCells not called.)
  } else {
    // Unrecognized value: fall through to probe (don't break startup on a typo).
    const r = await probeNerdGlyphCells(process.stdin as any, process.stdout as any, {
      alreadyRaw: true,
    })
    nerdProbeUnparsed = r.unparsed
  }

  // Two-phase wiring: the StdioInterceptor needs a compositor to forward
  // intercepted writes to, and the Compositor needs an output that
  // bypasses the interceptor (so its own escape sequences don't recurse).
  // We give the compositor an adapter whose write() goes through the
  // interceptor's raw-write escape hatch when available.
  let interceptorRef: import("../ui/stdio-interceptor.ts").StdioInterceptor | null = null
  const compositor = new Compositor({
    output: {
      isTTY: process.stdout.isTTY,
      get columns() {
        return process.stdout.columns
      },
      get rows() {
        return process.stdout.rows
      },
      write: (s: string) => {
        if (interceptorRef) {
          return interceptorRef.rawStdoutWrite(s) as boolean
        }
        return process.stdout.write(s)
      },
    } as any,
    syncOutput: syncProbe.syncOutput,
  })
  const interceptor = new StdioInterceptor(compositor)
  interceptorRef = interceptor

  const continuationPrompt = process.env.MINIMAL_AGENT_CONTINUATION_PROMPT ?? "  "
  const showHiddenCharsInit =
    process.env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS === "1" ||
    args.includes("--show-hidden-chars") ||
    (modeManager?.editorShowHidden() ?? false)
  const editor = new EditorController({
    prompt: `${c.bold(c.pink("❯"))} `,
    continuationPrompt,
    compositor,
    maxLiveHeight: () => Math.max(2, Math.floor((process.stdout.rows ?? 24) / 2)),
    showHidden: showHiddenCharsInit,
    // Pass the plugin hooks facade so the editor can emit `editor.key`
    // for ArrowUp / ArrowDown / Ctrl+R. Plugins (notably `history`)
    // subscribe via their manifest's `hooks` array. Null when no
    // plugins are loaded — the editor short-circuits the emit.
    ...(hasPlugins ? { hooks: loader.hooks() } : {}),
  })
  // Media ingestion: a dropped image path (or an empty paste while an image
  // sits on the clipboard) becomes a `[Image #id WxH size]` token instead of
  // literal text. The submit path (agent.run) resolves the token to an image
  // block. See src/media/paste-intercept.ts.
  editor.setPasteInterceptor((pasted) => mediaPasteInterceptor(pasted))
  // Ctrl+V: pull the system clipboard ourselves. Prefer an image (the
  // interceptor's empty-paste branch captures a clipboard image and returns
  // an `[Image #id …]` token); else paste clipboard text. This covers
  // terminals/OSes where Cmd+V is swallowed and never reaches us.
  editor.setClipboardPasteHandler(() => mediaPasteInterceptor("") ?? clipboardText())
  // Restore the unsent draft (if any) into the editor buffer. This is
  // the resume-time twin of the abort-flow's setBuffer call in
  // `agent.ts` (search "setBuffer" in the abort branch) — same visual
  // idiom: the user sees a populated input with their text, cursor at
  // end, ready to edit or press Enter. The corresponding hint line
  // above the editor was emitted as part of the resume block (see
  // `pendingDraft` handling in `main()`). Safe before
  // `editor.start()` because `setBuffer` only paints when
  // `this.started` is true; the buffer state is captured and the
  // first repaint shows the prefilled text.
  if (pendingDraft !== null) {
    editor.setBuffer(pendingDraft)
  }
  // Keep show-hidden in sync with mode changes: a mode with
  // `editorShowHidden: true` overrides the env-var/flag baseline.
  if (modeManager) {
    const showHiddenBase =
      process.env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS === "1" || args.includes("--show-hidden-chars")
    modeManager.subscribe((_active) => {
      editor.setShowHidden(showHiddenBase || (modeManager.editorShowHidden() ?? false))
    })
  }
  const onResize = () => {
    compositor.notifyResize()
    editor.notifyResize()
    // Broadcast on the plugin event bus so live-area slots that
    // declare `refreshOn: ["terminal.resize"]` can re-fire their
    // handler off-cycle and reflow. We pass the new cols/rows in
    // the payload for any plugin that wants to skip a refresh when
    // only one dimension changed.
    //
    // This is the "high-level resize notification" the quota-status
    // plugin subscribes to — it must NOT install its own
    // `process.stdout.on("resize", ...)` listener (low-level SIGWINCH
    // ownership lives here and only here, so the order of
    // `notifyResize()` → bus emit stays deterministic).
    const cols = typeof process.stdout.columns === "number" ? process.stdout.columns : 0
    const rows = typeof process.stdout.rows === "number" ? process.stdout.rows : 0
    getGlobalEventBus()?.emit("terminal.resize", { cols, rows })
  }
  process.stdout.on("resize", onResize)

  // Auto-ASK: silently flip into ASK mode when the editor buffer reads
  // like a question, revert on action verbs, never override a manual
  // Shift+Tab. Opt-out via `MINIMAL_AGENT_AUTO_ASK=0` or `autoAsk:false`
  // in the user config. Only wires up when an "ask" mode actually
  // exists in the active manifest set (otherwise: dead code).
  if (modeManager && modeManager.list().some((m) => m.id === "ask")) {
    const envOff = process.env.MINIMAL_AGENT_AUTO_ASK === "0"
    const cfgOff = userConfig.autoAsk === false
    if (!envOff && !cfgOff) {
      // Controller installs itself on the editor; the reference is intentionally
      // not retained — it lives until the editor is destroyed.
      void new AutoAskController(editor, modeManager, {
        logger:
          process.env.DEBUG === "1" ? (m) => process.stderr.write(`[auto-ask] ${m}\n`) : undefined,
      })
    }
  }

  // Install AFTER the editor is built but BEFORE handing control to
  // runRepl: from this point on, every console.log / console.error /
  // direct stderr.write goes through the compositor and respects the
  // live area.
  interceptor.install()

  try {
    await repl(agent, {
      formatterCmd,
      auth,
      spinner,
      useLiveArea: true,
      compositor,
      editor,
      // Forward typeahead bytes captured by EITHER probe (DECRPM and the
      // Nerd-glyph CPR probe) so a fast-typing user's first keystroke
      // isn't lost. Order: sync probe first (ran first), then nerd probe.
      initialStdinBytes: syncProbe.unparsed + nerdProbeUnparsed,
      // Threaded into the goodbye banner's `--resume <id>` hint. Empty
      // string when not yet initialized; runReplLiveArea degrades the
      // closer copy in that case.
      sessionId: getSessionId(),
      scrollbackSubmittedAt: userConfig.scrollback?.submittedAt,
    })
  } finally {
    interceptor.uninstall()
    process.stdout.off("resize", onResize)
  }
}
