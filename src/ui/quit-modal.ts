import type { LiveOverlay, OverlayKey } from "./overlay.ts"

export class QuitModal implements LiveOverlay {
  // 0 = Yes, 1 = No
  private selectedIndex: 0 | 1 = 1

  render(_width: number): string[] {
    const yes = this.selectedIndex === 0 ? "❮ Yes ❯" : "[ Yes ]"
    const no = this.selectedIndex === 1 ? "❮ No ❯" : "[ No ]"
    return [
      "  Quit minimal-agent?",
      "",
      `  ${yes}   ${no}`,
    ]
  }

  onKey(key: OverlayKey): "stay" | { close: true; result: boolean } {
    switch (key.name) {
      case "left":
      case "right":
      case "tab":
        this.selectedIndex = this.selectedIndex === 0 ? 1 : 0
        return "stay"
      case "enter":
        return { close: true, result: this.selectedIndex === 0 }
      case "escape":
        return { close: true, result: false }
      case "char": {
        const ch = key.ch
        if (ch === "y" || ch === "Y") return { close: true, result: true }
        if (ch === "n" || ch === "N") return { close: true, result: false }
        return "stay"
      }
      default:
        return "stay"
    }
  }

  rowsHint(): number {
    return 3
  }
}
