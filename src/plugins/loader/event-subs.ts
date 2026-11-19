/**
 * Resolution + registration of event subscriptions, hook
 * subscriptions, and live-area slots declared in a plugin manifest.
 *
 * Split out of `src/plugins/loader.ts` to keep that file under the
 * `max-lines` lint budget. Names are not re-exported from
 * `loader.ts`; the `PluginLoader` class is the only caller.
 *
 * @module plugins/loader/event-subs
 */

import { childEnv } from "@minimal-agent/core/plugin-api/utils/self-spawn"

import { createPluginLogger, type DiagnosticEmitter } from "../../bus/diagnostic-bus.ts"
import { childRegistry, registerChild } from "../../infra/child-registry.ts"
import { EventBus, type EventContext } from "../event-bus.ts"
import { Hooks } from "../hooks/hooks.ts"
import type { PluginHost } from "../host/capabilities.ts"
import { pluginPackageFor } from "../source.ts"
import type {
  AgentContext,
  CommandContext,
  CommandHandler,
  CommandInfo,
  CommandResult,
  EventHandler,
  EventHandlerContext,
  HookHandlerContext,
  ManifestCommand,
  ManifestEventSubscription,
  ManifestHookSubscription,
  ResolvedCommand,
  ResolvedEventSub,
  ResolvedHookSub,
  RunModeFact,
} from "../types.ts"

import { buildHandlerEnv, type HandlerStdio } from "./handler-env.ts"
import { scopedAgent } from "./session-scope-ctx.ts"
import { createShapeAwareEmit } from "./shape-emit.ts"

/** Module-handler default-export signature for hook subscriptions. */
type HookHandler<TPayload = unknown> = (payload: TPayload, ctx: HookHandlerContext) => unknown

// ---------------------------------------------------------------------------
// Event subscription resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a manifest event subscription to an invocable form. Mirrors
 * {@link resolveHandler} but for one-way event handlers (no `ToolHandlerResult`,
 * no return value).
 *
 * Returns `null` and logs on failure. The plugin keeps its tool/tag
 * functionality; only this one subscription is dropped.
 */
