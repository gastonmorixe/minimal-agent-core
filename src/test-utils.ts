import { mock } from "bun:test"
export function createSpyRenderer() {
  const ev: string[] = []
  return {
    events: ev,
    renderer: {
      suspend: mock(() => ev.push("suspend")),
      resume: mock(() => ev.push("resume")),
      clear: mock(() => ev.push("clear")),
    },
  }
}
export function createOutputCapture() {
  const o: string[] = [],
    e: string[] = []
  return {
    stdout: o,
    stderr: e,
    out: {
      write: (s: string) => {
        o.push(s)
        return true
      },
    },
    err: {
      write: (s: string) => {
        e.push(s)
        return true
      },
    },
  }
}
export function assertOrder(events: string[], expected: string[]) {
  let i = -1
  for (const e of expected) {
    const j = events.indexOf(e, i + 1)
    if (j === -1) throw new Error("Missing " + e)
    i = j
  }
}
