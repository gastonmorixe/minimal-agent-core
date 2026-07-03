/**
 * Shared test fixtures for the `EditorController` test files
 * (`editor-controller.test.ts`, `editor-controller.footer.test.ts`,
 * `editor-controller.nav.test.ts`, `editor-controller.hooks.test.ts`).
 * Not a test file itself.
 */

import { EventEmitter } from "node:events"

import type { AbortBus } from "../bus/abort-bus.ts"
import type { Hooks } from "../plugins/hooks/hooks.ts"

import { EditorController } from "./editor-controller.ts"

/** Fake raw-mode TTY stdin: records mode flips and lets tests inject bytes via `send`. */
export class FakeTTYInput extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null
  resumed = false
  rawModes: boolean[] = []

  setEncoding(encoding: BufferEncoding): this {
    this.encoding = encoding
    return this
  }
  resume(): this {
    this.resumed = true
    return this
  }
  pause(): this {
    this.resumed = false
    return this
  }
  setRawMode(value: boolean): this {
    this.rawModes.push(value)
    return this
  }
  send(chunk: string): void {
    this.emit("data", chunk)
  }
}

/** Fake TTY output stream that captures every written chunk for assertions. */
export class FakeOutput {
  readonly chunks: string[] = []
  isTTY = true
  columns = 80
  rows = 24
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }
  text(): string {
    return this.chunks.join("")
  }
}

/** Fake compositor recording `setLiveArea`/`setLiveHeight` calls. */
export class FakeCompositor {
  liveAreaCalls: Array<{
    lines: string[]
    cursor: { row: number; col: number } | null
  }> = []
  liveHeightCalls: number[] = []
  liveHeight = 1
  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void {
    this.liveAreaCalls.push({ lines: [...lines], cursor: cursor ? { ...cursor } : null })
  }
  setLiveHeight(n: number): void {
    this.liveHeightCalls.push(n)
    this.liveHeight = n
  }
  last() {
    return this.liveAreaCalls[this.liveAreaCalls.length - 1]
  }
}

/** Build an `EditorController` wired to fresh fakes; returns the controller + fakes. */
export function make(
  opts: {
    prompt?: string
    continuation?: string
    columns?: number
    bareEscapeMs?: number
    abortBus?: AbortBus
    /** Override armed-state painter cadence. Set 0 to disable tick. */
    armedTickMs?: number
    /** Inject a clock for the abort-quit FSM. */
    nowFn?: () => number
    hooks?: Hooks
    /** Resize coalescing window; default 0 (synchronous) for tests. */
    resizeDebounceMs?: number
  } = {},
) {
  const stdin = new FakeTTYInput()
  const output = new FakeOutput()
  if (opts.columns) output.columns = opts.columns
  const compositor = new FakeCompositor()
  const ctrl = new EditorController({
    prompt: opts.prompt ?? "> ",
    continuationPrompt: opts.continuation ?? "  ",
    compositor: compositor as any,
    stdin: stdin as any,
    output: output as any,
    // Unit tests assert immediate reflow on notifyResize(); keep it
    // synchronous by default. The drag-coalescing path is covered by a
    // dedicated test that opts into a non-zero window.
    resizeDebounceMs: opts.resizeDebounceMs ?? 0,
    ...(opts.bareEscapeMs !== undefined ? { bareEscapeMs: opts.bareEscapeMs } : {}),
    ...(opts.abortBus ? { abortBus: opts.abortBus } : {}),
    ...(opts.armedTickMs !== undefined ? { armedTickMs: opts.armedTickMs } : {}),
    ...(opts.nowFn ? { nowFn: opts.nowFn } : {}),
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
  })
  return { ctrl, stdin, output, compositor }
}
