/**
 * Operating-mode system.
 *
 * A "mode" is a lightweight UX state on top of the agent. When active, a mode
 * can:
 *
 * 1. Append a system-prompt fragment so the model behaves differently
 *    (e.g. ASK mode instructs the model to refuse Edit/Write tools and
 *    answer questions directly).
 * 2. Filter the tool list visible to the model. The disallowed tools are
 *    *literally not sent* to the API — the model never sees them.
 * 3. Re-skin the REPL prompt prefix (e.g. `ASK ❯ ` in blue).
 * 4. Re-skin the agent status spinner ("Asking..." instead of "Thinking...").
 *
 * Modes are mutually exclusive — at most one is active. Cycling
 * (Shift+Tab in the REPL) walks the list `[no-mode, mode-1, mode-2, ...]`.
 *
 * The {@link ModeManager} is the single source of truth for the active mode
 * within an agent process. It is shared between the {@link Agent} (which
 * reads the mode when assembling each request) and the REPL (which reads
 * the mode to render the prompt and status text).
 *
 * Spec / motivation: the agent project is moving toward "everything is a
 * plugin". Modes follow the same pattern — they are declared in
 * `manifest.json` files alongside `tuis`. See {@link ManifestMode}.
 *
 * @module modes
 */

import type { ManifestMode } from "./plugins/types.ts"
import type { ContentBlock } from "./client.ts"
import { c } from "./agent.ts"
import {
  clampLabel,
  detectStyleEnv,
  paint,
  resolveModeStyle,
  styleFromLegacyColor,
  type ResolvedModeStyle,
  type ResolvedSurfaceStyle,
  type StyleEnv,
} from "./mode-style.ts"

/**
 * Subscriber callback notified whenever the active mode changes.
 *
 * Receives the new active mode (or `null` when no mode is active).
 */
export type ModeChangeListener = (active: ManifestMode | null) => void

/**
 * Color helpers indexed by the manifest's `color` field.
 *
 * Falls back to {@link c.cyan} for unknown values. Kept in sync with
 * `VALID_MODE_COLORS` in `plugins/manifest.ts`.
 */
const COLOR_HELPERS: Record<string, (s: string) => string> = {
  cyan: c.cyan,
  blue: c.blue,
  magenta: c.magenta,
  yellow: c.yellow,
  green: c.green,
  red: c.red,
  pink: c.pink,
  purple: c.purple,
  orange: c.orange,
  sky: c.sky,
  lime: c.lime,
  gold: c.gold,
}

/** Default fallback when a mode declares no `statusLabel`. */
function defaultStatusLabel(mode: ManifestMode): string {
  if (mode.statusLabel) return mode.statusLabel
  // ASK -> "Asking", PLAN -> "Planning", etc. We just append "ing" if the
  // label looks verb-like; for arbitrary labels we punt to "Working".
  const label = (mode.label ?? mode.id).toLowerCase()
  if (label.endsWith("e")) return capitalize(label.slice(0, -1) + "ing")
  if (/^[a-z]+$/.test(label)) return capitalize(label + "ing")
  return "Working"
}

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s[0].toUpperCase() + s.slice(1)
}

/**
 * Mutable holder of the active mode plus the list of available modes.
 *
 * Construct once per agent process and share between the {@link Agent} and
 * the REPL. The agent reads {@link active} on each request to mutate the
 * outgoing system prompt and tool list. The REPL reads it to render the
 * prompt and status spinner.
 *
 * @example
 * ```ts
 * const mgr = new ModeManager(loader.getModes(), loader.getDefaultModeId());
 * mgr.subscribe((mode) => console.log("active:", mode?.id ?? "(none)"));
 * mgr.cycleNext(); // walks no-mode -> mode-1 -> mode-2 -> no-mode
 * ```
 */
