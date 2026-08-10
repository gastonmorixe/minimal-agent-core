import { basename } from "node:path"

import type { FileSink, Subprocess } from "bun"

/** Request shape shared by tool-output renderers and highlighter clients. */
export interface CodeHighlightRequest {
  language: string
  code: string
}

/** Semantic colors accepted by mdstream's unified-diff mode. */
export interface UnifiedDiffColors {
  inserted?: string
  deleted?: string
}

/** Explicit mixed syntax + unified-diff request (protocol v2). */
export interface UnifiedDiffHighlightRequest extends CodeHighlightRequest {
  colors?: UnifiedDiffColors
  diffStyle?: "marker-fg" | "bg-wash"
}

/** Fail-closed port for presentation-only tool-output highlighting. */
export interface CodeHighlighter {
  /** Start syntax/theme initialization before the first tool result needs it. */
  warmup(): Promise<boolean>
  highlight(request: CodeHighlightRequest): Promise<string | null>
  /** Optional native mixed-diff mode. Null means unsupported or failed. */
  highlightUnifiedDiff?(request: UnifiedDiffHighlightRequest): Promise<string | null>
  close(): Promise<void>
}

export interface MdstreamCodeHighlighterOptions {
  /** Maximum time for the ready line and each highlight response. */
  timeoutMs?: number
  /** Spawn seam used by focused tests. Defaults to Bun.spawn. */
  spawn?: MdstreamHighlightSpawn
}

export type MdstreamHighlightSpawn = (argv: string[]) => Subprocess<"pipe", "pipe", "pipe">

interface HighlightResponse {
  id: number
  ansi?: string
  error?: string
}

interface ReadyResponse {
  ready: 1
  protocol?: number
  modes?: string[]
}

const DEFAULT_TIMEOUT_MS = 1_000
const MAX_LINE_CODE_UNITS = 16 * 1024 * 1024

/**
 * Persistent JSONL client for `mdstream --highlight-server`.
 *
 * The process starts lazily on the first request. Calls are serialized because
 * the server is sequential and because one timeout must never leave a late
 * response available for the next caller. Any protocol or process failure
 * permanently disables this client and resolves current/future calls to null.
 */
export class MdstreamCodeHighlighter implements CodeHighlighter {
  private readonly formatterArgv: readonly string[]
  private readonly timeoutMs: number
  private readonly spawn: MdstreamHighlightSpawn
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  private stdin: FileSink | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private readonly stdoutDecoder = new TextDecoder()
  private stdoutBuffer = ""
  private nextId = 1
  private queue: Promise<void> = Promise.resolve()
  private readonly modes = new Set<string>()
  private protocol = 1
  private disabled = false
  private closing: Promise<void> | null = null

  constructor(formatterArgv: readonly string[], options: MdstreamCodeHighlighterOptions = {}) {
    this.formatterArgv = [...formatterArgv]
    this.timeoutMs = normalizeTimeout(options.timeoutMs)
    this.spawn = options.spawn ?? spawnHighlightServer

    if (!isMdstreamFormatter(formatterArgv)) this.disabled = true
  }

  warmup(): Promise<boolean> {
    if (this.disabled || this.closing) return Promise.resolve(false)
    return new Promise((resolve) => {
      this.queue = this.queue
        .then(async () => resolve(await this.ensureStarted()))
        .catch(() => {
          this.disable()
          resolve(false)
        })
    })
  }

  /** Convenience overload for call sites that already have separate values. */
  highlight(language: string, code: string): Promise<string | null>
  highlight(request: CodeHighlightRequest): Promise<string | null>
  highlight(
    requestOrLanguage: CodeHighlightRequest | string,
    code?: string,
  ): Promise<string | null> {
    const request =
      typeof requestOrLanguage === "string"
        ? { language: requestOrLanguage, code: code ?? "" }
        : requestOrLanguage
    return this.enqueueRequest(request)
  }

  highlightUnifiedDiff(request: UnifiedDiffHighlightRequest): Promise<string | null> {
    if (!validRequest(request)) return Promise.resolve(null)
    return this.enqueueRequest(request, "unified-diff")
  }

  close(): Promise<void> {
    if (this.closing) return this.closing

    this.closing = this.queue
      .catch(() => undefined)
      .then(async () => {
        const proc = this.proc
        const stdin = this.stdin
        this.clearProcessState()

        try {
          void stdin?.end()
        } catch {}

        if (!proc) return
        try {
          await withTimeout(
            proc.exited.then(() => undefined),
            this.timeoutMs,
          )
        } catch {
          try {
            proc.kill()
          } catch {}
        }
      })
      .catch(() => undefined)
    this.disabled = true

    return this.closing
  }

  private enqueueRequest(
    request: CodeHighlightRequest | UnifiedDiffHighlightRequest,
    mode?: "unified-diff",
  ): Promise<string | null> {
    if (this.disabled || this.closing || !validRequest(request)) return Promise.resolve(null)

    return new Promise((resolve) => {
      this.queue = this.queue
        .then(async () => {
          resolve(await this.highlightSerialized(request, mode))
        })
        .catch(() => {
          this.disable()
          resolve(null)
        })
    })
  }

