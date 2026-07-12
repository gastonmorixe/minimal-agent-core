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

import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

import { consumeStreamBounded } from "@minimal-agent/plugin-api/utils/bounded-drain"
import { paletteEnvJson } from "@minimal-agent/plugin-api/utils/palette"

import { createPluginLogger } from "../../bus/diagnostic-bus.ts"
import { agentContextToEnv } from "../agent-context.ts"
import type { PluginHost } from "../host/capabilities.ts"
import type {
  AgentContext,
  LoadedPlugin,
  ManifestPromptFragment,
  ModelInfoSnapshot,
  PromptFragmentContext,
  PromptFragmentHandler,
  ResolvedHandler,
} from "../types.ts"

import { resolvePath } from "./helpers.ts"

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
): Promise<string | null> {
  return runFragment(
    frag,
    packageDir,
    agent,
    pluginId,
    modelInfoProvider,
    registerDynamicTools,
    host,
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
): Promise<string | null> {
  const ctrl = new AbortController()
  // The loader-level timeout in resolveFragments races this; if it wins,
  // we never see the resolved value. We still wire the abort signal in case
  // the handler wants to cooperatively stop. (For subprocess we don't kill
  // the process here — that's intentional: a stuck probe is dropped, not
  // surfaced, and the OS reaps it on agent exit.)
  void ctrl
  const env = {
    ...process.env,
    TUI_PLUGIN_PROTOCOL: "1",
    MINIMAL_AGENT_PALETTE: paletteEnvJson(),
    ...(agent ? agentContextToEnv(agent) : {}),
  } as Record<string, string>

  if (frag.handler.type === "module") {
    const abs = resolvePath(packageDir, frag.handler.path)
    if (!existsSync(abs)) {
      throw new Error(`module not found: ${abs}`)
    }
    const mod = (await import(abs)) as { default?: PromptFragmentHandler }
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
      stderr: process.stderr,
      log: createPluginLogger(pluginId),
      agent,
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
    }
    const out = await fn(ctx)
    return typeof out === "string" ? out : null
  }

  // subprocess
  const cmd = frag.handler.command
  const exe = cmd[0]
  const exeAbs = isAbsolute(exe) ? exe : resolve(packageDir, exe)
  if (!existsSync(exeAbs)) {
    throw new Error(`subprocess executable not found: ${exeAbs}`)
  }
  // Run the probe in the agent's cwd, not the plugin dir, so probes that
  // report `$PWD` / `git status` / etc. describe the agent's environment
  // (which is what env-info wants). The plugin dir is exposed via
  // TUI_PLUGIN_DIR so a probe that needs sibling files can still find them.
  const proc = Bun.spawn([exeAbs, ...cmd.slice(1)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: process.cwd(),
    env: { ...env, TUI_PLUGIN_DIR: packageDir },
  })
  // Empty stdin — fragments don't get a trigger envelope (there is none).
  void proc.stdin.end()
  const MAX_STDOUT_BYTES = 5 * 1024 * 1024 // 5MB cap
  let out: string
  try {
    out = await consumeStreamBounded(proc.stdout, MAX_STDOUT_BYTES)
  } catch (err: any) {
    proc.kill("SIGKILL")
    throw new Error(`subprocess output exceeded max length: ${err.message}`, { cause: err })
  }
  const code = await proc.exited
  if (code !== 0) throw new Error(`exited with code ${code}`)
  return out
}
