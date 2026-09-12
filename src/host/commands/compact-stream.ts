/**
 * Host-owned live markdown stream for `/compact` local summaries.
 *
 * Raw deltas go through Formatter (mdstream) then compositor. Attempt 2
 * awaits the previous formatter EOF, prints a retry marker, then respawns.
 * Writes that arrive during reset are queued. CSI is never gutter-prefixed.
 *
 * @module host/commands/compact-stream
 */

import { flattenAnsiToLines } from "../ui/formatter/ansi-flatten.ts"
import { Formatter } from "../ui/formatter/formatter.ts"

export interface CompactStreamSink {
  write: (chunk: string) => void
  onAttempt: (attempt: number) => void | Promise<void>
  end: () => Promise<void>
}

/**
 * Create the live stream sink for `/compact` local summaries, or `null` when
 * the host has no `writeStream` (no TUI attached, e.g. piped output).
 *
 * With a formatter command the raw deltas are piped through mdstream so the
 * summary renders as Markdown while it arrives. Without one, deltas pass
 * through verbatim.
 */
export function createCompactStreamSink(opts: {
  writeStream?: (chunk: string) => void
  formatterCmd?: string[]
  columns?: number
  rows?: number
}): CompactStreamSink | null {
  const writeStream = opts.writeStream
  if (typeof writeStream !== "function") return null

  if (!opts.formatterCmd) {
    return {
      write: (chunk: string) => writeStream(chunk),
      onAttempt: (attempt: number) => {
        if (attempt > 1) writeStream("\n[compact retry]\n")
      },
      end: async () => {},
    }
  }

  let formatter: Formatter | null = null
  let resetting: Promise<void> | null = null
  const pending: string[] = []
  const decoder = new TextDecoder()
  const sink: Pick<NodeJS.WriteStream, "write"> & { columns?: number; rows?: number } = {
    get columns() {
      return opts.columns ?? process.stdout.columns
    },
    get rows() {
      return opts.rows ?? process.stdout.rows
    },
    write: ((chunk: string | Uint8Array) => {
      const s = typeof chunk === "string" ? chunk : decoder.decode(chunk)
      writeStream(s)
      return true
    }) as NodeJS.WriteStream["write"],
  }
  const spawn = (): Formatter => {
    const f = new Formatter(opts.formatterCmd!, sink)
    f.start()
    return f
  }
  formatter = spawn()

  const flushPending = (): void => {
    if (!formatter) return
    for (const chunk of pending.splice(0)) formatter.write(chunk)
  }

  return {
    write: (chunk: string) => {
      if (resetting || !formatter) {
        pending.push(chunk)
        return
      }
      formatter.write(chunk)
    },
    onAttempt: async (attempt: number) => {
      if (attempt <= 1) return
      const old = formatter
      formatter = null
      resetting = (async () => {
        try {
          if (old) await old.end()
        } catch {
          // Drop the failed attempt's formatter before starting retry.
        }
        writeStream("\n[compact retry]\n")
        formatter = spawn()
        flushPending()
      })()
      await resetting
      resetting = null
    },
    end: async () => {
      if (resetting) {
        try {
          await resetting
        } catch {
          // Reset already logged; still close the live formatter.
        }
      }
      const active = formatter
      formatter = null
      if (active) await active.end()
    },
  }
}

/**
 * Run markdown through Formatter to completion, then flatten cursor
 * motion into static rows. Safe to gutter inside a notice frame.
 */
export async function formatMarkdownLines(
  markdown: string,
  formatterCmd: string[] | undefined,
  geometry?: { columns?: number; rows?: number },
): Promise<string[] | null> {
  if (!formatterCmd || markdown.length === 0) return null
  let buf = ""
  const decoder = new TextDecoder()
  const sink: Pick<NodeJS.WriteStream, "write"> & { columns?: number; rows?: number } = {
    get columns() {
      return geometry?.columns ?? process.stdout.columns
    },
    get rows() {
      return geometry?.rows ?? process.stdout.rows
    },
    write: ((chunk: string | Uint8Array) => {
      buf += typeof chunk === "string" ? chunk : decoder.decode(chunk)
      return true
    }) as NodeJS.WriteStream["write"],
  }
  const formatter = new Formatter(formatterCmd, sink)
  formatter.start()
  formatter.write(markdown)
  await formatter.end()
  return flattenAnsiToLines(buf)
}