export class ModeManager {
  private readonly modes: ManifestMode[]
  /** Index into {@link modes}, or -1 for "no mode". */
  private idx: number
  private readonly listeners = new Set<ModeChangeListener>()
  private readonly env: StyleEnv
  /** Resolved style cache, one entry per mode in {@link modes}. */
  private readonly resolvedCache: (ResolvedModeStyle | null)[]
  /**
   * Mode the model was last *told* about (via a `<mode-change>` attachment
   * consumed by {@link consumePendingAttachment}). May lag {@link active}
   * between a Shift+Tab toggle and the next outgoing user message. `null`
   * means "the model has not yet been told any mode" (= default / no mode).
   *
   * Only `consumePendingAttachment` updates this field. `cycleNext`,
   * `cyclePrev`, and `setMode` deliberately do NOT touch it — toggling
   * modes is free until the next user turn ships an attachment.
   */
  private lastAdvertisedModeId: string | null = null
  /**
   * Mode that was active immediately before the most recent change.
   * Captured by `setMode`, `cycleNext`, `cyclePrev`. Used to render
   * `<mode-change from="…" to="…" />` when the next user turn assembles.
   */
  private prevModeId: string | null = null
  /**
   * One-shot guard for the {@link systemPromptAddition} deprecation
   * warning. We emit it at most once per process so a tight tool loop
   * doesn't spam stderr.
   */
  private warnedSystemPromptAppend = false

  /**
   * @param modes - The list of available modes (in cycle order).
   * @param defaultModeId - Optional id of the mode to start in. When the id
   *   is unknown or omitted, the manager starts with no active mode.
   * @param env - Style resolver environment. Defaults to {@link detectStyleEnv}.
   */
  constructor(modes: ManifestMode[], defaultModeId?: string | null, env?: StyleEnv) {
    this.modes = [...modes]
    this.idx = -1
    this.env = env ?? detectStyleEnv()
    this.resolvedCache = this.modes.map((m) => {
      const req = m.style ?? styleFromLegacyColor(m.color)
      return req ? resolveModeStyle(req, this.env) : null
    })
    if (defaultModeId) {
      const i = this.modes.findIndex((m) => m.id === defaultModeId)
      if (i !== -1) this.idx = i
    }
  }

  /** True if the manager has any modes available. */
  hasModes(): boolean {
    return this.modes.length > 0
  }

  /** Active mode, or `null` when none is selected. */
  active(): ManifestMode | null {
    return this.idx === -1 ? null : this.modes[this.idx]
  }

  /** All modes available to cycle through. */
  list(): ManifestMode[] {
    return [...this.modes]
  }

