import { beginRequest, warnLoggerErrorOnce } from "../net-dbg.ts"

import type { NetworkObserver, NetworkRequest } from "./types.ts"

/**
 * Attach network requests to the NET_DBG capture logger.
 *
 * @returns Observer that mirrors network traffic to disk when enabled.
 */
export function createNetDebugObserver(): NetworkObserver {
  const handles = new Map<
    string,
    ReturnType<typeof beginRequest> & { captureResponseBody?: boolean }
  >()

  return {
    onRequest(req) {
      try {
        const handle = beginRequest({
          url: req.url,
          method: req.method,
          headers: req.headers ?? {},
          body: captureRequestBody(req),
          protocol: req.transportHint ?? "network",
        })
        handles.set(req.id, {
          ...handle,
          captureResponseBody: req.capture?.responseBody !== false,
        })
      } catch (err) {
        warnLoggerErrorOnce(err)
      }
    },
    onResponse(req, res) {
      try {
        handles.get(req.id)?.recordResponse(res.status, res.headers, res.transport)
      } catch (err) {
        warnLoggerErrorOnce(err)
      }
    },
    onChunk(req, chunk) {
      try {
        const handle = handles.get(req.id)
        if (handle?.captureResponseBody) handle.appendResponseChunk(chunk)
      } catch (err) {
        warnLoggerErrorOnce(err)
      }
    },
    onEnd(req) {
      try {
        handles.get(req.id)?.finishResponse()
      } catch (err) {
        warnLoggerErrorOnce(err)
      } finally {
        handles.delete(req.id)
      }
    },
    onError(req) {
      try {
        handles.get(req.id)?.finishResponse()
      } catch (loggerErr) {
        warnLoggerErrorOnce(loggerErr)
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
