/**
 * Plugin `setup()` execution for the loader's binary-provisioning phase.
 *
 * Each plugin may declare an optional `setup` module in its manifest;
 * the handler reports which managed binaries the plugin needs (see
 * `SetupResult`). This module runs those handlers WITHOUT performing
 * any side effect — the host entry point owns downloads, TUI
 * progress, syslog audit, and halting boot.
 *
 * Split out of `src/plugins/loader.ts` to keep that file under the
 * `max-lines` lint budget. The only caller is
 * `PluginLoader.runSetups`, which delegates here; the names are NOT
 * re-exported from `loader.ts`.
 *
 * @module plugins/loader/setups
 */

import { createPluginLogger, type DiagnosticEmitter } from "../../bus/diagnostic-bus.ts"
import { pluginPackageFor } from "../source.ts"
import type {
  AgentContext,
  LoadedPlugin,
  SetupBinaryInventory,
  SetupHandler,
  SetupResult,
} from "../types.ts"

import { buildHandlerEnv } from "./handler-env.ts"

/**
 * Run every loaded plugin's optional `setup()` handler, in declaration
 * order, handing each the shared binary inventory. Returns the
 * structured {@link SetupResult}s (one per plugin that declares
 * `setup`).
 *
 * A plugin whose `setup()` throws is logged and skipped (its result is
 * dropped) so one broken setup can't poison boot. Each handler call is
 * bounded by `timeoutMs` via an AbortController.
 *
 * @param plugins - The loader's accepted plugin packages.
 * @param inventory - The managed-binary inventory adapter the host
 *   builds from its `BinaryStore` (in `../../binaries/store.ts`).
 * @param logger - The loader's diagnostic sink.
 * @param timeoutMs - Per-handler timeout budget in ms.
 * @param agent - Frozen main-agent identity, forwarded as `ctx.agent`
 *   and as `MINIMAL_AGENT_*` env vars (may be `undefined` in ad-hoc
 *   tests).
 */
export async function runPluginSetups(
  plugins: LoadedPlugin[],
  inventory: SetupBinaryInventory,
  logger: (msg: string) => void,
  timeoutMs: number,
  agent: AgentContext | undefined,
  diagnostics?: DiagnosticEmitter,
): Promise<Array<{ pluginId: string; result: SetupResult }>> {
  const out: Array<{ pluginId: string; result: SetupResult }> = []
  for (const pkg of plugins) {
    const entry = pkg.manifest.setup
    if (!entry || entry.type !== "module") continue
    const pluginId = pkg.manifest.id
    const source = pluginPackageFor(pkg.packageDir)
    const abs = source.resolve(entry.path)
    if (!source.hasFile(entry.path)) {
      logger(`${pkg.packageDir}: setup module not found: ${abs}`)
      continue
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    try {
      const mod = (await source.importModule(entry.path)) as { default?: SetupHandler }
      const fn = mod.default
      if (typeof fn !== "function") {
        logger(`${abs}: setup has no default export function`)
        continue
      }
      const result = await fn({
        packageDir: pkg.packageDir,
        cwd: process.cwd(),
        env: buildHandlerEnv(agent),
        abort: ctrl.signal,
        log: createPluginLogger(pluginId, diagnostics),
        agent,
        binaries: inventory,
      })
      if (result && typeof result === "object") out.push({ pluginId, result })
    } catch (e) {
      logger(`${pkg.packageDir}: setup failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return out
}