export async function resolveEventSub(
  sub: ManifestEventSubscription,
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedEventSub | null> {
  const pkg = pluginPackageFor(packageDir)
  if (sub.handler.type === "module") {
    const rel = sub.handler.path
    const abs = pkg.resolve(rel)
    if (!pkg.hasFile(rel)) {
      logger(`${packageDir}: event handler module not found: ${abs}`)
      return null
    }
    let mod: { default?: EventHandler }
    try {
      mod = (await pkg.importModule(rel)) as { default?: EventHandler }
    } catch (e) {
      logger(
        `${packageDir}: failed to import event handler ${abs}: ${e instanceof Error ? e.message : String(e)}`,
      )
      return null
    }
    const fn = mod.default
    if (typeof fn !== "function") {
      logger(`${packageDir}: event handler ${abs} has no default export function`)
      return null
    }
    return {
      definition: sub,
      entryAbsolute: abs,
      invoke: async (ctx) => fn(ctx),
    }
  }

  // subprocess
  const cmd = sub.handler.command
  const exe = cmd[0]
  const exeAbs = pkg.resolve(exe)
  if (!pkg.hasFile(exe)) {
    logger(`${packageDir}: event subprocess executable not found: ${exeAbs}`)
    return null
  }
  return {
    definition: sub,
    entryAbsolute: exeAbs,
    // `execPath` extracts an embedded file on first use. Disk: `exeAbs`.
    invoke: async (ctx) => invokeEventSubprocess(pkg.execPath(exe), cmd.slice(1), ctx),
  }
}

/**
 * Resolve each manifest event subscription of one package. A sub that fails
 * to resolve is logged and dropped (see {@link resolveEventSub}).
 */
export async function resolveEventSubs(
  subs: readonly ManifestEventSubscription[],
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedEventSub[]> {
  const out: ResolvedEventSub[] = []
  for (const sub of subs) {
    const r = await resolveEventSub(sub, packageDir, logger)
    if (r) out.push(r)
  }
  return out
}

/**
 * Event channels that fire on each keystroke or on each model token. A
 * `"host": true` sub on one of them gets a warning: a plugin with
 * `llm:complete` could call a model on each key or token. `message.tokens`
 * is the only `shape: "stream"` channel (one event per token).
 */
export const HIGH_FREQUENCY_EVENT_CHANNELS: ReadonlySet<string> = new Set([
  "editor.key",
  "editor.buffer.changed",
  "prompt.input.changed",
  "message.tokens",
])

/** Late-bound host data for event handler contexts (`ctx.host`, `ctx.run`). */
export interface EventSubHostOptions {
  /**
   * The capability-scoped host of the plugin (default deny). Called at event
   * time, only for a module handler whose sub declares `"host": true`.
   */
  hostFor?: () => PluginHost | undefined
  /** The run-mode fact that the host process computes. Called at event time. */
  runMode?: () => RunModeFact | undefined
  /** Env for the sub-agent check. Default `process.env`. */
  env?: NodeJS.ProcessEnv
}

/** True when the manifest sub opts in to `ctx.host` (`"host": true`). */
export function wantsEventHost(sub: ManifestEventSubscription): boolean {
  return sub.host === true
}

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
 * Subscribe a resolved event sub on the shared bus. The bus owns
 * coalesce/throttle/error handling; we just adapt its `EventContext`
 * (event + payload + emit + abort) to the plugin's
 * `EventHandlerContext` (which adds `packageDir`, `cwd`, `env`, `stderr`).
 *
 * `ctx.host` is set only for a MODULE handler whose sub declares
 * `"host": true` (opt-in; subprocess handlers cannot get a live object).
 * `ctx.run` is set when {@link resolveRunModeFact} gives a fact. The bus does
 * not await the handler.
 */
export function registerEventSub(
  bus: EventBus,
  hooks: Hooks,
  packageDir: string,
  sub: ResolvedEventSub,
  logger: (msg: string) => void,
  pluginId: string,
  agent: AgentContext | undefined,
  listCommands?: () => CommandInfo[],
  stdio?: HandlerStdio,
  diagnostics?: DiagnosticEmitter,
  hostOpts: EventSubHostOptions = {},
): void {
  const label = `${packageDir}:${sub.definition.id}`
  const emit = createShapeAwareEmit(bus, hooks, label, logger)
  const optIn = wantsEventHost(sub.definition)
  const isModule = sub.definition.handler.type === "module"
  if (optIn && !isModule) logger(`${label}: "host": true is ignored for a subprocess handler`)
  if (optIn && isModule && HIGH_FREQUENCY_EVENT_CHANNELS.has(sub.definition.on)) {
    logger(`${label}: "host": true on high-frequency channel "${sub.definition.on}"`)
  }
  const hostFor = optIn && isModule ? hostOpts.hostFor : undefined
  const listener = (ctx: EventContext): void | Promise<void> => {
    // A run of a scoped session (a host with many sessions) gives its own agent.
    const live = scopedAgent(agent)
    const handlerCtx: EventHandlerContext = {
      event: ctx.event,
      payload: ctx.payload,
      packageDir,
      cwd: process.cwd(),
      env: buildHandlerEnv(live),
      // Shape-aware emit (see createShapeAwareEmit): declared non-async
      // channels via the Hooks facade, async + ad-hoc via the EventBus.
      emit,
      abort: ctx.abort,
      ...(stdio?.stderr ? { stderr: stdio.stderr } : {}),
      log: createPluginLogger(pluginId, diagnostics),
      ...(listCommands ? { listCommands } : {}),
      agent: live,
    }
    try {
      const host = hostFor?.()
      if (host) handlerCtx.host = host
      const run = resolveRunModeFact(hostOpts.runMode, hostOpts.env)
      if (run) handlerCtx.run = run
      return sub.invoke(handlerCtx)
    } catch (e) {
      logger(`${label}: handler threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  bus.on(sub.definition.on, listener, {
    coalesce: sub.definition.coalesce,
    throttleMs: sub.definition.throttleMs,
    label,
  })
}

/**
 * Resolve a single manifest hook subscription to invocable form.
 *
 * Mirrors {@link resolveEventSub} but for hook handlers (which may run on
 * the synchronous {@link HookBus} for `broadcast-sync` / `chain` channels).
 *
 * Currently MODULE handlers only — subprocess hook handlers are logged
 * and skipped (sync dispatch cannot tolerate an `await proc.exited` round
 * trip in the editor's keystroke pump). When a real use case arrives we
 * can extend this with a stdin/stdout JSON envelope protocol like
 * {@link invokeEventSubprocess}, but only for `broadcast-async` channels.
 *
 * Returns `null` and logs on failure. The plugin's tools / inline tags
 * / event subs continue to work; just this one hook is dropped.
 */
export async function resolveHookSub(
  sub: ManifestHookSubscription,
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedHookSub | null> {
  if (sub.handler.type !== "module") {
    logger(`${packageDir}: hook "${sub.id}" — subprocess handlers are not yet supported; skipping`)
    return null
  }
  const pkg = pluginPackageFor(packageDir)
  const rel = sub.handler.path
  const abs = pkg.resolve(rel)
  if (!pkg.hasFile(rel)) {
    logger(`${packageDir}: hook handler module not found: ${abs}`)
    return null
  }
  let mod: { default?: HookHandler }
  try {
    mod = (await pkg.importModule(rel)) as { default?: HookHandler }
  } catch (e) {
    logger(
      `${packageDir}: failed to import hook handler ${abs}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
  const fn = mod.default
  if (typeof fn !== "function") {
    logger(`${packageDir}: hook handler ${abs} has no default export function`)
    return null
  }
  return {
    definition: sub,
    entryAbsolute: abs,
    invoke: (payload: unknown, ctx: HookHandlerContext) => fn(payload, ctx),
  }
}

/**
 * Subscribe a resolved hook sub on the {@link Hooks} facade. Routes by
 * the channel's declared shape (broadcast-async, broadcast-sync, chain,
 * stream — the facade picks the right backend).
 *
 * Errors and timeouts are absorbed by the bus so the agent never sees a
 * plugin exception.
 */
export function registerHookSub(
  hooks: Hooks,
  packageDir: string,
  sub: ResolvedHookSub,
  logger: (msg: string) => void,
  pluginId: string,
  agent: AgentContext | undefined,
  listCommands?: () => CommandInfo[],
  stdio?: HandlerStdio,
  diagnostics?: DiagnosticEmitter,
): void {
  const label = `${packageDir}:${sub.definition.id}`
  const channel = sub.definition.channel
  const emit = createShapeAwareEmit(hooks.eventBus, hooks, label, logger)
  const listener = (payload: unknown, ctx: { abort: AbortSignal; priority: number }): unknown => {
    // A run of a scoped session (a host with many sessions) gives its own agent.
    const live = scopedAgent(agent)
    const handlerCtx: HookHandlerContext = {
      channel,
      packageDir,
      cwd: process.cwd(),
      env: buildHandlerEnv(live),
      abort: ctx.abort,
      priority: ctx.priority,
      // Shape-aware emit so plugin hook handlers can fan out to other
      // channels regardless of shape (see createShapeAwareEmit).
      emit,
      ...(stdio?.stderr ? { stderr: stdio.stderr } : {}),
      log: createPluginLogger(pluginId, diagnostics),
      ...(listCommands ? { listCommands } : {}),
      agent: live,
    }
    // An approval gate (`failClosed`) rethrows, so the bus halts the chain.
    if (sub.definition.failClosed === true) return sub.invoke(payload, handlerCtx)
    try {
      return sub.invoke(payload, handlerCtx)
    } catch (e) {
      logger(`${label}: handler threw: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
  }
  hooks.on(channel, listener, {
    caller: "plugin",
    source: pluginId,
    priority: sub.definition.priority,
    timeoutMs: sub.definition.timeoutMs,
    observeOnly: sub.definition.observeOnly,
    failClosed: sub.definition.failClosed,
    label,
  })
}

/**
 * Subprocess event-handler protocol.
 *
 * The subprocess receives a JSON envelope on stdin:
 *
 *   `{event, payload, cwd, env}\n`
 *
 * It writes zero or more re-emit lines to stdout, one JSON object per
 * line:
 *
 *   `{"emit": "<event>", "payload": <any>}\n`
 *
 * Stdout EOF terminates parsing. Lines that don't parse, lack `emit`, or
 * specify a non-string event name are silently dropped — this is a
 * notification path, not a tool call; we don't want a sloppy plugin to
 * crash the bus.
 */
export async function invokeEventSubprocess(
  exe: string,
  args: string[],
  ctx: EventHandlerContext,
): Promise<void> {
  const proc = Bun.spawn([exe, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: ctx.packageDir,
    // `childEnv` drops `BUN_BE_BUN` even when a caller built `ctx.env` itself.
    env: childEnv(ctx.env),
    // Own process group, so the abort kill reaches a grandchild that holds
    // stdout open. A pid-only kill would leave the stdout read hanging.
    detached: true,
  })
  // Killed as a group at host exit by the registry. The entry is released
  // when the handler exits and no group member is left.
  registerChild(proc.pid, { group: true })
  // The manifest has no timeout for event subs, so the bus abort (agent
  // shutdown) is the only kill point besides the exit listener.
  const onAbort = (): void => {
    try {
      process.kill(-proc.pid, "SIGKILL")
      return
    } catch {
      // group gone or not a leader: fall through to the single pid
    }
    try {
      proc.kill("SIGKILL")
    } catch {
      /* already exited */
    }
  }
  if (ctx.abort?.aborted) onAbort()
  else ctx.abort?.addEventListener("abort", onAbort, { once: true })
  let out: string
  try {
    const envelope = JSON.stringify({
      event: ctx.event,
      payload: ctx.payload,
      cwd: ctx.cwd,
      env: ctx.env,
    })
    void proc.stdin.write(envelope + "\n")
    void proc.stdin.end()
    out = await new Response(proc.stdout).text()
    await proc.exited
  } finally {
    ctx.abort?.removeEventListener("abort", onAbort)
    childRegistry.releaseIfGone(proc.pid)
  }
  for (const raw of out.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { emit?: unknown }).emit === "string"
    ) {
      const p = parsed as { emit: string; payload?: unknown }
      ctx.emit(p.emit, p.payload)
    }
  }
}

// ---------------------------------------------------------------------------
// Slash command resolution
// ---------------------------------------------------------------------------

/**
 * Validate + normalize a command handler's return value at the trust
 * boundary (a plugin may return anything). Throws a descriptive error on
 * a malformed shape; the loader's `invoke` wrapper turns the throw into a
 * `{kind:"error"}` the host can render.
 *
 * @param out - Raw value the handler returned.
 * @param name - Command name, for error messages.
 * @returns A well-formed {@link CommandResult}.
 */
function normalizeCommandResult(out: unknown, name: string): CommandResult {
  if (out == null || typeof out !== "object") {
    throw new Error(
      `command "/${name}" returned ${out === null ? "null" : typeof out}. Expected a CommandResult object`,
    )
  }
  const kind = (out as { kind?: unknown }).kind
  switch (kind) {
    case "expand": {
      const prompt = (out as { prompt?: unknown }).prompt
      if (typeof prompt !== "string") {
        throw new Error(`command "/${name}" expand result needs a string "prompt"`)
      }
      return { kind: "expand", prompt }
    }
    case "notice": {
      const lines = (out as { lines?: unknown }).lines
      const block = (out as { block?: unknown }).block
      const result: Extract<CommandResult, { kind: "notice" }> = { kind: "notice" }
      if (lines !== undefined) {
        if (!Array.isArray(lines) || lines.some((l) => typeof l !== "string")) {
          throw new Error(`command "/${name}" notice result needs a string[] "lines"`)
        }
        result.lines = lines as string[]
      }
      if (block !== undefined) {
        result.block = normalizeCommandNoticeBlock(block, name)
      }
      if (result.lines === undefined && result.block === undefined) {
        throw new Error(`command "/${name}" notice result needs "lines" or "block"`)
      }
      return result
    }
    case "error": {
      const message = (out as { message?: unknown }).message
      if (typeof message !== "string") {
        throw new Error(`command "/${name}" error result needs a string "message"`)
      }
      return { kind: "error", message }
    }
    case "none":
      return { kind: "none" }
    default:
      throw new Error(`command "/${name}" returned unknown result kind ${JSON.stringify(kind)}`)
  }
}

function normalizeCommandNoticeBlock(
  block: unknown,
  name: string,
): NonNullable<Extract<CommandResult, { kind: "notice" }>["block"]> {
  if (block == null || typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`command "/${name}" notice block must be an object`)
  }
  const raw = block as Record<string, unknown>
  if (typeof raw.title !== "string" || raw.title.length === 0) {
    throw new Error(`command "/${name}" notice block needs a non-empty string "title"`)
  }
  const normalized: NonNullable<Extract<CommandResult, { kind: "notice" }>["block"]> = {
    title: raw.title,
  }
  for (const key of ["icon", "info", "timestamp", "footer", "color"] as const) {
    const value = raw[key]
    if (value !== undefined) {
      if (typeof value !== "string") {
        throw new Error(`command "/${name}" notice block field "${key}" must be a string`)
      }
      normalized[key] = value
    }
  }
  if (raw.body !== undefined) {
    if (!Array.isArray(raw.body) || raw.body.some((line) => typeof line !== "string")) {
      throw new Error(`command "/${name}" notice block field "body" must be a string[]`)
    }
    normalized.body = raw.body as string[]
  }
  return normalized
}

/**
 * Resolve a manifest slash command to an invocable form by importing its
 * module handler's default export. Module handlers only (the manifest
 * validator already enforces this). Returns `null` (with a logged
 * diagnostic) on any resolution failure, so one broken command never
 * disqualifies the rest of the plugin.
 *
 * @param spec - Validated manifest command entry.
 * @param pluginId - Owning plugin id.
 * @param packageDir - Absolute package dir (the command's cwd).
 * @param logger - Diagnostic sink.
 * @returns The resolved command, or `null` when it could not be loaded.
 */
export async function resolveCommand(
  spec: ManifestCommand,
  pluginId: string,
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedCommand | null> {
  if (spec.handler.type !== "module") {
    logger(`${packageDir}: command "/${spec.name}" handler must be module type; skipping`)
    return null
  }
  const pkg = pluginPackageFor(packageDir)
  const rel = spec.handler.path
  const abs = pkg.resolve(rel)
  if (!pkg.hasFile(rel)) {
    logger(`${packageDir}: command "/${spec.name}" handler module not found: ${abs}`)
    return null
  }
  let mod: { default?: CommandHandler }
  try {
    mod = (await pkg.importModule(rel)) as { default?: CommandHandler }
  } catch (e) {
    logger(
      `${packageDir}: failed to import command handler ${abs}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
  const fn = mod.default
  if (typeof fn !== "function") {
    logger(`${packageDir}: command handler ${abs} has no default export function`)
    return null
  }
  return {
    spec,
    pluginId,
    packageDir,
    entryAbsolute: abs,
    invoke: async (ctx: CommandContext): Promise<CommandResult> => {
      const out = await fn(ctx)
      return normalizeCommandResult(out, spec.name)
    },
  }
}
