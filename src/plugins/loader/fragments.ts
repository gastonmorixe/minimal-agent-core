/**
 * Async prompt-fragment producers for the plugin loader.
 *
 * A {@link ManifestPromptFragment} declares a module or subprocess
 * producer whose text is folded into a system-prompt slot
 * (`sessionContext` by default, or plain `afterInstructions` when set).
 * Producers are kicked off eagerly at `PluginLoader.load` time and
 * awaited (against their per-fragment timeout) on the first call to
 * `PluginLoader.getPromptBlocksAsync` / `getPromptBlockAsync`.
 *
 * Split out of `src/plugins/loader.ts` to keep that file under the
 * `max-lines` lint budget. Names are imported by the `PluginLoader`
 * class only and are NOT re-exported from `loader.ts` (no external
 * consumer touched them).
 *
 * @module plugins/loader/fragments
 */

import { childEnv } from "@minimal-agent/core/plugin-api/utils/self-spawn"

import { consumeStreamBounded } from "../../../plugin-api/src/utils/bounded-drain.ts"
import { createPluginLogger, type DiagnosticEmitter } from "../../bus/diagnostic-bus.ts"
import { childRegistry, registerChild } from "../../infra/child-registry.ts"
import { NO_SIDEBAND } from "../../sideband/api.ts"
import type { SidebandApi } from "../../sideband/types.ts"
import type { Hooks } from "../hooks/hooks.ts"
import type { PluginHost } from "../host/capabilities.ts"
import { buildPluginHost, type LoaderHostOptions } from "../host/factory.ts"
import { DEFAULT_PROMPT_EXPANDER, expandPluginText, type PromptExpander } from "../prompt-expand.ts"
import { createPluginPromptsContext } from "../prompts-context.ts"
import { pluginPackageFor } from "../source.ts"
import type {
  AgentContext,
  LoadedPlugin,
  ManifestPromptFragment,
  ModelInfoSnapshot,
  PluginPromptsContext,
  PromptFragmentContext,
  PromptFragmentHandler,
  PromptTemplateProvider,
  ResolvedHandler,
} from "../types.ts"

import { buildHandlerEnv, type HandlerStdio } from "./handler-env.ts"
import type { PendingFragment } from "./prompt-blocks.ts"
import { createShapeAwareEmit } from "./shape-emit.ts"

/**
 * Default per-fragment timeout in ms, applied when a manifest's
 * `promptFragments[].timeoutMs` is omitted. Short on purpose: fragments
 * gate the FIRST system-prompt assembly, so a slow probe must drop out
 * rather than stall the first turn.
 */
export const DEFAULT_FRAGMENT_TIMEOUT_MS = 2000

/**
 * Look up the {@link ManifestPromptFragment} definition for a given
 * plugin id + fragment id pair. Used by `resolveFragments` to retrieve
 * `timeoutMs` after the producer has been kicked off (we don't keep a
 * back-pointer from the pending-fragment record to the manifest entry).
 */
export function findFragmentDef(
  plugins: LoadedPlugin[],
  pluginId: string,
  fragmentId: string,
): ManifestPromptFragment | null {
  for (const pkg of plugins) {
    if (pkg.manifest.id !== pluginId) continue
    for (const f of pkg.manifest.promptFragments ?? []) {
      if (f.id === fragmentId) return f
    }
  }
  return null
}

/**
 * Start a prompt fragment producer.
 *
 * The returned promise resolves to the fragment text on success, or
 * `null` if the producer fails. Rejection paths (missing entry, import
 * error, non-zero exit) are converted to `null` here so the caller in
 * `resolveFragments` can treat success-or-drop uniformly.
 *
 * The producer runs immediately at loader-init time and is detached from
 * the boot path — its eventual error never throws synchronously.
 */
