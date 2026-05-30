/**
 * Host-side implementation of {@link AskUserFn} for the live-area REPL.
 *
 * The agent's preflight pipeline produces a {@link PreflightIssue} and
 * hands it to a host-provided `askUser` callback. This module builds
 * that callback: it constructs a {@link ChoiceModal}, paints it into
 * the editor's footer overlay layer, captures keystrokes via the
 * `editor.key` hook chain (high priority so it beats every plugin),
 * and resolves the returned promise with the user's choice.
 *
 * Why the `editor.key` hook chain (not InputCaptureStack): the stack
 * only sees Esc. The modal needs ALL keys (arrow keys, Enter, Tab,
 * letters for shortcuts). The hook chain dispatches every keystroke
 * and lets a listener swallow it by setting `payload.result.halt = true`,
 * which is exactly what the modal wants.
 *
 * Hot-path safety:
 *  - The hook listener is registered at priority 9999 so plugins
 *    (slash-menu, history, autocomplete) can't preempt the modal.
 *  - Every key is halted while the modal is up so the user can't type
 *    into the editor buffer underneath.
 *  - On resolution OR rejection the listener is disposed and the
 *    footer layer is cleared, so the next paint reveals the prompt.
 *  - If the listener somehow misses a key (e.g. the underlying
 *    EventBus throws), the promise stays pending : test coverage
 *    asserts the dispose-on-resolve path so this can't silently leak.
 *
 * @module agent/ask-user-host
 */

import type { EditorKeyPayload } from "../editor-controller.ts"
import type { Hooks } from "../plugins/hooks/hooks.ts"
import { ChoiceModal } from "../ui/choice-modal.ts"
import type { OverlayKey } from "../ui/overlay.ts"

import type { AskUserFn } from "./preflight-pipeline.ts"

/**
 * Minimal slice of the editor controller the host overlay needs:
 *  - `setDecorationLines` to paint the modal in the ABOVE-prompt region
 *    (between the activity row and the input), so the modal sits at the top
 *    of the live area rather than below the prompt as a footer overlay.
 *
 * Typed as a structural interface rather than `EditorController` so the
 * tests can substitute a fake editor without dragging in compositor
 * dependencies.
 */
export interface AskUserHostEditor {
  setDecorationLines(lines: string[]): void
}

/** Minimal slice of `process.stdout` we need for width detection. */
export interface AskUserHostOutput {
  columns?: number
}

export interface CreateAskUserOpts {
  /** The host editor controller (or a structural stand-in). */
  editor: AskUserHostEditor
  /** Hooks bus so the modal can subscribe to `editor.key`. */
  hooks: Hooks
  /**
   * Output stream used to pick a render width. Defaults to
   * `process.stdout`. The modal fills the full terminal width.
   */
  output?: AskUserHostOutput
  /**
   * Optional hard cap on render width (cells). Default: none — the modal
   * spans the full terminal width. Tests pass a finite value for byte-stable
   * assertions.
   */
  maxWidth?: number
  /**
   * Pause the live activity row while the modal is up (so a stale
   * "Thinking (Ns)" doesn't keep ticking above a modal that has paused the
   * agent). Called on open; {@link resumeActivity} on close. Both optional.
   */
  pauseActivity?: () => void
  /** Restore the activity row after the modal closes. */
  resumeActivity?: () => void
}

/** Floor so the modal never renders narrower than this (its own minimum). */
const MIN_WIDTH = 40
/** Fallback width when the terminal width is unknown (non-TTY). */
const FALLBACK_WIDTH = 80

/**
 * Build an {@link AskUserFn} bound to a specific editor + hooks bus.
 * The returned function may be called many times in a session : each
 * call opens its OWN modal, registers its OWN listener, and tears down
 * before resolving. Concurrent calls are not supported (the second
 * call's modal would paint over the first); the agent loop is
 * single-flight so this isn't a real-world concern.
 */
export function createAskUserHost(opts: CreateAskUserOpts): AskUserFn {
  const { editor, hooks } = opts
  const out = opts.output ?? (process.stdout as AskUserHostOutput)
  const cap = opts.maxWidth ?? Number.POSITIVE_INFINITY

  return (issue) =>
    new Promise<string | null>((resolve) => {
      const modal = new ChoiceModal({
        title: issue.title,
        body: issue.detail,
        options: issue.options.map((o) => ({
          id: o.id,
          label: o.label,
          ...(o.description !== undefined ? { description: o.description } : {}),
          ...(o.destructive !== undefined ? { destructive: o.destructive } : {}),
        })),
        defaultIndex: issue.options.findIndex((o) => o.isDefault === true),
      })

      // Full terminal width by default (capped only if a caller asked).
      const width = (): number => Math.min(cap, Math.max(MIN_WIDTH, out.columns ?? FALLBACK_WIDTH))
      const paint = (): void => {
        // Paint into the ABOVE-prompt decoration band so the modal sits at the
        // top of the live area, not below the prompt + over the status footer.
        editor.setDecorationLines(modal.render(width()))
      }
      // Pause the activity row so a stale "Thinking" doesn't tick above the modal.
      opts.pauseActivity?.()
      paint()

      let disposed = false
      const dispose = hooks.on<EditorKeyPayload>(
        "editor.key",
        (payload) => {
          const key = translateEditorKey(payload.key)
          if (!key) {
            // Unhandled keys (e.g. Ctrl+V): halt anyway so the editor
            // buffer underneath doesn't receive them while the modal
            // is up. Modal's onKey() will return "stay" for unknown.
            payload.result.halt = true
            return
          }
          const r = modal.onKey(key)
          payload.result.halt = true
          if (r === "stay") {
            paint()
            return
          }
          // close
          if (disposed) return
          disposed = true
          dispose()
          editor.setDecorationLines([])
          opts.resumeActivity?.()
          const result = r.result
          resolve(typeof result === "string" || result === null ? result : null)
        },
        { caller: "agent", priority: 9999, label: "agent:askUser-modal" },
      )
    })
}

// ---------------------------------------------------------------------------
// Key translation: editor's semantic name → OverlayKey
// ---------------------------------------------------------------------------

/**
 * Translate the editor.key payload's `key` (e.g. `"Enter"`, `"Escape"`,
 * `"ArrowLeft"`, `"a"`, `"Ctrl+R"`) into the {@link OverlayKey} shape
 * the modal consumes. Returns `null` for unmappable keys so the caller
 * can decide what to do (typically: swallow them anyway while a modal
 * is up).
 *
 * Exported for unit testing.
 */
export function translateEditorKey(key: string): OverlayKey | null {
  switch (key) {
    case "Escape":
      return { name: "escape" }
    case "Enter":
      return { name: "enter" }
    case "Tab":
      return { name: "tab" }
    case "ArrowLeft":
      return { name: "left" }
    case "ArrowRight":
      return { name: "right" }
    case "ArrowUp":
      return { name: "up" }
    case "ArrowDown":
      return { name: "down" }
    default:
      // Plain printable char.
      if (key.length === 1) return { name: "char", ch: key }
      // Ctrl+X form (matches what editor uses for keyboard shortcut
      // hooks like "Ctrl+R"). Surface as a ctrl key; modal ignores
      // ctrl chars currently but the API exists for forward-compat.
      const ctrlMatch = /^Ctrl\+(.)$/i.exec(key)
      if (ctrlMatch?.[1]) return { name: "ctrl", ch: ctrlMatch[1] }
      return null
  }
}
