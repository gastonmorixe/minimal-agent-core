import { connect, constants } from "node:http2"
import type {
  ClientHttp2Session,
  ClientHttp2Stream,
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
} from "node:http2"
import { NetworkResponse, type NetworkRequest, type NetworkTransport } from "./types.ts"

type SessionEntry = {
  session: ClientHttp2Session
  origin: string
  requestCount: number
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
])

/** HTTP/2 transport that keeps one reusable session per API origin. */
export class Http2Transport implements NetworkTransport {
  readonly id = "http2"
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly connectTimeoutMs: number

  constructor(opts: { connectTimeoutMs?: number } = {}) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000
  }

  async request(req: NetworkRequest): Promise<NetworkResponse> {
    const url = new URL(req.url)
    const origin = url.origin
    const entry = await this.getSession(origin)
    const reused = entry.requestCount > 0
    entry.requestCount++

    return new Promise<NetworkResponse>((resolve, reject) => {
      const headers = buildHttp2Headers(req, url)
      const stream = entry.session.request(headers)
      let settled = false
      let response: NetworkResponse | null = null

      const fail = (err: unknown) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      }

      const cleanupAbort = attachAbort(req, stream, fail)

      stream.once("response", (rawHeaders) => {
        const status = rawHeaders[":status"] ?? 0
        const body = nodeStreamToWeb(stream, () => cleanupAbort())
        response = new NetworkResponse({
          status,
          headers: headersToWeb(rawHeaders),
          body,
          transport: {
            id: this.id,
            protocol: "h2",
            origin,
            reused,
            fallbackUsed: false,
          },
        })
        if (!settled) {
          settled = true
          resolve(response)
        }
      })

      stream.once("error", (err) => {
        cleanupAbort()
        if (response) return
        fail(err)
      })

      if (req.body == null) {
        stream.end()
      } else {
        stream.end(req.body)
      }
    })
  }

  async preconnect(origin: string): Promise<void> {
    await this.getSession(new URL(origin).origin)
  }

  async close(): Promise<void> {
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(entries.map((entry) => closeSession(entry.session)))
  }

  private async getSession(origin: string): Promise<SessionEntry> {
    const existing = this.sessions.get(origin)
    if (existing && isUsable(existing.session)) return existing

    const session = connect(origin)
    const entry: SessionEntry = { session, origin, requestCount: 0 }
    this.sessions.set(origin, entry)

    const remove = () => {
      if (this.sessions.get(origin)?.session === session) {
        this.sessions.delete(origin)
      }
    }
    session.once("close", remove)
    session.once("error", remove)
    session.once("goaway", remove)

    try {
      await waitForSession(session, origin, this.connectTimeoutMs)
    } catch (err) {
      remove()
      session.destroy()
      throw err
    }
    return entry
  }
}

function buildHttp2Headers(req: NetworkRequest, url: URL): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    ":method": req.method,
    ":path": `${url.pathname}${url.search}`,
    ":scheme": url.protocol.slice(0, -1),
    ":authority": url.host,
  }

  for (const [rawKey, value] of Object.entries(req.headers ?? {})) {
    const key = rawKey.toLowerCase()
    if (key === "host" || HOP_BY_HOP_HEADERS.has(key)) continue
    headers[key] = value
  }

  return headers
}

function headersToWeb(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (key.startsWith(":") || value == null) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else {
      headers.set(key, value)
    }
  }
  return headers
}

function nodeStreamToWeb(
  stream: ClientHttp2Stream,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Uint8Array) => {
        controller.enqueue(new Uint8Array(chunk))
      })
      stream.once("end", () => {
        onDone()
        controller.close()
      })
      stream.once("error", (err) => {
        onDone()
        controller.error(err)
      })
      stream.once("aborted", () => {
        onDone()
        controller.error(new Error("HTTP/2 stream aborted"))
      })
    },
    cancel() {
      onDone()
      stream.close(constants.NGHTTP2_CANCEL)
    },
  })
}

function attachAbort(
  req: NetworkRequest,
  stream: ClientHttp2Stream,
  reject: (err: unknown) => void,
): () => void {
  const signal = req.signal
  if (!signal) return () => {}

  const onAbort = () => {
    stream.close(constants.NGHTTP2_CANCEL)
    reject(signal.reason ?? new Error("Network request aborted"))
  }

  if (signal.aborted) {
    onAbort()
    return () => {}
  }

  signal.addEventListener("abort", onAbort, { once: true })
  return () => signal.removeEventListener("abort", onAbort)
}

function isUsable(session: ClientHttp2Session): boolean {
  return !session.closed && !session.destroyed
}

async function waitForSession(
  session: ClientHttp2Session,
  origin: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`HTTP/2 connect timeout for ${origin}`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      session.off("connect", onConnect)
      session.off("error", onError)
      session.off("close", onClose)
    }
    const onConnect = () => {
      cleanup()
      resolve()
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onClose = () => {
      cleanup()
      reject(new Error(`HTTP/2 session closed before connect for ${origin}`))
    }

    session.once("connect", onConnect)
    session.once("error", onError)
    session.once("close", onClose)
  })

  if (origin.startsWith("https:") && session.alpnProtocol !== "h2") {
    throw new Error(`HTTP/2 ALPN negotiation failed for ${origin}: ${String(session.alpnProtocol)}`)
  }
}

async function closeSession(session: ClientHttp2Session): Promise<void> {
  if (session.closed || session.destroyed) return
  await new Promise<void>((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (!session.closed && !session.destroyed) session.destroy()
      finish()
    }, 1000)
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    session.close(finish)
  })
}
