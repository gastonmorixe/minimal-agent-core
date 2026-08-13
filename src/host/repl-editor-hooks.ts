/**
 * Host-side editor channel wiring used by the live-area REPL.
 *
 * Extracted from `repl-live-area.ts` so that file stays under the
 * max-lines budget. Registers the plugin → editor bridge channels:
 * buffer set, footer overlay, buffer styles, and modal overlay
 * open/close.
 */

import { FOOTER_LAYER_OVERLAY, FOOTER_PRIORITY_OVERLAY } from "./editor-controller.ts"
import { Picker, type PickerItem } from "./ui/picker.ts"

/** Minimal editor surface the hooks touch. */
export interface EditorHooksEditor {
  setBuffer?: (text: string) => void
  setFooterLines?: (lines: string[]) => void
  setFooterLayer?: (id: string, lines: string[], opts?: { priority?: number }) => void
  clearFooterLayer?: (id: string) => void
  setBufferStyles?: (spans: Array<{ start: number; end: number; style: string }>) => void
  setBufferStyleLayer?: (
    source: string,
    spans: Array<{ start: number; end: number; style: string }>,
  ) => void
  openOverlay?: (owner: string) => void
  closeOverlay?: (owner: string) => void
  isOverlayOwner?: (owner: string) => boolean
  setPrompt?: (prompt: string, continuationPrompt?: string) => void
}

/**
 * Minimal loader surface (hooks facade). Kept deliberately loose so the
 * real PluginLoader.hooks() facade is assignable without coupling this
 * helper to ListenOpts / CallerKind. Parameter types stay as `any` so the
 * concrete hooks facade (stricter opts + typed payload generics) remains
 * assignable under TypeScript's function parameter checking.
 */
export interface EditorHooksLoader {
  hooks(): {
    on: (channel: string, listener: (...args: any[]) => unknown, opts: any) => unknown
    emitChain: <T>(
      channel: string,
      payload: T,
    ) => Promise<{
      payload: T
      halted?: boolean
    }>
  }
}

/**
 * Register host listeners that bridge plugin bus channels onto the editor
 * controller. No-op when `loader` is nullish.
 */
