/**
 * Per-source buffer style layers for {@link EditorController}.
 *
 * Extracted so the controller stays under the repo `max-lines` budget.
 * Multiple plugins paint concurrently (intercom mentions, slash-menu tokens);
 * each owns a {@link BufferStyleSourceId} and mutates only its own layer.
 * Composed output is the union of every non-empty layer (Bug-2801 analogue of
 * footer layers). Cleared on buffer clear / submit / overlay open-close.
 *
 * @module editor/buffer-style-layers
 */

import {
  BUFFER_STYLE_SOURCE_DEFAULT,
  type BufferStyleSourceId,
  type BufferStyleSpan,
} from "./types.ts"

function cloneSpans(spans: BufferStyleSpan[]): BufferStyleSpan[] {
  return spans.map((s) => ({ start: s.start, end: s.end, style: s.style }))
}

function spansEqual(a: BufferStyleSpan[], b: BufferStyleSpan[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p.start === b[i]!.start && p.end === b[i]!.end && p.style === b[i]!.style)
  )
}

/**
 * Owns the per-source Map and composed span list. Mutators return `true`
 * when the composed output changed so the controller can push to the
 * renderer and repaint only on real change.
 */
export class BufferStyleLayers {
  private readonly layers = new Map<BufferStyleSourceId, BufferStyleSpan[]>()
  private composed: BufferStyleSpan[] = []

  /**
   * Replace one producer's layer and recompose. Empty `spans` clears that
   * source only. Unknown empty sources are a silent no-op (`false`).
   */
  setLayer(source: BufferStyleSourceId, spans: BufferStyleSpan[]): boolean {
    const id =
      typeof source === "string" && source.length > 0 ? source : BUFFER_STYLE_SOURCE_DEFAULT
    const next = Array.isArray(spans) ? cloneSpans(spans) : []
    if (next.length === 0) {
      if (!this.layers.has(id)) return false
      this.layers.delete(id)
    } else {
      const prev = this.layers.get(id)
      if (prev !== undefined && spansEqual(prev, next)) return false
      this.layers.set(id, next)
    }
    return this.recompose()
  }

  /** Remove one producer's layer. Equivalent to `setLayer(id, [])`. */
  clearLayer(source: BufferStyleSourceId): boolean {
    return this.setLayer(source, [])
  }

  /** Drop every style layer. Returns whether composed was non-empty. */
  clearAll(): boolean {
    if (this.layers.size === 0 && this.composed.length === 0) return false
    this.layers.clear()
    this.composed = []
    return true
  }

  /** Current composed spans (copy). For tests / diagnostics. */
  getComposed(): BufferStyleSpan[] {
    return cloneSpans(this.composed)
  }

  /**
   * Current composed spans without copying. Safe for immediate renderer /
   * commit use; do not mutate.
   */
  peekComposed(): readonly BufferStyleSpan[] {
    return this.composed
  }

  private recompose(): boolean {
    const next: BufferStyleSpan[] = []
    for (const spans of this.layers.values()) {
      for (const s of spans) next.push({ start: s.start, end: s.end, style: s.style })
    }
    next.sort((a, b) => a.start - b.start || a.end - b.end)
    if (spansEqual(this.composed, next)) return false
    this.composed = next
    return true
  }
}
