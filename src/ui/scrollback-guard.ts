/**
 * Reserves a block of rows at the bottom of the terminal by scrolling the
 * viewport up, then lets callers repaint individual reserved lines in place
 * with save/restore-cursor escapes. Predecessor of the Compositor's live
 * area; writes directly to `process.stdout`.
 */
export class ScrollbackGuard {
  private reserved = 0
  reserve(n: number) {
    this.reserved = n
    process.stdout.write("\x1b[" + n + "S\x1b[" + n + "A")
  }
  writeAt(line: number, content: string) {
    if (line >= this.reserved) return
    process.stdout.write("\x1b[s\x1b[" + (this.reserved - line) + "B\x1b[2K" + content + "\x1b[u")
  }
  release() {
    this.reserved = 0
  }
}
