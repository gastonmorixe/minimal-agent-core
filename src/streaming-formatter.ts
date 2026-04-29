export class StreamingFormatter {
  private state: "prose" | "code" = "prose"
  private buf = ""
  private lang = ""
  constructor(private opts: { maxWidth?: number; hyperlinks: boolean }) {}
  feed(delta: string): string {
    this.buf += delta
    let out = ""
    while (this.buf.length > 0) {
      if (this.state === "prose") {
        const i = this.buf.indexOf("```")
        if (i === -1) {
          out += this.prose(this.buf)
          this.buf = ""
        } else {
          out += this.prose(this.buf.slice(0, i))
          const r = this.buf.slice(i + 3)
          const nl = r.indexOf("\n")
          if (nl === -1) break
          this.lang = r.slice(0, nl).trim()
          this.buf = r.slice(nl + 1)
          this.state = "code"
        }
      } else {
        const i = this.buf.indexOf("```")
        if (i === -1) break
        out += this.code(this.buf.slice(0, i))
        this.buf = this.buf.slice(i + 3)
        this.state = "prose"
      }
    }
    return out
  }
  private prose(t: string) {
    return t
      .replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[22m")
      .replace(/`([^`]+)`/g, "\x1b[33m$1\x1b[0m")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_: any, l: string, u: string) =>
        this.opts.hyperlinks
          ? "\x1b]8;;" + u + "\x1b\\" + l + "\x1b]8;;\x1b\\"
          : "\x1b[36m" + l + "\x1b[0m (" + u + ")",
      )
  }
  private code(t: string) {
    return (
      "\x1b[90m╭─ " +
      (this.lang || "code") +
      "\x1b[0m\n" +
      t
        .split("\n")
        .map((l) => "\x1b[90m│\x1b[0m " + l)
        .join("\n") +
      "\n\x1b[90m╰──────\x1b[0m\n"
    )
  }
}
