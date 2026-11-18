/**
 * The session scope of one run: the identity, target and token counters of
 * the session whose turn runs now.
 *
 * One process can host many sessions (the web host). They share one plugin
 * loader, one net-dbg logger and one transport. Those parts were made for a
 * process with one session, so they read the process identity
 * (`getSessionId()`, the boot `AgentContext`, the boot model). In a process
 * with many sessions, that identity belongs to no session.
 *
 * A host that opens many sessions turns the scope on for each session
 * (`OpenSessionOptions.pluginScope`). `Session.run` then runs the turn
 * inside {@link runInSessionScope}. The shared parts read
 * {@link currentSessionScope} first, and the process values only when no
 * scope is active. A host with one session for each process (the CLI) sets
 * no scope, so nothing changes for it.
 *
 * It uses `AsyncLocalStorage`, the same way as the diagnostics run scope
 * (`diagnostics/run-scope.ts`): the scope follows the awaits of the turn
 * (tools, hooks, sends), and two turns of two sessions that run at the same
 * time each see their own scope.
 *
 * This module is a leaf: it imports only types, so every layer can read it.
 *
 * @module infra/session-scope
 */

import { AsyncLocalStorage } from "node:async_hooks"

import type {
  AgentContext,
  ModelInfoSnapshot,
  SubagentModelRecommendation,
  TargetSnapshot,
} from "../plugins/types.ts"
import type { SessionTokenCounter } from "../session/session-tokens.ts"

/** The live facts of one session, for the shared parts of a process. */
export interface SessionScope {
  /** The session id. It names the transcript, the net-dbg folder and the plugin state. */
  readonly sid: string
  /** The agent identity for plugin handlers, with the live model. Made at each call. */
  agent(): AgentContext
  /** The live target of the session (credential, provider, model, effort). */
  queryTarget(): TargetSnapshot
  /** The capability snapshot of the live model of the session. */
  queryModelInfo(): ModelInfoSnapshot | undefined
  /** The sub-agent model recommendations for the live model of the session. */
  recommendSubagentModels(): SubagentModelRecommendation[]
  /** The token counters of this session only. */
  readonly tokens: SessionTokenCounter
}

const store = new AsyncLocalStorage<SessionScope>()

/** Run `fn` with `scope` as the current session scope. */
export function runInSessionScope<T>(scope: SessionScope, fn: () => T): T {
  return store.run(scope, fn)
}

/** The session scope of the run in progress, or `undefined` outside a scoped run. */
export function currentSessionScope(): SessionScope | undefined {
  return store.getStore()
}
