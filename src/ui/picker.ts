/**
 * Generic vertical picker primitive.
 *
 * Pure data + rendering. No dependency on the compositor or terminal IO; the
 * caller owns key event delivery and writing the rendered rows to the screen.
 */

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const INVERT = "\x1b[7m"

export interface PickerItem<V = unknown> {
  label: string
  hint?: string
  value: V
  disabled?: boolean
}

export interface PickerOptions<V> {
  title?: string
  footer?: string
  items: PickerItem<V>[]
  initial?: number
  pageSize?: number
}

export type PickerKey =
  | { name: "up" }
  | { name: "down" }
  | { name: "pageup" }
  | { name: "pagedown" }
  | { name: "home" }
  | { name: "end" }
  | { name: "enter" }
  | { name: "escape" }

export type PickerResult<V> = "stay" | { close: true; result: V | null }

export class Picker<V> {
  private readonly title?: string
  private readonly footer?: string
  private readonly items: PickerItem<V>[]
  private readonly pageSize: number
  private idx: number

  constructor(opts: PickerOptions<V>) {
    this.title = opts.title
    this.footer = opts.footer
    this.items = opts.items
    this.pageSize = Math.max(1, opts.pageSize ?? 10)
    const initial = opts.initial ?? 0
    this.idx = this.clampToEnabled(initial, +1)
    if (this.idx < 0) this.idx = this.clampToEnabled(initial, -1)
  }

  get selectedIndex(): number {
    return this.idx
  }

  get selected(): PickerItem<V> | null {
    if (this.idx < 0 || this.idx >= this.items.length) return null
    const item = this.items[this.idx]
    if (!item || item.disabled) return null
    return item
  }

  /**
   * Find the next enabled item index starting from `from` in the given
   * direction. Returns -1 if none found.
   */
  private clampToEnabled(from: number, dir: 1 | -1): number {
    if (this.items.length === 0) return -1
    let i = Math.max(0, Math.min(this.items.length - 1, from))
    while (i >= 0 && i < this.items.length) {
      const it = this.items[i]
      if (it && !it.disabled) return i
      i += dir
    }
    return -1
  }

  private moveBy(delta: number): void {
    if (this.items.length === 0) return
    const dir: 1 | -1 = delta >= 0 ? 1 : -1
    let target = this.idx + delta
    target = Math.max(0, Math.min(this.items.length - 1, target))
    let next = this.clampToEnabled(target, dir)
    if (next < 0) next = this.clampToEnabled(target, -dir as 1 | -1)
    if (next >= 0) this.idx = next
  }

  onKey(key: PickerKey): PickerResult<V> {
    switch (key.name) {
      case "up":
        this.moveBy(-1)
        return "stay"
      case "down":
        this.moveBy(+1)
        return "stay"
      case "pageup":
        this.moveBy(-this.pageSize)
        return "stay"
      case "pagedown":
        this.moveBy(+this.pageSize)
        return "stay"
      case "home": {
        const i = this.clampToEnabled(0, +1)
        if (i >= 0) this.idx = i
        return "stay"
      }
      case "end": {
        const i = this.clampToEnabled(this.items.length - 1, -1)
        if (i >= 0) this.idx = i
        return "stay"
      }
      case "enter": {
        const sel = this.selected
        return { close: true, result: sel ? sel.value : null }
      }
      case "escape":
        return { close: true, result: null }
    }
  }

  rowsHint(): number {
    let n = this.items.length
    if (this.title) n += 2 // title + blank
    if (this.footer) n += 1
    return n
  }

  render(width: number): string[] {
    const w = Math.max(10, width | 0)
    const rows: string[] = []
    if (this.title) {
      rows.push(truncate(this.title, w))
      rows.push("")
    }
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]
      if (!it) continue
      const cursor = i === this.idx ? "❯ " : "  "
      const label = it.label
      const hint = it.hint ?? ""
      // budget: width - cursorWidth(2)
      const inner = Math.max(1, w - 2)
      let line: string
      if (hint) {
        const hintLen = Math.min(hint.length, Math.max(0, inner - 2))
        const labelBudget = Math.max(1, inner - hintLen - 1)
        const lab = truncate(label, labelBudget)
        const pad = Math.max(1, inner - lab.length - hintLen)
        line = lab + " ".repeat(pad) + hint.slice(0, hintLen)
      } else {
        line = truncate(label, inner)
      }
      let row = cursor + line
      if (it.disabled) row = `${DIM}${row}${RESET}`
      else if (i === this.idx) row = `${INVERT}${row}${RESET}`
      rows.push(row)
    }
    if (this.footer) rows.push(`${DIM}${truncate(this.footer, w)}${RESET}`)
    return rows
  }
}

function truncate(s: string, w: number): string {
  if (s.length <= w) return s
  if (w <= 3) return s.slice(0, w)
  return `${s.slice(0, w - 3)}...`
}
