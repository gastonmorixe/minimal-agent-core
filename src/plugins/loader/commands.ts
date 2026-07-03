/**
 * Command registry and dispatch for slash commands.
 *
 * Collects resolved commands from all loaded plugins, handles first-wins
 * collision dedupe, and provides the dispatch entry point the REPL calls
 * when the user submits a `/name` line.
 *
 * Extracted from `src/plugins/loader.ts` (T-8a0c44) to keep the loader
 * under its soft line-count limit.
 *
 * @module plugins/loader/commands
 */

import { createPluginLogger, diag } from "../../bus/diagnostic-bus.ts"
import { parseCommandLine } from "../../cli/slash-command-parse.ts"
import { agentContextToEnv } from "../agent-context.ts"
import { EventBus } from "../event-bus.ts"
import { CHANNEL_BY_NAME } from "../hooks/channels.ts"
import { Hooks } from "../hooks/hooks.ts"
import type { PluginHost } from "../host/capabilities.ts"
import type {
  AgentContext,
  CommandContext,
  CommandInfo,
  CommandResult,
  ResolvedCommand,
} from "../types.ts"

/** Options for constructing a {@link CommandRegistry}. */
export interface CommandRegistryOptions {
  /** Per-dispatch timeout in ms. */
  timeoutMs: number
  /** Main-agent identity, forwarded to every command context. */
  agent: AgentContext | undefined
  /** Shared event bus for broadcast-async emits. */
  eventBus: EventBus
  /** Hooks facade for broadcast-sync / chain emits. */
  hooksFacade: Hooks
  /** Diagnostic sink for collision warnings. */
  logger: (msg: string) => void
  /**
   * Resolves a plugin's frozen capability host (deny-by-default: `undefined`
   * when the plugin declared no `capabilities`). Threaded into every command
   * context as `ctx.host` so a command can run a host-brokered read (e.g.
   * `/usage` → `ctx.host.usage.reports()`) without importing `src/`. Optional
   * for back-compat test callers that build a registry without a loader.
   */
  hostFor?: (pluginId: string) => PluginHost | undefined
}

/**
 * Registry of slash commands loaded from plugins.
 *
 * Built once at loader boot. Provides the dispatch entry point and
 * read-only query methods the host (REPL, slash-menu overlay) consumes.
 */
export class CommandRegistry {
  /** Command name → ResolvedCommand map (first-wins across plugins). */
  readonly index: Map<string, ResolvedCommand>
  private readonly timeoutMs: number
  private readonly agent: AgentContext | undefined
  private readonly eventBus: EventBus
  private readonly hooksFacade: Hooks
  private readonly logger: (msg: string) => void
  private readonly hostFor: ((pluginId: string) => PluginHost | undefined) | undefined

  constructor(
    /** Resolved commands from every loaded plugin (flattened). */
    commands: ResolvedCommand[],
    opts: CommandRegistryOptions,
  ) {
    this.timeoutMs = opts.timeoutMs
    this.agent = opts.agent
    this.eventBus = opts.eventBus
    this.hooksFacade = opts.hooksFacade
    this.logger = opts.logger
    this.hostFor = opts.hostFor

    // Build the global command index, first-wins on cross-plugin name
    // collision (mirrors mode-id dedupe). A colliding command is dropped
    // with a diagnostic; the rest of the plugin is unaffected.
    this.index = new Map<string, ResolvedCommand>()
    for (const cmd of commands) {
      const name = cmd.spec.name
      const existing = this.index.get(name)
      if (existing) {
        this.logger(
          `command "/${name}" from "${cmd.pluginId}" collides with "${existing.pluginId}"; ` +
            `keeping the first and skipping`,
        )
        continue
      }
      this.index.set(name, cmd)
    }
  }

  /**
   * All registered slash commands (post collision-dedupe), sorted by
   * name for stable display. The host's command dispatcher and the
   * `slash-menu` overlay both read this.
   */
  getCommands(): ReadonlyArray<ResolvedCommand> {
    return [...this.index.values()].sort((a, b) => a.spec.name.localeCompare(b.spec.name))
  }

