export type OverlayKey =
  | { name: "up" }
  | { name: "down" }
  | { name: "left" }
  | { name: "right" }
  | { name: "enter" }
  | { name: "escape" }
  | { name: "tab" }
  | { name: "char"; ch: string }
  | { name: "ctrl"; ch: string }

export interface LiveOverlay {
  /** Render top-to-bottom rows for the live area. */
  render(width: number): string[]
  /** Handle a normalized key. */
  onKey(key: OverlayKey): "stay" | { close: true; result: unknown }
  /** Optional rows hint for live-area sizing. */
  rowsHint?(): number
}
