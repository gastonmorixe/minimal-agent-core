/**
 * `@minimal-agent/core`'s package-root public entry (spec v2 section 2.3,
 * S47): `createRuntime` / `Runtime` / `Session`, plus the session event log
 * (S48) and port types a caller of `openSession` wires its own
 * implementations against.
 *
 * `src/sdk/runtime.ts` is the thin re-export that satisfies the public
 * package contract's "every export resolves inside `src/sdk` or
 * `plugin-api/src`" rule (`src/architecture/public-api.test.ts`); this is
 * where the actual wiring lives, because it reaches concrete session and
 * diagnostics collaborators the `src/sdk/` port-boundary ratchet
 * (`src/architecture/sdk-port-boundaries.test.ts`) forbids `src/sdk/*`
 * files from importing.
 *
 * @module runtime/index
 */

export type { PluginEventsPort } from "../bus/plugin-events-port.ts"
export type { LiveStatus, StatusFields, StatusPhase, StatusPort } from "../bus/status-port.ts"
// Runtime-level diagnostics (S20, S21): the shape of `runtime.diagnostics`.
export type { Diagnostics, SessionDiagnostics } from "../diagnostics/hub.ts"
// The agent event surface (S18, S19, S23, S24, S28): `SessionEntry.data`
// on an `ch: "event"` entry.
export type { AgentEvent, AgentEventType } from "../sdk/events.ts"
// The optional host ports (S17, section 2.6) a caller of `openSession`
// wires its own implementation against.
export type {
  AskUserPort,
  AskUserRequest,
  CompactSourcePort,
  HostPorts,
  InputQueuePort,
  PendingCompact,
  ReflectionGatePort,
} from "../sdk/host-ports.ts"
// Round checkpoints (S50): `resumeSession` reads one back; a caller that
// manages its own persistence passes one through `openSession`'s
// `initialCheckpoint`.
export type { RoundCheckpoint } from "../sdk/round-checkpoint.ts"
// The session event log (S48): the shape `session.run` and
// `session.subscribe` hand back.
export type {
  DiagnosticEvent,
  EventLogFileContents,
  ReplayGap,
  SessionChannel,
  SessionDiagEntry,
  SessionEntry,
  SessionEntryListener,
  SessionEventEntry,
  SessionEventLogStats,
  SubscribeOptions,
  Unsubscribe,
} from "../session/event-log.ts"
export {
  parseEntryLine,
  readEventLogFile,
  serializeEntry,
  serializeEntrySse,
} from "../session/event-log.ts"

export { PendingAskRegistry } from "./host-ports-defaults.ts"
export { EMPTY_TOOL_REGISTRY, NO_TOOLS_EXECUTOR } from "./noop-tools.ts"
export type {
  CreateRuntimeOptions,
  OpenSessionOptions,
  ResumeSessionOptions,
  Runtime,
  SessionPersistenceOptions,
} from "./runtime.ts"
export { createRuntime } from "./runtime.ts"
export type { SessionOptions, SessionPluginScopeOptions, SessionRunOptions } from "./session.ts"
export { Session } from "./session.ts"
