import { homedir } from "os"
import { join } from "path"
export function generateSessionId() {
  return (
    "ma-session-" +
    new Date().toISOString().slice(0, 10).replace(/-/g, "") +
    "-" +
    Math.random().toString(36).slice(2, 6)
  )
}
export class Logger {
  private buf: any[] = []
  constructor(private sid: string) {
    setInterval(() => this.flush(), 500)
  }
  info(src: string, msg: string, data?: unknown) {
    this.buf.push({ ts: new Date().toISOString(), level: "info", src, msg, data, sid: this.sid })
  }
  error(src: string, msg: string, data?: unknown) {
    this.buf.push({ ts: new Date().toISOString(), level: "error", src, msg, data, sid: this.sid })
  }
  async flush() {
    if (!this.buf.length) return
    const e = this.buf.splice(0)
    await Bun.write(
      join(homedir(), ".minimal-agent", "logs", this.sid + ".jsonl"),
      e.map((x) => JSON.stringify(x)).join("\n") + "\n",
    )
  }
}
