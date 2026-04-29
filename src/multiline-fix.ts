// NEVER remove old content from scrollback
export class MultilineBuffer {
  private lines: string[] = [""]
  private cy = 0
  private cx = 0
  private done = false
  get text() {
    return this.lines.join("\n")
  }
  insert(ch: string) {
    if (this.done) return
    const l = this.lines[this.cy]
    this.lines[this.cy] = l.slice(0, this.cx) + ch + l.slice(this.cx)
    this.cx += ch.length
  }
  newline() {
    if (this.done) return
    const l = this.lines[this.cy]
    this.lines[this.cy] = l.slice(0, this.cx)
    this.lines.splice(this.cy + 1, 0, l.slice(this.cx))
    this.cy++
    this.cx = 0
  }
  backspace() {
    if (this.done || (this.cx === 0 && this.cy === 0)) return
    if (this.cx > 0) {
      const l = this.lines[this.cy]
      this.lines[this.cy] = l.slice(0, this.cx - 1) + l.slice(this.cx)
      this.cx--
    } else {
      const p = this.lines[this.cy - 1]
      this.lines.splice(this.cy, 1)
      this.cy--
      this.cx = p.length
      this.lines[this.cy] += this.lines[this.cy]
    }
  }
  commit() {
    this.done = true
    return this.text
  }
  reset() {
    this.lines = [""]
    this.cy = 0
    this.cx = 0
    this.done = false
  }
}
