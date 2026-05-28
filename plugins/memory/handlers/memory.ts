/**
 * Inline-tag handler for `<ma::plugin::memory [scope="global"|"project"|"short-term"]>...</ma::plugin::memory>`.
 *
 * Behavior:
 *   1. Append the body as a new bullet through `lib/store.ts`. The target
 *      depends on the `scope` attribute:
 *        - scope="global"     → ~/.minimal-agent/memory.md
 *        - scope="project"    → ~/.minimal-agent/projects/<absolute-cwd>/memory.md  (default)
 *        - scope="short-term" → ~/.minimal-agent/sessions/<sid>.scratch.md
 *      The directory is created if missing.
 *   2. Emit `memory.saved` on the global event bus so the agent's
 *      {@link SaveEchoCollector} can surface the bullet's id back to the
 *      model on its very next turn (closing the loop on "I saved a memory
 *      but don't know its id"). See `lib/save-echo.ts`.
 *   3. Render a short ANSI confirmation line in place of the tag span so
 *      the user can see the save happened. The body itself is not echoed.
 *
 * For `short-term`, a session id is required (read from
 * `ctx.env.MINIMAL_AGENT_SESSION_ID`). If absent, the save is refused
 * with a friendly red error line; nothing is written, nothing is
 * emitted on the bus.
 *
 * Memory files (global+project) are reloaded into the system prompt at
 * every session start by this plugin's `memory_load` prompt fragment
 * (handlers/load.ts). Short-term is NOT loaded that way — it rides as
 * a per-turn user-message attachment via `lib/short-term-snapshot.ts`.
 *
 * Safety:
 *   - The handler refuses to write under `ctx.packageDir` (defensive: the
 *     plugin used to mutate its own embedded `PROMPT.md`, dirtying the
 *     shipped repo and leaking the assistant's personal memories to every
 *     user of the agent).
 *   - Empty bodies are no-ops.
 *   - Multi-line bodies are collapsed to a single line by `MemoryStore.add`
 *     so each bullet stays compact.
 *
 * Write failures surface as a one-line ANSI error so saves aren't silently
 * lost.
 *
 * @module memory/handlers/memory
 */

import { getGlobalEventBus } from "../../../src/global-bus.ts"
import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"
import { MEMORY_SAVED, type MemorySavedPayload } from "../lib/save-echo.ts"
import { MemoryStore, type StoreKind } from "../lib/store.ts"

// Re-export `localIsoSeconds` for callers that imported it from this
// module's old location (the function was moved to `lib/parse.ts` in
// v0.3 to eliminate duplication; existing imports continue to work).
export { localIsoSeconds } from "../lib/parse.ts"

type Scope = StoreKind

/**
 * Normalize the `scope` attribute. Accepts the three documented values
 * plus the `short` shorthand. Anything else falls back to `project`
 * (most lessons are codebase-specific) so a typo never silently sends
 * a memory to the wrong place.
 */
function parseScope(attrs: Record<string, string>): Scope {
  const raw = (attrs.scope ?? "").trim().toLowerCase()
  if (raw === "global") return "global"
  if (raw === "short-term" || raw === "short") return "short-term"
  return "project"
}

export default async function memoryHandler(
  ctx: TUIContext,
): Promise<TUIResult> {
  if (ctx.trigger.type !== "inline_tag") {
    return { kind: "rendered", ansi: "" }
  }

  const body = ctx.trigger.body.trim()
  if (body.length === 0) {
    return { kind: "rendered", ansi: "" }
  }

  const scope = parseScope(ctx.trigger.attrs)
  const sid = ctx.env.MINIMAL_AGENT_SESSION_ID?.trim() || null

  // Short-term requires a session id by definition (the file is
  // `<sid>.scratch.md`). Without one we have nowhere to put the
  // bullet — refuse loudly so the model sees the failure.
  if (scope === "short-term" && !sid) {
    const ansi =
      "\x1b[31m· memory save refused: short-term scope requires a session id (none plumbed through)\x1b[0m\n"
    ctx.log.warn("short-term-no-sid", "refused short-term write: MINIMAL_AGENT_SESSION_ID is empty", {
      scope,
    })
    return { kind: "rendered", ansi }
  }

  // Build the right store. Persistent stores stamp `[session:<sid>]` on
  // each line; short-term omits it (the file IS the session).
  const store = makeStore(scope, ctx.cwd, sid, ctx.env.HOME)

  // Defensive: never let a memory write mutate the shipped plugin tree.
  // Reachable historically when `cwd` resolved under `packageDir` (test
  // fixture). The store reads `$HOME` from env which we accept here, so
  // the same guard still pays off.
  if (store.path.startsWith(`${ctx.packageDir}/`) || store.path === ctx.packageDir) {
    const ansi = `\x1b[31m· memory save refused: target inside plugin dir (${store.path})\x1b[0m\n`
    ctx.log.error("save-refused-package-dir", "refused write under plugin packageDir", {
      scope,
      path: store.path,
    })
    return { kind: "rendered", ansi }
  }

  try {
    const { bullet, evicted } = store.add(body)

    // Emit on the global bus so the agent's SaveEchoCollector picks
    // it up and surfaces the id to the model on the next user turn.
    // Optional-chained: the bus may be null in ad-hoc tests / before
    // setGlobalEventBus is called. The save itself isn't gated on bus
    // availability — losing the echo is recoverable (the model can
    // call MemoryTool to discover the id).
    const payload: MemorySavedPayload = {
      scope,
      id: bullet.id,
      body: bullet.body,
      ...(evicted.length > 0 ? { evicted: evicted.length } : {}),
    }
    getGlobalEventBus()?.emit(MEMORY_SAVED, payload)

    // Visible-to-user confirmation line, dim. Includes the eviction
    // count when relevant so the human sees why a short-term entry
    // disappeared from their scratchpad mid-session.
    const oneLine = bullet.body
    const preview = oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine
    const tag = scope === "global" ? "global" : scope === "short-term" ? "short-term" : "project"
    const evictedHint = evicted.length > 0 ? ` (evicted ${evicted.length} oldest)` : ""
    const ansi = `\x1b[2m· memory saved [${tag}#${bullet.id}]${evictedHint}: ${preview}\x1b[0m\n`
    return { kind: "rendered", ansi }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ctx.log.error("save-failed", msg, { scope })
    const ansi = `\x1b[31m· memory save failed: ${msg}\x1b[0m\n`
    return { kind: "rendered", ansi }
  }
}

/**
 * Construct the right store for a scope. Pulls `$HOME` from the
 * handler's `ctx.env` (the loader injects it) so a test setting `HOME`
 * for the env-info plugin's snapshot also affects this handler — same
 * pattern the legacy handler used.
 */
function makeStore(
  scope: Scope,
  cwd: string,
  sid: string | null,
  envHome: string | undefined,
): MemoryStore {
  // Honor an explicit HOME override in the plugin env block, falling
  // back to the process's HOME via the store's default deps. We do
  // NOT pass `home` when envHome is undefined — that lets the store
  // re-read process.env.HOME at call time, which the existing tests
  // for the inline-tag handler rely on.
  const deps = envHome ? { home: envHome } : undefined
  if (scope === "global") return MemoryStore.global({ ...deps, sid })
  if (scope === "short-term") {
    if (!sid) throw new Error("short-term store requires a session id")
    return MemoryStore.shortTerm(sid, deps)
  }
  return MemoryStore.project(cwd, { ...deps, sid })
}
