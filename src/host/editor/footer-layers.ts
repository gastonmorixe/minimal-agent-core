import type { FooterLayer, FooterLayerId, SetFooterLayerOptions } from "./types.ts"

/** Maintains composited footer layers and repaints only when visible output changes. */
export class FooterLayers {
  private readonly layers = new Map<FooterLayerId, FooterLayer>()
  private composed: string[] = []

  constructor(private readonly onChange: () => void) {}

  set(id: FooterLayerId, lines: string[], opts?: SetFooterLayerOptions): void {
    const previous = this.layers.get(id)
    const priority = opts?.priority ?? previous?.priority ?? 0
    if (lines.length === 0) {
      if (!previous) return
      this.layers.delete(id)
    } else {
      const unchanged =
        previous?.priority === priority &&
        previous.lines.length === lines.length &&
        previous.lines.every((line, index) => line === lines[index])
      if (unchanged) return
      this.layers.set(id, { id, priority, lines: [...lines] })
    }
    this.changed()
  }

  clear(id: FooterLayerId): void {
    if (!this.layers.delete(id)) return
    this.changed()
  }

  compose(): string[] {
    let best: FooterLayer | undefined
    for (const layer of this.layers.values()) {
      if (layer.lines.length > 0 && (!best || layer.priority > best.priority)) best = layer
    }
    return best ? [...best.lines] : []
  }

  private changed(): void {
    const next = this.compose()
    if (
      next.length === this.composed.length &&
      next.every((line, index) => line === this.composed[index])
    )
      return
    this.composed = next
    this.onChange()
  }
}