  private async highlightSerialized(
    request: CodeHighlightRequest | UnifiedDiffHighlightRequest,
    mode?: "unified-diff",
  ): Promise<string | null> {
    if (this.disabled) return null

    try {
      if (!(await this.ensureStarted())) return null
      if (mode && (this.protocol < 2 || !this.modes.has(mode))) return null

      const id = this.nextId++
      const payload =
        mode === "unified-diff"
          ? { id, mode, ...(request as UnifiedDiffHighlightRequest) }
          : { id, language: request.language, code: request.code }
      const line = `${JSON.stringify(payload)}\n`
      void this.stdin!.write(line)
      await this.stdin!.flush()

      const response = await withTimeout(this.readResponseLine(), this.timeoutMs)
      if (!isHighlightResponse(response) || response.id !== id) {
        this.disable()
        return null
      }
      // A correlated JSON error is a valid protocol response, not stream
      // corruption. Fail this presentation request closed but keep the sidecar
      // alive so the caller can use its local compositor fallback and later raw
      // Read highlights still work. Only malformed/out-of-order responses above
      // permanently disable the sequential client.
      if (typeof response.ansi !== "string") return null
      // Native unified-diff output is embedded directly beside host-owned
      // gutters. Reject a server response with an unterminated SGR line so a
      // background wash cannot bleed into the next frame row. Raw highlighting
      // remains compatible with v1 servers; this guard is specific to protocol
      // v2 unified-diff mode and its advertised balanced-line contract.
      if (mode === "unified-diff" && !hasBalancedAnsiLines(response.ansi)) return null
      return response.ansi
    } catch {
      this.disable()
      return null
    }
  }

  private async ensureStarted(): Promise<boolean> {
    if (this.proc && this.stdin && this.reader) return true
    if (this.disabled) return false

    try {
      const proc = this.spawn([...this.formatterArgv, "--highlight-server"])
      this.proc = proc
      this.stdin = proc.stdin
      this.reader = proc.stdout.getReader()
      proc.unref()
      void drain(proc.stderr).catch(() => undefined)
      void proc.exited.then(() => this.disable()).catch(() => this.disable())

      const ready = await withTimeout(this.readJsonLine(), this.timeoutMs)
      if (!isReadyResponse(ready)) {
        this.disable()
        return false
      }
      this.protocol = Number.isSafeInteger(ready.protocol) ? (ready.protocol ?? 1) : 1
      this.modes.clear()
      for (const mode of ready.modes ?? []) {
        if (typeof mode === "string") this.modes.add(mode)
      }
      return true
    } catch {
      this.disable()
      return false
    }
  }

  private async readResponseLine(): Promise<HighlightResponse | null> {
    const value = await this.readJsonLine()
    return isObject(value) ? (value as unknown as HighlightResponse) : null
  }

  private async readJsonLine(): Promise<unknown> {
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n")
      if (newline !== -1) {
        const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "")
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
        if (line.length === 0) throw new Error("empty highlight-server response")
        return JSON.parse(line)
      }
      if (this.stdoutBuffer.length > MAX_LINE_CODE_UNITS) {
        throw new Error("highlight-server response too large")
      }

      const next = await this.reader?.read()
      if (!next || next.done) throw new Error("highlight-server stdout closed")
      this.stdoutBuffer += this.stdoutDecoder.decode(next.value, { stream: true })
    }
  }

  private disable(): void {
    if (this.disabled && !this.proc) return
    this.disabled = true
    const proc = this.proc
    const stdin = this.stdin
    this.clearProcessState()

    try {
      void stdin?.end()
    } catch {}
    try {
      proc?.kill()
    } catch {}
  }

  private clearProcessState(): void {
    try {
      void this.reader?.cancel()
    } catch {}
    this.proc = null
    this.stdin = null
    this.reader = null
    this.stdoutBuffer = ""
  }
}

/** True only for an argv whose executable basename is literally `mdstream`. */
export function isMdstreamFormatter(formatterArgv: readonly string[]): boolean {
  const executable = formatterArgv[0]
  if (typeof executable !== "string") return false
  return (
    basename(executable.replaceAll("\\", "/"))
      .toLowerCase()
      .replace(/\.exe$/, "") === "mdstream"
  )
}

/** Create the optional highlighter port, returning null for all other formatters. */
export function createMdstreamCodeHighlighter(
  formatterArgv: readonly string[] | undefined,
  options?: MdstreamCodeHighlighterOptions,
): CodeHighlighter | null {
  if (!formatterArgv || !isMdstreamFormatter(formatterArgv)) return null
  return new MdstreamCodeHighlighter(formatterArgv, options)
}

function spawnHighlightServer(argv: string[]): Subprocess<"pipe", "pipe", "pipe"> {
  return Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const _chunk of stream) {
    // Discard diagnostics. Highlighting must not write into the TUI.
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_TIMEOUT_MS
}

function validRequest(request: CodeHighlightRequest): boolean {
  return (
    typeof request.language === "string" &&
    request.language.trim().length > 0 &&
    typeof request.code === "string"
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isReadyResponse(value: unknown): value is ReadyResponse {
  return (
    isObject(value) &&
    value.ready === 1 &&
    (value.protocol === undefined || Number.isSafeInteger(value.protocol)) &&
    (value.modes === undefined ||
      (Array.isArray(value.modes) && value.modes.every((mode) => typeof mode === "string")))
  )
}

function isHighlightResponse(value: HighlightResponse | null): value is HighlightResponse {
  return (
    value !== null &&
    Number.isSafeInteger(value.id) &&
    (typeof value.ansi === "string" || typeof value.error === "string")
  )
}

function hasBalancedAnsiLines(value: string): boolean {
  if (!value.includes("\x1b[")) return true
  const lines = value.split(/(?<=\n)/)
  return lines.every((line) => {
    const content = line.endsWith("\r\n")
      ? line.slice(0, -2)
      : line.endsWith("\n")
        ? line.slice(0, -1)
        : line
    return content.length === 0 || !content.includes("\x1b[") || content.endsWith("\x1b[0m")
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mdstream highlight timeout")), timeoutMs)
    timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
