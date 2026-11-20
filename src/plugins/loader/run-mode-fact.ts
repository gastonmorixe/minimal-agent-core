/**
 * The run-mode fact of a plugin handler context (`ctx.run`): one rule for
 * event, hook and tool handlers. A leaf module, so the loader, the event
 * subs and the session-scope context can all import it.
 *
 * @module plugins/loader/run-mode-fact
 */

import type { RunModeFact } from "../types.ts"

/**
 * The run-mode fact for a handler context. A sub-agent worker
 * (`MINIMAL_AGENT_SUBAGENT_ID` or `MINIMAL_AGENT_SUBAGENT_SID` set) always
 * gets `mode: "subagent"`, also when the host fact says another mode,
 * because workers run with `--prompt` and `stream-json`. With no host fact
 * and no sub-agent env, the result is `undefined`. Never throws.
 */
export function resolveRunModeFact(
  runMode: (() => RunModeFact | undefined) | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RunModeFact | undefined {
  let fact: RunModeFact | undefined
  try {
    fact = runMode?.()
  } catch {
    fact = undefined
  }
  const id =
    env.MINIMAL_AGENT_SUBAGENT_ID?.trim() || env.MINIMAL_AGENT_SUBAGENT_SID?.trim() || undefined
  if (!id) return fact
  if (fact?.mode === "subagent" && fact.subagent) return { ...fact, interactive: false }
  const role = env.MINIMAL_AGENT_SUBAGENT_ROLE?.trim() || undefined
  const leadSid = env.MINIMAL_AGENT_SUBAGENT_LEAD?.trim() || undefined
  return {
    ...fact,
    mode: "subagent",
    interactive: false,
    subagent: { id, ...(role ? { role } : {}), ...(leadSid ? { leadSid } : {}) },
  }
}

/**
 * Give `target` a lazy `run` property: the fact of {@link resolveRunModeFact}.
 * The getter runs on the first read only, and keeps the value. Thus a handler
 * that does not read `ctx.run` costs nothing (no CLI getter call for each
 * dispatch). With no fact, `run` reads as `undefined`. The hook and tool
 * contexts use it. The event context stays eager (its fact is the fact of the
 * event time, and an event handler can keep its ctx).
 */
export function defineRunFact(
  target: { run?: RunModeFact },
  runMode: (() => RunModeFact | undefined) | undefined,
  env?: NodeJS.ProcessEnv,
): void {
  let fact: RunModeFact | undefined
  let resolved = false
  Object.defineProperty(target, "run", {
    configurable: true,
    enumerable: true,
    get: () => {
      if (!resolved) {
        fact = resolveRunModeFact(runMode, env)
        resolved = true
      }
      return fact
    },
  })
}

/**
 * Give a tool handler context its lazy `ctx.run` (see {@link defineRunFact})
 * and return it.
 */
export function withRunFact<T extends { run?: RunModeFact }>(
  ctx: T,
  runMode: (() => RunModeFact | undefined) | undefined,
): T {
  defineRunFact(ctx, runMode)
  return ctx
}