export function startFragment(
  frag: ManifestPromptFragment,
  packageDir: string,
  logger: (msg: string) => void,
  agent: AgentContext | undefined,
  pluginId: string,
  modelInfoProvider: (() => ModelInfoSnapshot | undefined) | undefined,
  registerDynamicTools?: (handlers: ResolvedHandler[]) => void,
  host?: PluginHost,
  stdio?: HandlerStdio,
  diagnostics?: DiagnosticEmitter,
  prompts?: PluginPromptsContext,
  emit?: (channel: string, payload?: unknown) => void,
  sideband?: SidebandApi,
  expand: PromptExpander = DEFAULT_PROMPT_EXPANDER,
): Promise<string | null> {
  return runFragment(
    frag,
    packageDir,
    agent,
    pluginId,
    modelInfoProvider,
    registerDynamicTools,
    host,
    stdio,
    diagnostics,
    prompts,
    emit,
    sideband,
    expand,
  ).catch((e) => {
    logger(
      `${packageDir}: prompt fragment "${frag.id}" failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  })
}

/**
 * Run one fragment producer to completion: import + call the module
 * handler, or spawn the subprocess and capture its stdout. Throws on
 * any failure; {@link startFragment} converts the rejection to `null`.
 */
async function runFragment(
  frag: ManifestPromptFragment,
  packageDir: string,
  agent: AgentContext | undefined,
  pluginId: string,
  modelInfoProvider: (() => ModelInfoSnapshot | undefined) | undefined,
  registerDynamicTools?: (handlers: ResolvedHandler[]) => void,
  host?: PluginHost,
  stdio?: HandlerStdio,
  diagnostics?: DiagnosticEmitter,
  prompts?: PluginPromptsContext,
  emit?: (channel: string, payload?: unknown) => void,
  sideband?: SidebandApi,
  expand: PromptExpander = DEFAULT_PROMPT_EXPANDER,
): Promise<string | null> {
  const ctrl = new AbortController()
  // The loader-level timeout in resolveFragments races this; if it wins,
  // we never see the resolved value. We still wire the abort signal in case
  // the handler wants to cooperatively stop. A subprocess probe is not
  // killed here: when the loader timeout wins, its text is dropped and the
  // probe runs on. Bun kills no child on exit, so the probe pid is in the
  // child registry (infra/child-registry), which kills it at CLI exit.
  void ctrl
  const env = buildHandlerEnv(agent)
  const pkg = pluginPackageFor(packageDir)

  if (frag.handler.type === "module") {
    const rel = frag.handler.path
    const abs = pkg.resolve(rel)
    if (!pkg.hasFile(rel)) {
      throw new Error(`module not found: ${abs}`)
    }
    const mod = (await pkg.importModule(rel)) as { default?: PromptFragmentHandler }
    const fn = mod.default
    if (typeof fn !== "function") {
      throw new Error(`${abs} has no default export function`)
    }
    const ctx: PromptFragmentContext = {
      packageDir,
      cwd: process.cwd(),
      env,
      // Deprecated mirror of `agent.sessionId` for back-compat readers.
      sessionId: agent?.sessionId,
      abort: ctrl.signal,
      ...(stdio?.stderr ? { stderr: stdio.stderr } : {}),
      log: createPluginLogger(pluginId, diagnostics),
      agent,
      ...(prompts ? { prompts } : {}),
      // Live model snapshot so a module fragment can gate its text on what the
      // active model supports (e.g. only emit tool-centric guidance when
      // `tools.userDefined`). Subprocess fragments don't get this (no JSON
      // round-trip wired); they remain `queryModelInfo`-less.
      ...(modelInfoProvider ? { queryModelInfo: modelInfoProvider } : {}),
      // Dynamic tool registration so prompt-fragment producers (e.g. the
      // skills plugin) can push skill-declared tools into the loader's tool
      // index. Absent for subprocess fragments; the Module path only.
      ...(registerDynamicTools ? { registerDynamicTools } : {}),
      // Capability host for THIS plugin (deny-by-default: undefined when the
      // plugin declared no `capabilities`). Lets a fragment producer run a
      // host-brokered action (e.g. memory's `ctx.host.llm.complete`) without
      // importing `src/`. Module fragments only.
      ...(host ? { host } : {}),
      // Shape-aware, never-throwing bus emit. It holds only the bus, so a
      // fragment may keep it and call it after it returns (e.g. a watcher
      // that emits `cache.didBreak`). Module fragments only.
      ...(emit ? { emit } : {}),
      // The one sideband API of the load (design step 5). NO_SIDEBAND when
      // the caller has none (a direct call in a test).
      sideband: sideband ?? NO_SIDEBAND,
    }
    const out = await fn(ctx)
    // S4 (design 50 §2): a string is data and passes unchanged. A
    // PromptTemplateText is rendered with its vars and `agentHome`.
    return (
      expandPluginText(out, expand, { source: `plugin:${pluginId}:fragment:${frag.id}` }) ?? null
    )
  }

  // subprocess
  const cmd = frag.handler.command
  const exe = cmd[0]
  if (!pkg.hasFile(exe)) {
    throw new Error(`subprocess executable not found: ${pkg.resolve(exe)}`)
  }
  // Disk: the resolved path. Embedded: the file extracted to `packageDir`,
  // so `TUI_PLUGIN_DIR` below names the directory that holds it.
  const exeAbs = pkg.execPath(exe)
  // Run the probe in the agent's cwd, not the plugin dir, so probes that
  // report `$PWD` / `git status` / etc. describe the agent's environment
  // (which is what env-info wants). The plugin dir is exposed via
  // TUI_PLUGIN_DIR so a probe that needs sibling files can still find them.
  const proc = Bun.spawn([exeAbs, ...cmd.slice(1)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: process.cwd(),
    env: childEnv({ ...env, TUI_PLUGIN_DIR: packageDir }),
    // NOT detached: the probe stays in the CLI process group and keeps the
    // controlling tty. Bun `detached` calls `setsid()`, which drops the tty
    // (https://pubs.opengroup.org/onlinepubs/9799919799/functions/setsid.html),
    // and env-info reads `stty size </dev/tty`.
  })
  // Killed by pid at host exit by the registry. The entry is released when
  // the probe exits. A probe grandchild (a `git` that the script runs) can
  // outlive the CLI. That is accepted, because the probe must keep the tty.
  registerChild(proc.pid, { group: false })
  try {
    // Empty stdin — fragments don't get a trigger envelope (there is none).
    void proc.stdin.end()
    const MAX_STDOUT_BYTES = 5 * 1024 * 1024 // 5MB cap
    let out: string
    try {
      out = await consumeStreamBounded(proc.stdout, MAX_STDOUT_BYTES)
    } catch (err: any) {
      killProbe(proc)
      throw new Error(`subprocess output exceeded max length: ${err.message}`, { cause: err })
    }
    const code = await proc.exited
    if (code !== 0) throw new Error(`exited with code ${code}`)
    return out
  } finally {
    childRegistry.releaseIfGone(proc.pid)
  }
}

/** SIGKILL the probe pid (not a group: the probe shares the CLI group). Never throws. */
function killProbe(proc: { kill(sig?: number | string): void }): void {
  try {
    proc.kill("SIGKILL")
  } catch {
    /* already exited */
  }
}

/** Inputs of {@link startPluginFragments}. */
export interface StartPluginFragmentsOptions {
  plugins: readonly LoadedPlugin[]
  logger: (msg: string) => void
  agent: AgentContext | undefined
  modelInfoProvider: (() => ModelInfoSnapshot | undefined) | undefined
  registerDynamicTools: (pluginId: string, handlers: ResolvedHandler[]) => void
  hostOptions:
    | Pick<LoaderHostOptions, "sessionsDir" | "isOwnedSession" | "noSessionFiles">
    | undefined
  stdio: HandlerStdio | undefined
  relay: DiagnosticEmitter
  promptProvider: () => PromptTemplateProvider | undefined
  defaultOrder: number
  /**
   * Hooks facade of the loader. Its `eventBus` is the shared plugin event
   * bus. When set, module fragments get `ctx.emit`.
   */
  hooks?: Hooks
  /** The one sideband API of the load (`ctx.sideband`). Default: `NO_SIDEBAND`. */
  sideband?: SidebandApi
  /** The prompt expander of the load (S4). Default: `DEFAULT_PROMPT_EXPANDER`. */
  expand?: PromptExpander
}

/**
 * Kick off every prompt fragment of every plugin, in plugin order. The host
 * capability is built per plugin (deny-by-default). Each module fragment
 * gets `ctx.prompts` for its own plugin, and `ctx.emit` when `bus` and
 * `hooks` are given.
 */
export function startPluginFragments(o: StartPluginFragmentsOptions): PendingFragment[] {
  const out: PendingFragment[] = []
  for (const pkg of o.plugins) {
    for (const frag of pkg.manifest.promptFragments ?? []) {
      const startedAt = Date.now()
      const promise = startFragment(
        frag,
        pkg.packageDir,
        o.logger,
        o.agent,
        pkg.manifest.id,
        o.modelInfoProvider,
        (handlers: ResolvedHandler[]) => o.registerDynamicTools(pkg.manifest.id, handlers),
        // Built directly: fragments start before the loader exists.
        (pkg.manifest.capabilities?.length ?? 0) > 0
          ? buildPluginHost({
              capabilities: pkg.manifest.capabilities ?? [],
              logger: createPluginLogger(pkg.manifest.id, o.relay),
              pluginName: pkg.manifest.id,
              pluginId: pkg.manifest.id,
              ...(o.hostOptions?.sessionsDir ? { sessionsDir: o.hostOptions.sessionsDir } : {}),
              ...(o.hostOptions?.isOwnedSession
                ? { isOwnedSession: o.hostOptions.isOwnedSession }
                : {}),
              ...(o.hostOptions?.noSessionFiles ? { noSessionFiles: true } : {}),
              ...(o.agent ? { activeSessionId: o.agent.sessionId } : {}),
              ...(o.sideband ? { sideband: o.sideband } : {}),
            })
          : undefined,
        o.stdio,
        o.relay,
        createPluginPromptsContext(o.promptProvider, pkg.manifest.id, pkg.packageDir),
        o.hooks
          ? createShapeAwareEmit(
              o.hooks.eventBus,
              o.hooks,
              `${pkg.packageDir}:${frag.id}`,
              o.logger,
            )
          : undefined,
        o.sideband,
        o.expand,
      )
      out.push({
        pluginId: pkg.manifest.id,
        fragmentId: frag.id,
        order: frag.order ?? o.defaultOrder,
        placement: frag.placement ?? "sessionContext",
        startedAt,
        promise,
      })
    }
  }
  return out
}
