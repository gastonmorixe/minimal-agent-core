/**
 * `createRuntime`: the top-level public entry (spec v2 section 2.3, S47).
 *
 * `Runtime` owns the process-level services: the diagnostics hub (agent J's
 * `src/diagnostics/hub.ts`). `runtime.openSession` builds a new `Session`;
 * `runtime.resumeSession` reopens one from its persisted history, using
 * agent H's round checkpoints (S50) so an interrupted run continues at the
 * right round. Many sessions run concurrently in one process — this is
 * required for the web server (spec v2 section 4.1) — and nothing here is a
 * module singleton: each `Runtime` is self-contained, and two `Runtime`s in
 * one process share no state (not the diagnostic bus, when `bus` is given;
 * not a global plugin-bus pointer; not anything else).
 *
 * @module runtime/runtime
 */

import { randomUUID } from "node:crypto"

import type { DiagnosticBus } from "../bus/diagnostic-bus.ts"
import {
  createDiagnosticsHub,
  type Diagnostics,
  type SessionDiagnostics,
} from "../diagnostics/hub.ts"
import { eventLogFilePath } from "../session/event-log.ts"
import { lastTurnRoundCheckpoint, loadSession } from "../session/session-restore.ts"
import { defaultSessionsDir, SessionStore } from "../session/session-store.ts"

import { Session, type SessionOptions } from "./session.ts"
import { SessionStorePersistence } from "./session-persistence-store.ts"

/** Where a session's session-store transcript and durable event log live. */
export interface SessionPersistenceOptions {
  /** Base sessions directory. Default: `defaultSessionsDir()` (`~/.minimal-agent/sessions`). */
  dir?: string
  /** `cwd` recorded in the session's `meta` record. Default: `process.cwd()`. */
  cwd?: string
}

/**
 * `runtime.openSession` options: {@link SessionOptions} (the collaborators
 * `AgentCore` needs) plus the id and persistence this layer owns.
 */
export interface OpenSessionOptions extends SessionOptions {
  /** Explicit session id. Default: a fresh random UUID. */
  id?: string
  /**
   * Persist this session's transcript (a real `SessionStore`) and its
   * event log (a durable JSONL sidecar), so `runtime.resumeSession` and a
   * process restart can both read it back. `true` uses the default
   * directory; an object picks `dir` and/or `cwd`. Default: no persistence
   * (memory only; `resumeSession` cannot reopen it).
   */
  persist?: boolean | SessionPersistenceOptions
}

/** `runtime.resumeSession` options: like {@link OpenSessionOptions}, minus what resume derives from disk. */
export type ResumeSessionOptions = Omit<
  OpenSessionOptions,
  "id" | "initialMessages" | "initialCheckpoint" | "model" | "eventLogPath"
> & {
  /** Overrides the model recorded in the session's `meta` record. */
  model?: string
  /**
   * Durable JSONL sidecar path for the event log. Default: the session's
   * `<dir>/<id>.events.jsonl`. `null` keeps the log in memory only, for a
   * host that writes no event sidecar (the CLI).
   */
  eventLogPath?: string | null
}

function resolvePersistence(
  persist: boolean | SessionPersistenceOptions | undefined,
): Required<SessionPersistenceOptions> | null {
  if (!persist) return null
  const opts = persist === true ? {} : persist
  return { dir: opts.dir ?? defaultSessionsDir(), cwd: opts.cwd ?? process.cwd() }
}

/** The runtime's public entry. Build it with {@link createRuntime}. */
export interface Runtime {
  /** Runtime-level diagnostics scope: startup, plugins, provider discovery. No session id. */
  readonly diagnostics: Diagnostics
  /** Open a new session. */
  openSession(options: OpenSessionOptions): Session
  /**
   * Reopen a session from its persisted history (a real `SessionStore`
   * written by an earlier `openSession({ persist: ... })`). When its last
   * turn was cut short — a crash, a restart, or a permanent error that
   * paused it — pass `{ resume: true }` to `session.run` to continue it at
   * the next round (S50) instead of starting a new turn.
   *
   * @throws when no session `id` was ever persisted at this directory
   */
  resumeSession(id: string, options: ResumeSessionOptions): Session
  /**
   * Close every open session of this runtime. Does not remove any durable
   * file. Idempotent.
   */
  close(): void
}

