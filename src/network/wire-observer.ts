/**
 * Read-only wire observers for plugins (`network:observe`).
 *
 * A plugin observer is untrusted code on the hot path of every request. This
 * adapter turns a plugin {@link NetworkWireObserver} into a host
 * {@link NetworkObserver} with three guarantees:
 *
 * 1. It cannot change traffic. The request and response are frozen copies,
 *    and each chunk is a private copy of the bytes.
 * 2. It cannot break a request. A callback that throws is reported once on
 *    the request's diagnostics, and the request continues.
 * 3. It sees what the net-dbg capture records, no more. Headers and the
 *    request body pass the same redaction, and a request that opts out of
 *    body capture (an OAuth token exchange) sends no chunks.
 *
 * The observer runs inside `NetworkClient.tapResponse`, before the adapter
 * reads the chunk. So it sees the bytes of the server, before a provider
 * plugin changes the parsed text.
 *
 * @module network/wire-observer
 */

import type {
  NetworkObserveApi,
  NetworkWireObserver,
  NetworkWireRequest,
  NetworkWireResponse,
} from "@minimal-agent/core/plugin-api/net/types"

import type { Diagnostics } from "../diagnostics/hub.ts"
import { redactBody, redactHeaders } from "../logging/net-dbg.ts"

import type { NetworkClient } from "./client.ts"
import { captureRequestBody } from "./net-dbg-observer.ts"
import type { NetworkObserver, NetworkRequest, NetworkResponse } from "./types.ts"

/** Options for {@link createWireObserver}. */
export interface WireObserverOptions {
  /** Name of the owner (a plugin name), for the failure diagnostic. */
  readonly owner?: string
}

function wireRequest(req: NetworkRequest): NetworkWireRequest {
  return Object.freeze({
    id: req.id,
    label: req.label,
    method: req.method,
    url: req.url,
    headers: Object.freeze(redactHeaders(req.headers ?? {})),
    body: redactBody(captureRequestBody(req)),
  })
}

function wireResponse(res: NetworkResponse): NetworkWireResponse {
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })
  return Object.freeze({
    status: res.status,
    headers: Object.freeze(redactHeaders(headers)),
    transport: Object.freeze({ ...res.transport }),
  })
}

/**
 * Wrap a plugin wire observer as a host network observer.
 *
 * @returns An observer to pass to `NetworkClient.addObserver`.
 */
export function createWireObserver(
  observer: NetworkWireObserver,
  options: WireObserverOptions = {},
): NetworkObserver {
  /** In-flight requests: the frozen copy, and whether chunks may be shown. */
  const inFlight = new Map<string, { wire: NetworkWireRequest; chunks: boolean }>()
  let reported = false

  /** Run one plugin callback. Report the first failure, swallow all. */
  const guard = (diagnostics: Diagnostics | undefined, call: () => void): void => {
    try {
      call()
    } catch (err) {
      if (reported) return
      reported = true
      const detail = err instanceof Error ? err.message : String(err)
      const owner = options.owner ?? "unknown"
      diagnostics?.warn(
        "network.wire-observer",
        `wire observer of "${owner}" threw (further errors suppressed): ${detail}`,
        { owner, detail },
      )
    }
  }

  const entryFor = (req: NetworkRequest) => {
    let entry = inFlight.get(req.id)
    if (!entry) {
      entry = { wire: wireRequest(req), chunks: req.capture?.responseBody !== false }
      inFlight.set(req.id, entry)
    }
    return entry
  }

  return {
    onRequest(req) {
      guard(req.diagnostics, () => {
        const { wire } = entryFor(req)
        observer.onRequest?.(wire)
      })
    },
    onResponse(req, res) {
      if (!observer.onResponse) return
      guard(req.diagnostics, () => observer.onResponse?.(entryFor(req).wire, wireResponse(res)))
    },
    onChunk(req, chunk) {
      if (!observer.onChunk) return
      guard(req.diagnostics, () => {
        const entry = entryFor(req)
        // slice() copies: the consumer reads `chunk` itself after this call.
        if (entry.chunks) observer.onChunk?.(entry.wire, chunk.slice())
      })
    },
    onEnd(req) {
      guard(req.diagnostics, () => observer.onEnd?.(entryFor(req).wire))
      inFlight.delete(req.id)
    },
    onError(req, error) {
      guard(req.diagnostics, () => observer.onError?.(entryFor(req).wire, error))
      inFlight.delete(req.id)
    },
  }
}

/**
 * Build the `network:observe` capability API over one client.
 *
 * @returns The API a plugin gets as `ctx.host.network`.
 */
export function createNetworkObserveApi(
  client: Pick<NetworkClient, "addObserver">,
  options: WireObserverOptions = {},
): NetworkObserveApi {
  return {
    observe(observer) {
      return client.addObserver(createWireObserver(observer, options))
    },
  }
}