export function registerEditorPluginHooks(
  loader: EditorHooksLoader | null | undefined,
  editor: EditorHooksEditor,
  basePrompt: (() => { prompt: string; continuationPrompt?: string }) | null = null,
  onPromptOverride:
    | ((prompt: { prompt: string; continuationPrompt?: string } | null) => void)
    | null = null,
): void {
  if (!loader) return
  let pickerOwner: string | null = null
  let promptOwner: string | null = null

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

  // CRITICAL: route to the dedicated overlay footer layer, NOT the default
  // layer. Default is owned by FooterAggregator (quota row). Overlay sits
  // above it; ARMED (Ctrl+C confirm) still wins over both.
  loader.hooks().on(
    "editor.footer.set",
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const p = payload as { lines?: unknown }
      if (!Array.isArray(p.lines)) return
      if (!p.lines.every((l) => typeof l === "string")) return
      const lines = p.lines as string[]
      // Dynamic import keeps the agent free of editor-controller module
      // references when no plugins ever emit on this channel.
      import("./editor-controller.ts")
        .then(({ FOOTER_LAYER_OVERLAY, FOOTER_PRIORITY_OVERLAY }) => {
          if (lines.length === 0) {
            if (typeof editor.clearFooterLayer === "function") {
              editor.clearFooterLayer(FOOTER_LAYER_OVERLAY)
            }
            return
          }
          if (typeof editor.setFooterLayer === "function") {
            editor.setFooterLayer(FOOTER_LAYER_OVERLAY, lines, {
              priority: FOOTER_PRIORITY_OVERLAY,
            })
          } else if (typeof editor.setFooterLines === "function") {
            editor.setFooterLines(lines)
          }
        })
        .catch(() => {
          if (typeof editor.setFooterLines === "function") {
            editor.setFooterLines(lines)
          }
        })
    },
    { caller: "agent", priority: 5000, label: "agent:editor.footer.set" },
  )

  // Plugins (e.g. intercom at-mentions, slash-menu tokens) paint SGR spans
  // over the live input. Payload `{spans, source?}` with code-point offsets.
  // `source` scopes the spans to one producer so concurrent plugins compose
  // instead of last-writer-wins; omit it to use the default layer. Empty
  // spans clear that source only. Validated before hand-off so a malformed
  // emit can't poison the renderer.
  loader.hooks().on(
    "editor.buffer.styles",
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const p = payload as { spans?: unknown; source?: unknown }
      if (!Array.isArray(p.spans)) return
      const spans: Array<{ start: number; end: number; style: string }> = []
      for (const raw of p.spans) {
        if (!raw || typeof raw !== "object") return
        const s = raw as { start?: unknown; end?: unknown; style?: unknown }
        if (typeof s.start !== "number" || typeof s.end !== "number") return
        if (typeof s.style !== "string") return
        if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) return
        spans.push({ start: s.start, end: s.end, style: s.style })
      }
      const source = typeof p.source === "string" && p.source.length > 0 ? p.source : undefined
      if (source !== undefined && typeof editor.setBufferStyleLayer === "function") {
        editor.setBufferStyleLayer(source, spans)
        return
      }
      if (typeof editor.setBufferStyles === "function") editor.setBufferStyles(spans)
    },
    { caller: "agent", priority: 5000, label: "agent:editor.buffer.styles" },
  )

  loader.hooks().on(
    "editor.prompt.set",
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const p = payload as { owner?: unknown; prompt?: unknown; continuationPrompt?: unknown }
      if (
        typeof p.owner !== "string" ||
        typeof p.prompt !== "string" ||
        (p.continuationPrompt !== undefined && typeof p.continuationPrompt !== "string") ||
        !editor.isOverlayOwner?.(p.owner)
      ) {
        return
      }
      promptOwner = p.owner
      const prompt = {
        prompt: p.prompt,
        ...(p.continuationPrompt === undefined ? {} : { continuationPrompt: p.continuationPrompt }),
      }
      onPromptOverride?.(prompt)
      editor.setPrompt?.(prompt.prompt, prompt.continuationPrompt)
    },
    { caller: "agent", priority: 5000, label: "agent:editor.prompt.set" },
  )
  loader.hooks().on(
    "editor.prompt.clear",
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const owner = (payload as { owner?: unknown }).owner
      if (typeof owner !== "string" || owner !== promptOwner) return
      promptOwner = null
      onPromptOverride?.(null)
      const base = basePrompt?.()
      if (base) editor.setPrompt?.(base.prompt, base.continuationPrompt)
    },
    { caller: "agent", priority: 5000, label: "agent:editor.prompt.clear" },
  )

  loader.hooks().on(
    "editor.picker.set",
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const p = payload as {
        owner?: unknown
        title?: unknown
        rows?: unknown
        selected?: unknown
        footer?: unknown
      }
      if (
        typeof p.owner !== "string" ||
        p.owner.length === 0 ||
        !editor.isOverlayOwner?.(p.owner) ||
        !Array.isArray(p.rows)
      ) {
        return
      }
      if (p.title !== undefined && typeof p.title !== "string") return
      if (p.footer !== undefined && typeof p.footer !== "string") return
      if (typeof p.selected !== "number" || !Number.isInteger(p.selected)) return
      const items: PickerItem<string>[] = []
      for (const row of p.rows) {
        if (!row || typeof row !== "object") return
        const r = row as { id?: unknown; label?: unknown; hint?: unknown; disabled?: unknown }
        if (typeof r.id !== "string" || typeof r.label !== "string") return
        if (r.hint !== undefined && typeof r.hint !== "string") return
        if (r.disabled !== undefined && typeof r.disabled !== "boolean") return
        items.push({
          value: r.id,
          label: r.label,
          ...(r.hint === undefined ? {} : { hint: r.hint }),
          ...(r.disabled === undefined ? {} : { disabled: r.disabled }),
        })
      }
      pickerOwner = p.owner
      const picker = new Picker({
        items,
        initial: p.selected,
        ...(p.title === undefined ? {} : { title: p.title }),
        ...(p.footer === undefined ? {} : { footer: p.footer }),
      })
      // Picker width is finalized by the compositor at paint time. The footer
      // layer accepts rendered rows, and plugins re-emit on selection changes.
      const lines = picker.render(process.stdout.columns ?? 80)
      if (editor.setFooterLayer) {
        editor.setFooterLayer(FOOTER_LAYER_OVERLAY, lines, { priority: FOOTER_PRIORITY_OVERLAY })
      } else {
        editor.setFooterLines?.(lines)
      }
    },
    { caller: "agent", priority: 5000, label: "agent:editor.picker.set" },
  )
  loader.hooks().on(
    "editor.picker.clear",
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const owner = (payload as { owner?: unknown }).owner
      if (typeof owner !== "string" || owner.length === 0 || owner !== pickerOwner) return
      pickerOwner = null
      if (editor.clearFooterLayer) {
        editor.clearFooterLayer(FOOTER_LAYER_OVERLAY)
      } else {
        editor.setFooterLines?.([])
      }
    },
    { caller: "agent", priority: 5000, label: "agent:editor.picker.clear" },
  )

  // Interactive command TUIs (/config, /usage) take MODAL ownership of the
  // input line. Payload `{owner}` is the opening plugin's id.
  loader.hooks().on(
    "editor.overlay.open",
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const owner = (payload as { owner?: unknown }).owner
      if (typeof owner !== "string" || owner.length === 0) return
      editor.openOverlay?.(owner)
    },
    { caller: "agent", priority: 5000, label: "agent:editor.overlay.open" },
  )
  loader.hooks().on(
    "editor.overlay.close",
    (payload: unknown) => {
      if (!payload || typeof payload !== "object") return
      const owner = (payload as { owner?: unknown }).owner
      if (typeof owner !== "string" || owner.length === 0) return
      editor.closeOverlay?.(owner)
    },
    { caller: "agent", priority: 5000, label: "agent:editor.overlay.close" },
  )
}

/**
 * Run the `turn.willStart` chain so plugins can rewrite model-facing text
 * (e.g. expand at-mentions to peer XML) without changing scrollback.
 *
 * Returns the (possibly rewritten) text and whether a listener halted.
 * Never throws: chain failures log to stderr and pass the original text.
 */
export async function applyTurnWillStart(
  loader: EditorHooksLoader | null | undefined,
  text: string,
): Promise<{ text: string; halted: boolean }> {
  if (!loader) return { text, halted: false }
  try {
    const result = await loader.hooks().emitChain<{ text: string }>("turn.willStart", { text })
    let next = text
    if (
      result &&
      typeof result.payload === "object" &&
      result.payload !== null &&
      typeof (result.payload as { text?: unknown }).text === "string"
    ) {
      next = (result.payload as { text: string }).text
    }
    return { text: next, halted: result?.halted === true }
  } catch (e) {
    process.stderr.write(
      `[repl] turn.willStart chain failed: ${e instanceof Error ? e.message : String(e)}\n`,
    )
    return { text, halted: false }
  }
}
