import { basename, dirname } from "node:path"

import { Severity } from "../bus/diagnostic-bus.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import { emitTyped } from "../diagnostics/typed.ts"
import { beginRequest, currentNetDbgSessionDir, warnLoggerErrorOnce } from "../logging/net-dbg.ts"
import { type NetDbgRetention, pruneNetDbgDir } from "../logging/net-dbg-retention.ts"

import type { NetworkObserver, NetworkRequest } from "./types.ts"

/** Options for {@link createNetDebugObserver}. */
export interface NetDebugObserverOptions {
  /** Whether on-disk capture is on. The caller resolves it (`resolveNetDbgEnabled`). */
  readonly enabled: boolean
  /**
   * Prune old capture folders once, in the background, after the first
   * capture of the process creates its own folder. Omit to never prune.
   */
  readonly retention?: NetDbgRetention
}

/** Start one background prune of the capture root; never throws. */
function pruneInBackground(retention: NetDbgRetention, diagnostics: Diagnostics | undefined): void {
  const live = currentNetDbgSessionDir()
  if (!live) return
  void pruneNetDbgDir(dirname(live), retention, { keep: basename(live) })
    .then((r) => {
      if (r.removed === 0 || !diagnostics) return
      emitTyped(
        diagnostics,
        Severity.Info,
        "net-dbg.pruned",
        `net-dbg: removed ${r.removed} old capture folder(s), freed ${Math.round(r.freedBytes / 1024 ** 2)} MB`,
        { removed: r.removed, "freed-bytes": r.freedBytes, "kept-bytes": r.keptBytes },
      )
    })
    .catch(() => {})
}

/**
 * Attach network requests to the NET_DBG capture logger.
 *
 * @returns Observer that mirrors network traffic to disk when enabled, and
 *   an observer with no handlers when not.
 */
export function createNetDebugObserver(options: NetDebugObserverOptions): NetworkObserver {
  if (!options.enabled) return {}
  const handles = new Map<
    string,
    ReturnType<typeof beginRequest> & { captureResponseBody?: boolean }
  >()

  let pruneStarted = false
  return {
    onRequest(req) {
      try {
        const handle = beginRequest({
          url: req.url,
          method: req.method,
          headers: req.headers ?? {},
          body: captureRequestBody(req),
          // Pre-flight attempt label — the response record carries the truth
          // (`transport.protocol` / `transport.fallbackUsed`).
          transportAttempted: req.transportHint ?? "unknown",
          requestId: req.id,
        })
        handles.set(req.id, {
          ...handle,
          captureResponseBody: req.capture?.responseBody !== false,
        })
        if (!pruneStarted && options.retention) {
          pruneStarted = true
          pruneInBackground(options.retention, req.diagnostics)
        }
      } catch (err) {
        warnLoggerErrorOnce(err, req.diagnostics)
      }
    },
    onResponse(req, res) {
      try {
        handles.get(req.id)?.recordResponse(res.status, res.headers, res.transport)
      } catch (err) {
        warnLoggerErrorOnce(err, req.diagnostics)
      }
    },
    onChunk(req, chunk) {
      try {
        const handle = handles.get(req.id)
        if (handle?.captureResponseBody) handle.appendResponseChunk(chunk)
      } catch (err) {
        warnLoggerErrorOnce(err, req.diagnostics)
      }
    },
    onEnd(req) {
      try {
        handles.get(req.id)?.finishResponse()
      } catch (err) {
        warnLoggerErrorOnce(err, req.diagnostics)
      } finally {
        handles.delete(req.id)
      }
    },
    onError(req) {
      try {
        handles.get(req.id)?.finishResponse()
      } catch (loggerErr) {
        warnLoggerErrorOnce(loggerErr, req.diagnostics)
      } finally {
        handles.delete(req.id)
      }
    },
  }
}

function captureRequestBody(req: NetworkRequest): string {
  if (req.capture?.requestBody !== undefined) {
    return req.capture.requestBody ?? ""
  }
  if (req.body == null) return ""
  if (typeof req.body === "string") return req.body
  return new TextDecoder().decode(req.body)
}