  /**
   * O(1) check whether a command name is registered. The REPL uses this
   * to decide, synchronously at submit time, whether a `/<name>` line is
   * a command (dispatch it) or just text (queue it as a prompt).
   *
   * @param name - Command name without the leading slash.
   */
  hasCommand(name: string): boolean {
    return this.index.has(name)
  }

  /**
   * Read-only metadata view of every registered command. This is the
   * shape exposed to plugin handler contexts via `listCommands()` so the
   * `slash-menu` overlay can render/filter without importing the loader.
   */
  listCommandInfo(): CommandInfo[] {
    return this.getCommands().map((c) => {
      const info: CommandInfo = {
        name: c.spec.name,
        summary: c.spec.summary,
        pluginId: c.pluginId,
      }
      if (c.spec.argHint != null) info.argHint = c.spec.argHint
      return info
    })
  }

  /**
   * Dispatch a submitted line as a slash command.
   *
   * Returns `null` when `line` is not a command line OR names an
   * unregistered command — in both cases the host treats the text as an
   * ordinary prompt (so pasted paths like `/usr/bin` and unknown `/foo`
   * fall through untouched). Returns a {@link CommandResult} otherwise;
   * a handler throw (or malformed return) is caught and surfaced as
   * `{kind:"error"}` so a buggy command never crashes the REPL.
   *
   * The `opts` bag carries `cwd` (defaults to `process.cwd()`) and an
   * optional external abort `signal` composed with the per-call timeout.
   *
   * @param line - Raw submitted text.
   */
  async dispatchCommand(
    line: string,
    opts: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<CommandResult | null> {
    const parsed = parseCommandLine(line)
    if (!parsed) return null
    const cmd = this.index.get(parsed.name)
    if (!cmd) return null

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    timer.unref?.()
    let externalAbortListener: (() => void) | undefined
    if (opts.signal) {
      if (opts.signal.aborted) ctrl.abort()
      else {
        externalAbortListener = () => ctrl.abort()
        opts.signal.addEventListener("abort", externalAbortListener, { once: true })
      }
    }

    const ctx: CommandContext = {
      name: parsed.name,
      argv: parsed.argv,
      rawLine: line,
      cwd: opts.cwd ?? process.cwd(),
      env: {
        ...process.env,
        TUI_PLUGIN_PROTOCOL: "1",
        ...(this.agent ? agentContextToEnv(this.agent) : {}),
      } as Record<string, string>,
      abort: ctrl.signal,
      log: createPluginLogger(cmd.pluginId),
      // Shape-aware emit so a command can fan out to ANY channel
      // regardless of bus. Declared channels route via the channel
      // catalog's shape: `broadcast-async` (and ad-hoc, undeclared
      // names) go straight to the EventBus; `broadcast-sync` / `chain`
      // / `stream` route through the Hooks facade onto the HookBus.
      // Without this an interactive command (e.g. `/config` painting
      // its overlay via `editor.footer.set`, a broadcast-sync channel)
      // would silently emit into the void — the host listener lives on
      // the HookBus, not the EventBus. Mirrors the event-sub / hook-sub
      // emit in `src/plugins/loader/event-subs.ts`.
      emit: (channel: string, payload?: unknown) => {
        const shape = CHANNEL_BY_NAME.get(channel)?.shape
        try {
          if (shape === "broadcast-async" || shape === undefined) {
            this.eventBus.emit(channel, payload)
            return
          }
          this.hooksFacade.emitSync(channel, payload)
        } catch (e) {
          diag.warn(
            "plugins",
            `command "/${parsed.name}" emit("${channel}") failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          )
        }
      },
      agent: this.agent,
      ...(this.hostFor?.(cmd.pluginId) ? { host: this.hostFor(cmd.pluginId) } : {}),
    }

    try {
      return await cmd.invoke(ctx)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { kind: "error", message: `/${parsed.name} failed: ${msg}` }
    } finally {
      clearTimeout(timer)
      if (opts.signal && externalAbortListener) {
        opts.signal.removeEventListener("abort", externalAbortListener)
      }
    }
  }
}
