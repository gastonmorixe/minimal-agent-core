/**
 * Minimal LSP client over stdio (JSON-RPC framing).
 *
 * Just enough protocol to drive a language server for "check after edit":
 * initialize, didOpen/didChange to sync the proposed buffer, and a PULL
 * `textDocument/diagnostic` request (preferred over push for an on-demand
 * check : you request exactly when you want, vs push whose timing you can't
 * know : per the LSP 3.17 pull-diagnostics guidance). Server→client requests
 * (registerCapability, configuration) are auto-acked so the server doesn't
 * stall.
 *
 * Validated against `tsgo --lsp -stdio`: cold init ~220ms, then per-edit pull
 * 2-3ms. The client is transport-only : the {@link TsgoLspProvider} owns
 * lifecycle, the adapter owns shape.
 *
 * @module plugins/diagnostics/lib/lsp-client
 */
import { type ChildProcess, spawn } from "node:child_process"

interface PendingResolver {
  (msg: Record<string, unknown>): void
}

export interface LspClientOptions {
  /** ms to wait for `initialize` to resolve before failing. Default 8000. */
  initTimeoutMs?: number
}

export class LspClient {
  private proc: ChildProcess
  private buf = Buffer.alloc(0)
  private pending = new Map<number, PendingResolver>()
  private nextId = 1
  private opened = new Set<string>()
  private version = new Map<string, number>()
  private readyPromise: Promise<void>
  private disposed = false
  private exitHandler: (() => void) | null = null

  constructor(
    cmd: string[],
    private cwd: string,
    opts: LspClientOptions = {},
  ) {
    this.proc = spawn(cmd[0], cmd.slice(1), { cwd })
    this.proc.stdout?.on("data", (c: Buffer) => this.onData(c))
    this.proc.stderr?.on("data", () => {})
    this.readyPromise = this.initialize(opts.initTimeoutMs ?? 8000)
  }

  /** Resolves once `initialize`/`initialized` completed. Rejects on failure. */
  whenReady(): Promise<void> {
    return this.readyPromise
  }

  /** True if the child has exited or been disposed. */
  get dead(): boolean {
    return this.disposed || this.proc.exitCode !== null || this.proc.signalCode !== null
  }

  /** Register a callback invoked if the child process exits unexpectedly. */
  onExit(handler: () => void): void {
    this.exitHandler = handler
    this.proc.on("exit", () => {
      if (!this.disposed) handler()
    })
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk])
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n")
      if (headerEnd === -1) break
      const header = this.buf.subarray(0, headerEnd).toString("utf8")
      const m = header.match(/Content-Length: (\d+)/i)
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4)
        continue
      }
      const len = Number(m[1])
      const start = headerEnd + 4
      if (this.buf.length < start + len) break
      const body = this.buf.subarray(start, start + len).toString("utf8")
      this.buf = this.buf.subarray(start + len)
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(body)
      } catch {
        continue
      }
      this.handleMessage(msg)
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const id = msg.id
    if (typeof id === "number" && this.pending.has(id)) {
      this.pending.get(id)?.(msg)
      this.pending.delete(id)
      return
    }
    // Server→client request (registerCapability, workspace/configuration):
    // ack with a null result so the server doesn't block.
    if (msg.method !== undefined && id !== undefined) {
      const idLit = typeof id === "string" ? `"${id}"` : String(id)
      this.write(`{"jsonrpc":"2.0","id":${idLit},"result":null}`)
    }
  }

  private write(json: string): void {
    if (this.dead) return
    this.proc.stdin?.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`)
  }

  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++
    this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    return new Promise((resolve) => this.pending.set(id, resolve))
  }

  private notify(method: string, params: unknown): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }))
  }

  private async initialize(timeoutMs: number): Promise<void> {
    const initPromise = this.request("initialize", {
      processId: process.pid,
      rootUri: `file://${this.cwd}`,
      capabilities: {
        textDocument: { diagnostic: { dynamicRegistration: true }, publishDiagnostics: {} },
      },
      workspaceFolders: [{ uri: `file://${this.cwd}`, name: "root" }],
    })
    const timeout = new Promise<never>((_res, rej) =>
      setTimeout(() => rej(new Error("lsp initialize timeout")), timeoutMs),
    )
    await Promise.race([initPromise, timeout])
    this.notify("initialized", {})
    // Let config-watch registration settle (tsgo registers a watcher).
    await new Promise((r) => setTimeout(r, 200))
  }

  /** Sync `text` for `path` (didOpen first time, then didChange). */
  sync(path: string, text: string): void {
    const uri = `file://${path}`
    if (!this.opened.has(uri)) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageIdFor(path), version: 1, text },
      })
      this.opened.add(uri)
      this.version.set(uri, 1)
    } else {
      const v = (this.version.get(uri) ?? 1) + 1
      this.version.set(uri, v)
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: v },
        contentChanges: [{ text }],
      })
    }
  }

  /** Pull diagnostics for `path`. Returns the raw LSP `items` array. */
  async pullDiagnostics(path: string): Promise<unknown[]> {
    const uri = `file://${path}`
    const res = await this.request("textDocument/diagnostic", { textDocument: { uri } })
    const result = res.result as { items?: unknown[] } | undefined
    return Array.isArray(result?.items) ? result.items : []
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.notify("exit", {})
      this.proc.kill()
    } catch {
      /* already gone */
    }
  }
}

function languageIdFor(path: string): string {
  if (path.endsWith(".tsx")) return "typescriptreact"
  if (path.endsWith(".jsx")) return "javascriptreact"
  if (/\.(js|mjs|cjs)$/.test(path)) return "javascript"
  return "typescript"
}