  /**
   * Subscribe to mode-change notifications. Returns an unsubscribe handle.
   * Listeners are invoked synchronously after a successful change.
   */
  subscribe(listener: ModeChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Set the active mode by id, or pass `null` to clear it.
   *
   * Returns `true` if the requested mode existed (or was `null`) and the
   * change took effect. An unknown id is a silent no-op returning `false`.
   */
  setMode(id: string | null): boolean {
    if (id === null) {
      if (this.idx === -1) return true
      this.prevModeId = this.activeId()
      this.idx = -1
      this.notify()
      return true
    }
    const i = this.modes.findIndex((m) => m.id === id)
    if (i === -1) return false
    if (this.idx === i) return true
    this.prevModeId = this.activeId()
    this.idx = i
    this.notify()
    return true
  }

  /**
   * Move forward in the cycle: `no-mode -> modes[0] -> modes[1] -> ... -> no-mode`.
   * Returns the new active mode (or `null` for no-mode).
   */
  cycleNext(): ManifestMode | null {
    if (this.modes.length === 0) return null
    this.prevModeId = this.activeId()
    if (this.idx === this.modes.length - 1) {
      this.idx = -1
    } else {
      this.idx += 1
    }
    this.notify()
    return this.active()
  }

  /**
   * Move backward in the cycle. Useful when bound to Ctrl+Shift+Tab. Returns
   * the new active mode (or `null` for no-mode).
   */
  cyclePrev(): ManifestMode | null {
    if (this.modes.length === 0) return null
    this.prevModeId = this.activeId()
    if (this.idx === -1) {
      this.idx = this.modes.length - 1
    } else if (this.idx === 0) {
      this.idx = -1
    } else {
      this.idx -= 1
    }
    this.notify()
    return this.active()
  }

  /**
   * Convenience: id of the currently active mode, or `null` for no mode.
   * Mirror of {@link active}().id without the optional-chaining ceremony.
   */
  activeId(): string | null {
    return this.active()?.id ?? null
  }

  /**
   * Dispatch-time tool gate. Replaces the old `filterTools` (which used
   * to delete disallowed tools from the request body — that mutated the
   * cached prefix on every mode toggle and burned the prompt cache).
   *
   * Tools are now ALWAYS registered in the request. The agent's tool
   * loop calls this method right before invoking each `tool_use` block;
   * if `allowed: false`, the loop synthesizes a structured `is_error:
   * true` `tool_result` with the returned `message` and skips execution.
   * The model sees the rejection in its next round and adapts.
   *
   * Returns `{ allowed: true }` when there is no active mode, when the
   * active mode declares no `disallowedTools`, or when the requested
   * tool is not on the deny list.
   */
  isToolAllowed(toolName: string): { allowed: true } | { allowed: false; message: string } {
    const m = this.active()
    if (!m?.disallowedTools || m.disallowedTools.length === 0) {
      return { allowed: true }
    }
    if (!m.disallowedTools.includes(toolName)) return { allowed: true }
    const label = (m.label ?? m.id).toUpperCase()
    const head = `Tool "${toolName}" is not permitted in ${label} mode.`
    const tail = m.refusalHint ? ` ${m.refusalHint}` : ""
    return { allowed: false, message: `${head}${tail}` }
  }

  /**
   * Activation-signal channel.
   *
   * If the active mode differs from the one the model was last told
   * about (via a previously-consumed attachment), returns a small
   * `<mode-change from="…" to="…" />` text content block to prepend to
   * the next outgoing user message. If active === lastAdvertised,
   * returns `null` and emits nothing.
   *
   * The block is intentionally minimal: the policy / behavior text for
   * each mode lives permanently in the cached `pluginBlock` (each mode
   * plugin's `PROMPT.md`), so the attachment only needs to carry the
   * activation pointer. Riding the user-turn boundary keeps it inside
   * the rolling-tail breakpoint that's invalidated every turn anyway —
   * mode toggles cost zero additional cache.
   *
   * Idempotent: consuming twice without an intervening toggle returns
   * `null` the second time. Also safe to call when no plugins/modes are
   * loaded — just always returns `null`.
   *
   * @returns A `text` content block to prepend to the next user message,
   *   or `null` if no advertisement is needed.
   */
  consumePendingAttachment(): ContentBlock | null {
    const currentId = this.activeId()
    if (currentId === this.lastAdvertisedModeId) return null
    const from = this.lastAdvertisedModeId ?? "default"
    const to = currentId ?? "default"
    this.lastAdvertisedModeId = currentId
    return {
      type: "text",
      text: `<mode-change from="${from}" to="${to}" />`,
    }
  }

  /**
   * Mode active immediately before the most recent toggle. Useful for
   * UI ("you exited ASK and are back in $prev") and for symmetric
   * restore semantics in future modes that nest. Returns `null` when
   * there has been no toggle yet, or when the previous state was
   * "no mode active".
   */
  previousModeId(): string | null {
    return this.prevModeId
  }

  /**
   * @deprecated Use {@link isToolAllowed} at dispatch time instead.
   * Kept for one release as a no-op pass-through so external callers
   * don't crash; tools are no longer filtered out of the request body.
   * Will be removed in v2.2.
   */
  filterTools<T extends { name: string }>(tools: T[]): T[] {
    return tools
  }

  /**
   * @deprecated Mode behavior text should live in the plugin's own
   * `PROMPT.md` (which is part of the cached `pluginBlock`). Splicing
   * `systemPromptAppend` into `sys[3]` invalidates the prompt cache on
   * every mode toggle. This method now returns `""` and warns once per
   * process if any active mode declares the deprecated field.
   * Will be removed in v2.2.
   */
  systemPromptAddition(): string {
    const m = this.active()
    if (m?.systemPromptAppend && !this.warnedSystemPromptAppend) {
      this.warnedSystemPromptAppend = true
      console.error(
        `  \x1b[33m⚠\x1b[0m mode "${m.id}" declares deprecated ` +
          `\`systemPromptAppend\` — move the text to the plugin's ` +
          `PROMPT.md so the system-prompt cache survives toggles. ` +
          `(see ManifestMode.systemPromptAppend JSDoc)`,
      )
    }
    return ""
  }

  /**
   * Whether the active mode requests visible rendering of invisible editor
   * characters (spaces as `·`, tabs as `→`, line-ends as `↵`).
   *
   * Returns `false` when no mode is active or the active mode does not
   * set `editorShowHidden: true`.
   */
  editorShowHidden(): boolean {
    return this.active()?.editorShowHidden ?? false
  }

  /**
   * The status spinner label to use while the agent is awaiting a response.
   *
   * @param fallback - Label to use when no mode is active. Typically "Thinking".
   */
  statusLabel(fallback: string): string {
    const m = this.active()
    if (!m) return fallback
    return defaultStatusLabel(m)
  }

  /**
   * REPL prompt prefix string, including a trailing space.
   *
   * Ends in the `❯ ` arrow with the mode label colored when a mode is
   * active. When no mode is active, returns the bare arrow so existing UI
   * looks unchanged.
   *
   * The arrow surface is *also* mode-styleable: if `style.arrow.fg` is set
   * the arrow is repainted with that color (this is what lets ASK opt into
   * a blue arrow next to the blue `ASK` label). If the mode does not
   * request an arrow color, the caller's pre-styled `baseArrow` is reused.
   *
   * @param baseArrow - Default pre-styled arrow including trailing space
   *   (e.g. `${pink("❯")} `). Used as-is when no mode requests a restyle.
   * @param arrowGlyph - Raw glyph used to rebuild the arrow when the mode
   *   restyles it. Defaults to `"❯"`.
   */
  promptPrefix(baseArrow: string, arrowGlyph = "❯"): string {
    const m = this.active()
    if (!m) return baseArrow
    const resolved = this.resolvedCache[this.idx]
    const label = clampLabel((m.label ?? m.id).toUpperCase())
    const labelStyle = resolved?.label ?? null
    const arrowStyle = resolved?.arrow ?? null

    const paintedLabel = labelStyle
      ? paint(label, { ...labelStyle, bold: labelStyle.bold || true })
      : c.bold(label)

    const arrow =
      arrowStyle && arrowStyle.fgOpen
        ? `${paint(arrowGlyph, { ...arrowStyle, bold: arrowStyle.bold || true })} `
        : baseArrow

    return `${paintedLabel} ${arrow}`
  }

  /**
   * Resolved style for the active mode, or `null` when no mode is active or
   * the active mode declared no style.
   */
  resolved(): ResolvedModeStyle | null {
    if (this.idx === -1) return null
    return this.resolvedCache[this.idx]
  }

  /**
   * Resolved style for the status spinner surface, or `null` when no mode
   * is active or the mode does not contribute a style.
   */
  statusStyle(): ResolvedSurfaceStyle | null {
    return this.resolved()?.status ?? null
  }

  /**
   * Color helper for the active mode (defaults to {@link c.cyan}). Useful
   * when the REPL wants to color the spinner accent or other small UI bits
   * via the legacy `c.*` helper signature.
   *
   * @deprecated Prefer {@link statusStyle} or {@link resolved} so callers
   * also get bold/dim/bg, not just a fg-only function.
   */
  color(): (s: string) => string {
    const m = this.active()
    if (!m) return c.cyan
    return COLOR_HELPERS[m.color ?? "cyan"] ?? c.cyan
  }

  private notify(): void {
    const a = this.active()
    for (const l of this.listeners) l(a)
  }
}
