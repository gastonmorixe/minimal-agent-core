/**
 * Public re-export shim for `@minimal-agent/core/host/request-inspector`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../llm/transport/request-inspector.ts`:
 * the typed `llm.requestWillSend` channel. The transport publishes one event
 * per outgoing request attempt, only when the channel has a subscriber. A
 * host subscribes to {@link processRequestInspector} to show or log the
 * request. The snapshot builder stays internal to core (its parameter is the
 * internal transport options type).
 *
 * @module host-public/request-inspector
 */

export {
  createRequestInspector,
  processRequestInspector,
  REQUEST_INSPECTOR_SOURCE,
  REQUEST_WILL_SEND,
  type RequestCacheBreakpoints,
  type RequestDiagnostics,
  type RequestInspector,
  type RequestSnapshot,
  type RequestToolView,
  type RequestWillSendEvent,
  type RequestWillSendHandler,
  type RequestWireView,
} from "../llm/transport/request-inspector.ts"
