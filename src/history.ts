import { join } from "path"
import { homedir } from "os"
export class History {
  private entries: { text: string; ts: number; cwd: string }[] = []
  private pos = -1
  constructor(private cwd: string) {}
  async load() {
    try {
      const f = Bun.file(join(homedir(), ".minimal-agent", "history.jsonl"))
      if (await f.exists())
        this.entries = (await f.text())
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
    } catch {}
  }
  add(t: string) {
    if (this.entries.length && this.entries.at(-1)!.text === t) return
    this.entries.push({ text: t, ts: Date.now(), cwd: this.cwd })
    this.pos = -1
  }
  up() {
    if (!this.entries.length) return null
    if (this.pos === -1) this.pos = this.entries.length
    return this.entries[--this.pos]?.text || null
  }
  down() {
    if (this.pos === -1) return null
    this.pos++
    return this.pos >= this.entries.length ? ((this.pos = -1), "") : this.entries[this.pos].text
  }
  search(q: string) {
    return this.entries
      .filter((e) => e.text.includes(q))
      .reverse()
      .slice(0, 20)
  }
}
