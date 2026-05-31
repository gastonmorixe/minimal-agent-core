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

import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

import { createPluginLogger } from "../../diagnostic-bus.ts"
import { paletteEnvJson } from "../../palette.ts"
import { agentContextToEnv } from "../agent-context.ts"
import { EventBus, type EventContext } from "../event-bus.ts"
import { CHANNEL_BY_NAME } from "../hooks/channels.ts"
import { Hooks } from "../hooks/hooks.ts"
import type {
  AgentContext,
  CommandContext,
  CommandHandler,
  CommandInfo,
  CommandResult,
  EventHandler,
  EventHandlerContext,
  HookHandlerContext,
  LiveAreaHandler,
  LiveAreaHandlerContext,
  ManifestCommand,
  ManifestEventSubscription,
  ManifestHookSubscription,
  ManifestLiveAreaSlot,
  ResolvedCommand,
  ResolvedEventSub,
  ResolvedHookSub,
  ResolvedLiveAreaSlot,
} from "../types.ts"

import { resolvePath } from "./helpers.ts"

/** Module-handler default-export signature for hook subscriptions. */
type HookHandler<TPayload = unknown> = (payload: TPayload, ctx: HookHandlerContext) => unknown

// ---------------------------------------------------------------------------
// Event subscription resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a manifest event subscription to an invocable form. Mirrors
 * {@link resolveHandler} but for one-way event handlers (no `TUIResult`,
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
  if (sub.handler.type === "module") {
    const abs = resolvePath(packageDir, sub.handler.path)
    if (!existsSync(abs)) {
      logger(`${packageDir}: event handler module not found: ${abs}`)
      return null
    }
    let mod: { default?: EventHandler }
    try {
      mod = await import(abs)
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
  const exeAbs = isAbsolute(exe) ? exe : resolve(packageDir, exe)
  if (!existsSync(exeAbs)) {
    logger(`${packageDir}: event subprocess executable not found: ${exeAbs}`)
    return null
  }
  return {
    definition: sub,
    entryAbsolute: exeAbs,
    invoke: async (ctx) => invokeEventSubprocess(exeAbs, cmd.slice(1), ctx),
  }
}

/**
 * Subscribe a resolved event sub on the shared bus. The bus owns
 * coalesce/throttle/error handling; we just adapt its `EventContext`
 * (event + payload + emit + abort) to the plugin's
 * `EventHandlerContext` (which adds `packageDir`, `cwd`, `env`, `stderr`).
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
): void {
  const label = `${packageDir}:${sub.definition.id}`
  const listener = (ctx: EventContext): void | Promise<void> => {
    const handlerCtx: EventHandlerContext = {
      event: ctx.event,
      payload: ctx.payload,
      packageDir,
      cwd: process.cwd(),
      env: {
        ...process.env,
        TUI_PLUGIN_PROTOCOL: "1",
        MINIMAL_AGENT_PALETTE: paletteEnvJson(),
        ...(agent ? agentContextToEnv(agent) : {}),
      } as Record<string, string>,
      // Shape-aware emit:
      //
      //   1. **Declared channels** (in `channels.ts`) route via the
      //      Hooks facade, which picks emitSync / emitAsync based on
      //      the channel's declared shape. Required for channels like
      //      `editor.footer.set` (broadcast-sync, host listener lives
      //      on the HookBus, NOT the EventBus).
      //
      //   2. **Ad-hoc channels** (no declaration) fall through to the
      //      raw EventBus emit. Preserves the legacy "any string is a
      //      valid event name" contract that pre-Hooks tests rely on.
      emit: (chan: string, p?: unknown) => {
        const shape = CHANNEL_BY_NAME.get(chan)?.shape
        try {
          if (shape === "broadcast-async" || shape === undefined) {
            // Ad-hoc OR declared-async: go via EventBus directly. For
            // declared-async we could call hooks.emitAsync but the
            // round-trip is the same listener set.
            bus.emit(chan, p)
            return
          }
          // broadcast-sync / chain / stream — must go via Hooks facade.
          hooks.emitSync(chan, p)
        } catch (e) {
          logger(`${label}: emit("${chan}") failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      },
      abort: ctx.abort,
      stderr: process.stderr,
      log: createPluginLogger(pluginId),
      ...(listCommands ? { listCommands } : {}),
      agent,
    }
    try {
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
  const abs = resolvePath(packageDir, sub.handler.path)
  if (!existsSync(abs)) {
    logger(`${packageDir}: hook handler module not found: ${abs}`)
    return null
  }
  let mod: { default?: HookHandler }
  try {
    mod = (await import(abs)) as { default?: HookHandler }
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
): void {
  const label = `${packageDir}:${sub.definition.id}`
  const channel = sub.definition.channel
  const listener = (payload: unknown, ctx: { abort: AbortSignal; priority: number }): unknown => {
    const handlerCtx: HookHandlerContext = {
      channel,
      packageDir,
      cwd: process.cwd(),
      env: {
        ...process.env,
        TUI_PLUGIN_PROTOCOL: "1",
        MINIMAL_AGENT_PALETTE: paletteEnvJson(),
        ...(agent ? agentContextToEnv(agent) : {}),
      } as Record<string, string>,
      abort: ctx.abort,
      priority: ctx.priority,
      // Shape-aware emit so plugin hook handlers can fan out to other
      // channels regardless of shape. Declared channels route via the
      // Hooks facade (which picks the right bus); ad-hoc channels go
      // straight to EventBus to preserve legacy behavior.
      emit: (chan: string, p?: unknown) => {
        const shape = CHANNEL_BY_NAME.get(chan)?.shape
        try {
          if (shape === "broadcast-async" || shape === undefined) {
            hooks.eventBus.emit(chan, p)
            return
          }
          hooks.emitSync(chan, p)
        } catch (e) {
          logger(`${label}: emit("${chan}") failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      },
      stderr: process.stderr,
      log: createPluginLogger(pluginId),
      ...(listCommands ? { listCommands } : {}),
      agent,
    }
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
    env: ctx.env,
  })
  const envelope = JSON.stringify({
    event: ctx.event,
    payload: ctx.payload,
    cwd: ctx.cwd,
    env: ctx.env,
  })
  void proc.stdin.write(envelope + "\n")
  void proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited
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

/**
 * Resolve a single {@link ManifestLiveAreaSlot} to invocable form.
 *
 * Module handlers must `export default` a {@link LiveAreaHandler}. The
 * loader applies normalized defaults (position=`"footer"`,
 * refreshMs=60_000, timeoutMs=5000) before invocation so the scheduler
 * never has to second-guess them.
 *
 * Returns `null` (with a logged diagnostic) on missing module / bad
 * default export / missing executable. The plugin's tools and other
 * subscriptions are NOT affected — broken slot ≠ broken plugin.
 */
export async function resolveLiveAreaSlot(
  slot: ManifestLiveAreaSlot,
  pluginId: string,
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedLiveAreaSlot | null> {
  const definition: ManifestLiveAreaSlot = {
    ...slot,
    position: slot.position ?? "footer",
    refreshMs: slot.refreshMs ?? 60_000,
    timeoutMs: slot.timeoutMs ?? 5000,
    // Pass through verbatim — empty string is a deliberate opt-out;
    // undefined means "no row reserved before first invoke".
    placeholder: slot.placeholder,
    // Normalize undefined/null → empty array so the scheduler can iterate
    // without a null check.
    refreshOn: slot.refreshOn ?? [],
  }

  if (slot.handler.type === "module") {
    const abs = resolvePath(packageDir, slot.handler.path)
    if (!existsSync(abs)) {
      logger(`${packageDir}: live-area slot handler module not found: ${abs}`)
      return null
    }
    let mod: { default?: LiveAreaHandler }
    try {
      mod = await import(abs)
    } catch (e) {
      logger(
        `${packageDir}: failed to import live-area slot handler ${abs}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
      return null
    }
    const fn = mod.default
    if (typeof fn !== "function") {
      logger(`${packageDir}: live-area slot handler ${abs} has no default export function`)
      return null
    }
    return {
      definition,
      pluginId,
      packageDir,
      entryAbsolute: abs,
      invoke: async (ctx: LiveAreaHandlerContext) => {
        const out = await fn(ctx)
        if (out == null) return null
        if (typeof out !== "string") {
          throw new Error(
            `live-area slot "${slot.id}" returned non-string (${typeof out}); expected string | null`,
          )
        }
        return out
      },
    }
  }

  // subprocess
  const cmd = slot.handler.command
  const exe = cmd[0]
  const exeAbs = isAbsolute(exe) ? exe : resolve(packageDir, exe)
  if (!existsSync(exeAbs)) {
    logger(`${packageDir}: live-area slot executable not found: ${exeAbs}`)
    return null
  }
  return {
    definition,
    pluginId,
    packageDir,
    entryAbsolute: exeAbs,
    invoke: async (ctx: LiveAreaHandlerContext) => {
      const proc = Bun.spawn([exeAbs, ...cmd.slice(1)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        cwd: ctx.packageDir,
        env: ctx.env,
      })
      const envelope = JSON.stringify({ tick: ctx.tick, cwd: ctx.cwd, env: ctx.env })
      void proc.stdin.write(envelope + "\n")
      void proc.stdin.end()
      const out = await new Response(proc.stdout).text()
      await proc.exited
      const trimmed = out.replace(/\n+$/, "")
      return trimmed.length === 0 ? null : trimmed
    },
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
 * @param out Raw value the handler returned.
 * @param name Command name, for error messages.
 * @returns A well-formed {@link CommandResult}.
 */
function normalizeCommandResult(out: unknown, name: string): CommandResult {
  if (out == null || typeof out !== "object") {
    throw new Error(
      `command "/${name}" returned ${out === null ? "null" : typeof out}; expected a CommandResult object`,
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
      if (!Array.isArray(lines) || lines.some((l) => typeof l !== "string")) {
        throw new Error(`command "/${name}" notice result needs a string[] "lines"`)
      }
      return { kind: "notice", lines: lines as string[] }
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

/**
 * Resolve a manifest slash command to an invocable form by importing its
 * module handler's default export. Module handlers only (the manifest
 * validator already enforces this). Returns `null` (with a logged
 * diagnostic) on any resolution failure, so one broken command never
 * disqualifies the rest of the plugin.
 *
 * @param spec Validated manifest command entry.
 * @param pluginId Owning plugin id.
 * @param packageDir Absolute package dir (the command's cwd).
 * @param logger Diagnostic sink.
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
  const abs = resolvePath(packageDir, spec.handler.path)
  if (!existsSync(abs)) {
    logger(`${packageDir}: command "/${spec.name}" handler module not found: ${abs}`)
    return null
  }
  let mod: { default?: CommandHandler }
  try {
    mod = await import(abs)
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