/** Options for {@link createRuntime}. */
export interface CreateRuntimeOptions {
  /**
   * Where every diagnostic of this runtime fans out. Default: the process
   * bus (shared with the transitional global `diag` helpers, so moving a
   * call site is never a behavior change). Pass `createDiagnosticBus()`
   * for a runtime fully isolated from the process — required when more
   * than one `Runtime` shares a process and they must not mix
   * diagnostics.
   */
  bus?: DiagnosticBus
  /** Clock for diagnostic and event-log timestamps, epoch ms. Default `Date.now`. */
  now?: () => number
}

/** Create a runtime. See the module doc and spec v2 section 2.3 (S47). */
export function createRuntime(options: CreateRuntimeOptions = {}): Runtime {
  const hub = createDiagnosticsHub(options)
  const sessions = new Map<string, Session>()
  let closed = false

  const open = (
    id: string,
    sessionOptions: SessionOptions,
    scope: SessionDiagnostics = hub.session(id),
  ): Session => {
    if (closed) throw new Error("runtime is closed")
    if (sessions.has(id)) throw new Error(`session ${id} is already open in this runtime`)
    const session = new Session(id, scope, sessionOptions)
    sessions.set(id, session)
    session.onClose(() => sessions.delete(id))
    return session
  }

  return {
    diagnostics: hub.diagnostics,

    openSession(options: OpenSessionOptions): Session {
      const { id = randomUUID(), persist, ...sessionOptions } = options
      const dest = resolvePersistence(persist)
      let sessionPersistence = sessionOptions.sessionPersistence
      let eventLogPath = sessionOptions.eventLogPath
      if (dest) {
        const store = SessionStore.open({
          sid: id,
          model: sessionOptions.model,
          cwd: dest.cwd,
          systemHash: "",
          toolsHash: "",
          agentVersion: "runtime",
          dir: dest.dir,
        })
        sessionPersistence ??= new SessionStorePersistence(store)
        eventLogPath ??= eventLogFilePath(id, dest.dir)
      }
      return open(id, { ...sessionOptions, sessionPersistence, eventLogPath })
    },

    resumeSession(id: string, options: ResumeSessionOptions): Session {
      const { persist, eventLogPath, ...sessionOptions } = options
      const dest = resolvePersistence(persist ?? true)
      if (!dest) throw new Error("resumeSession needs persist (a session store to read back)")
      // Open the scope first, so a fold warning of the restore names this session.
      const scope = hub.session(id)
      // The session sideband API (the same one the core gets) reads the
      // runtime attachment and marker blocks of the restored history.
      const loaded = loadSession(id, dest.dir, {
        diagnostics: scope,
        ...(options.sideband ? { sideband: options.sideband } : {}),
      })
      const model = options.model ?? loaded.meta?.model ?? ""
      const store = SessionStore.open({
        sid: id,
        model,
        cwd: dest.cwd,
        systemHash: "",
        toolsHash: "",
        agentVersion: "runtime",
        dir: dest.dir,
        existsOk: true,
      })
      const checkpoint = lastTurnRoundCheckpoint(loaded.records) ?? undefined
      return open(
        id,
        {
          ...sessionOptions,
          model,
          initialMessages: loaded.messages,
          ...(checkpoint ? { initialCheckpoint: checkpoint } : {}),
          sessionPersistence:
            sessionOptions.sessionPersistence ?? new SessionStorePersistence(store),
          ...(eventLogPath === null
            ? {}
            : { eventLogPath: eventLogPath ?? eventLogFilePath(id, dest.dir) }),
        },
        scope,
      )
    },

    close(): void {
      if (closed) return
      closed = true
      for (const session of [...sessions.values()]) session.close()
      sessions.clear()
    },
  }
}
