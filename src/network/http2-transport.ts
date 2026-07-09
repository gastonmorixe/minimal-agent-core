import type {
  ClientHttp2Session,
  ClientHttp2Stream,
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
} from "node:http2"
import { connect, constants } from "node:http2"

import { TRANSIENT_NETWORK_STREAM_ERROR_TYPE } from "./transient-error.ts"
import { type NetworkRequest, NetworkResponse, type NetworkTransport } from "./types.ts"

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

    let signal = req.signal
    if (req.timeoutMs) {
      const timeoutSignal = AbortSignal.timeout(req.timeoutMs)
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    }

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

      // Evict + tear down this session so the NEXT request dials a fresh
      // connection instead of reusing a wedged one. Called when an abort
      // can't be honored gracefully (see attachAbort escalation): on a
      // black-holed socket the RST_STREAM never flushes and the session
      // would otherwise sit pooled and be handed to the next retry, which
      // stalls identically — the livelock behind the 13h hang.
      const poisonSession = () => {
        if (this.sessions.get(origin)?.session === entry.session) {
          this.sessions.delete(origin)
        }
        if (!entry.session.destroyed) entry.session.destroy()
      }

      const cleanupAbort = attachAbort(signal, stream, fail, poisonSession)

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

    // `node:http2.connect()` forwards extra options to the underlying
    // `net.Socket`. Turn on TCP keepalive so the OS probes the connection
    // after a sleep/wake cycle (macOS suspends TCP I/O while sleeping; on
    // wake, peer-side FIN/RST may have been queued for minutes).
    //
    // Without this, dead sessions sit "ESTABLISHED" indefinitely from
    // node:http2's POV and accumulate as CLOSE_WAIT on the kernel side,
    // which used to trip a Bun event-loop bug (~70% CPU busy-loop on
    // `accept(2)` for the dead fds). See
    // ./private/research/2026-05-28/high-cpu/REPORT.md.
    const session = connect(origin, {
      // @ts-expect-error node:http2 forwards these to net.Socket but its
      // TS surface doesn't declare them.
      keepAlive: true,
      keepAliveInitialDelay: 30_000,
    })

    // Application-layer liveness probe. node:http2 emits "error" / "goaway"
    // when a PING fails or the peer sends GOAWAY, both of which trigger the
    // tear-down path below. 30s matches our streamIdleTimeout heuristic.
    const pingTimer = setInterval(() => {
      if (session.closed || session.destroyed) return
      try {
        // A failed PING means the peer is gone or the socket is wedged.
        // Destroy the session so it's evicted from the pool (via the
        // `remove` handlers below) and the next request dials fresh.
        // Previously the callback was ignored, so a half-dead session
        // could linger indefinitely and keep getting reused. node:http2
        // also surfaces hard failures via "error"/"goaway", but the ping
        // callback is the earliest signal for a silently wedged peer.
        session.ping((err: Error | null) => {
          if (err && !session.destroyed) session.destroy(err)
        })
      } catch {}
    }, 30_000)
    if (typeof pingTimer.unref === "function") pingTimer.unref()

    const entry: SessionEntry = { session, origin, requestCount: 0 }
    this.sessions.set(origin, entry)

    const remove = () => {
      clearInterval(pingTimer)
      if (this.sessions.get(origin)?.session === session) {
        this.sessions.delete(origin)
      }
      // Critical: tear down the underlying TCP socket. Without this, the
      // remote-half-closed connection sits as orphan CLOSE_WAIT, holding
      // an FD in the libuv/uSockets watchlist forever. Calling destroy()
      // is a no-op when the session is already destroyed (idempotent).
      if (!session.destroyed) session.destroy()
    }
    session.once("close", remove)
    session.once("error", remove)
    session.once("goaway", remove)

    try {
      await waitForSession(session, origin, this.connectTimeoutMs)
    } catch (err) {
      remove()
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

/** Test seam for exercising HTTP/2 stream-to-Web-stream termination edge cases. */
export function _nodeStreamToWebForTest(
  stream: ClientHttp2Stream,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  return nodeStreamToWeb(stream, onDone)
}

function nodeStreamToWeb(
  stream: ClientHttp2Stream,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  let finished = false
  const finish = (fn: () => void) => {
    if (finished) return
    finished = true
    onDone()
    fn()
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Uint8Array) => {
        controller.enqueue(new Uint8Array(chunk))
        if (controller.desiredSize != null && controller.desiredSize <= 0) {
          stream.pause()
        }
      })
      stream.once("end", () => {
        finish(() => controller.close())
      })
      stream.once("close", () => {
        const readableEnded = (stream as { readableEnded?: boolean }).readableEnded === true
        if (readableEnded) {
          finish(() => controller.close())
          return
        }
        const err = new Error("HTTP/2 stream closed before end") as Error & {
          streamErrorType?: string
        }
        err.streamErrorType = TRANSIENT_NETWORK_STREAM_ERROR_TYPE
        finish(() => controller.error(err))
      })
      stream.once("error", (err) => {
        finish(() => controller.error(err))
      })
      stream.once("aborted", () => {
        finish(() => controller.error(new Error("HTTP/2 stream aborted")))
      })
    },
    pull() {
      stream.resume()
    },
    cancel() {
      if (!finished) {
        finished = true
        onDone()
      }
      try {
        stream.close(constants.NGHTTP2_CANCEL)
      } catch {}
    },
  })
}

/**
 * Grace period between a graceful HTTP/2 stream cancel and the forced
 * teardown. A healthy stream emits 'close' well within this window, so a
 * normal abort (user Ctrl-C, watchdog on a live socket) keeps the session
 * reusable. A wedged socket can't flush the RST_STREAM, so after the grace
 * we destroy the stream AND evict the session.
 */
const ABORT_ESCALATE_MS = 2_000

function attachAbort(
  signal: AbortSignal | undefined,
  stream: ClientHttp2Stream,
  reject: (err: unknown) => void,
  poisonSession: () => void,
): () => void {
  if (!signal) return () => {}

  const onAbort = () => {
    // 1. Arm escalation before canceling. A healthy stream may emit `close`
    //    immediately after `close(NGHTTP2_CANCEL)`, so the listener must be in
    //    place before we ask Node to cancel the stream.
    const escalate = setTimeout(() => {
      try {
        stream.destroy(new Error("aborted: HTTP/2 stream did not close after cancel"))
      } catch {}
      poisonSession()
    }, ABORT_ESCALATE_MS)
    if (typeof escalate.unref === "function") escalate.unref()
    stream.once("close", () => clearTimeout(escalate))

    // 2. Graceful: ask the peer to cancel the stream.
    try {
      stream.close(constants.NGHTTP2_CANCEL)
    } catch {}

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
  if (session.closed || session.destroyed) return false
  // The underlying net.Socket may be half-closed (peer FIN received, our
  // side hasn't called destroy yet) without ClientHttp2Session emitting
  // 'close'. `socket.readable` goes false on FIN, and `socket.writable`
  // goes false on local shutdown / ENOTCONN. Reject either case so we
  // open a fresh session instead of issuing a request on a dead pipe.
  //
  // This catches the post-sleep/wake case where node:http2 hasn't yet
  // surfaced a 'close' event on a session whose TCP layer transitioned
  // to CLOSE_WAIT during sleep.
  const sock = session.socket as undefined | { readable?: boolean; writable?: boolean }
  if (!sock) return true
  if (sock.readable === false) return false
  if (sock.writable === false) return false
  return true
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
