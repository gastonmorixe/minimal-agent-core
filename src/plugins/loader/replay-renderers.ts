/**
 * Loader-side resolution of manifest-declared replay renderers.
 *
 * A plugin may declare a `replayRenderers` array in its `manifest.json`
 * (see `plugins/tasks/manifest.json` for the canonical example): each
 * entry carries an `id`, a `tool` name, and a module `handler` path.
 *
 * An entry binds a TOOL NAME to a module handler that re-renders that
 * tool's historical `tool_result` rows at `--resume` replay time (ANSI
 * styling, sidecar-driven snapshots, …). The loader resolves the module
 * through its blessed runtime-discovery seam (computed dynamic import)
 * and registers it into the core registry in
 * `src/session-replay-derivers.ts`. Core replay then delegates per-tool
 * rendering WITHOUT importing the plugins tree (the I2 invariant); when
 * no plugin registers a renderer, core falls back to its plain-text
 * derivations.
 *
 * Validation is deliberately lenient and loader-local (the manifest
 * parser ignores the key entirely): a malformed entry, missing module,
 * or non-function export is logged and skipped — it never disqualifies
 * the plugin's tools. Tool-name collisions across plugins resolve
 * first-wins in load precedence order (project, then home, then user,
 * then embedded), mirroring the loader's tool-index policy.
 *
 * Split out of `loader.ts` for the same `max-lines` budget reason as
 * `./event-subs.ts` and `./helpers.ts`.
 *
 * @module plugins/loader/replay-renderers
 */

import { existsSync } from "node:fs"

import { type ReplayToolRenderer, registerReplayRenderer } from "../../session-replay-derivers.ts"

import { resolvePath } from "./helpers.ts"

/**
 * Resolve and register every `replayRenderers` entry of one package.
 *
 * @param rawEntries - The raw `replayRenderers` value straight from the
 *   package's `manifest.json` (unvalidated; the manifest parser does
 *   not model this key).
 * @param packageDir - Absolute package directory for path resolution
 *   and log prefixes.
 * @param claimedTools - Tool names already claimed by an earlier
 *   (higher-precedence) package in this load. Mutated in place.
 * @param logger - Diagnostic sink for skipped entries.
 */
export async function registerManifestReplayRenderers(
  rawEntries: unknown,
  packageDir: string,
  claimedTools: Set<string>,
  logger: (msg: string) => void,
): Promise<void> {
  if (rawEntries == null) return
  if (!Array.isArray(rawEntries)) {
    logger(`${packageDir}: replayRenderers must be an array; skipping`)
    return
  }
  for (const entry of rawEntries) {
    if (typeof entry !== "object" || entry === null) {
      logger(`${packageDir}: replay renderer entry must be an object; skipping`)
      continue
    }
    const e = entry as Record<string, unknown>
    const tool = typeof e.tool === "string" ? e.tool : ""
    const handler = (e.handler ?? null) as Record<string, unknown> | null
    const handlerType = handler && typeof handler.type === "string" ? handler.type : ""
    const handlerPath = handler && typeof handler.path === "string" ? handler.path : ""
    if (tool === "" || handlerType !== "module" || handlerPath === "") {
      logger(
        `${packageDir}: replay renderer entry needs a "tool" name and a ` +
          `module handler ({type:"module", path}); skipping`,
      )
      continue
    }
    if (claimedTools.has(tool)) {
      logger(
        `${packageDir}: replay renderer for tool "${tool}" already registered ` +
          `by a higher-precedence plugin; skipping`,
      )
      continue
    }
    const abs = resolvePath(packageDir, handlerPath)
    if (!existsSync(abs)) {
      logger(`${packageDir}: replay renderer module not found: ${abs}; skipping`)
      continue
    }
    let fn: unknown
    try {
      const mod = (await import(abs)) as { default?: unknown }
      fn = mod.default
    } catch (err) {
      logger(
        `${packageDir}: replay renderer import failed for ${abs}: ` +
          `${err instanceof Error ? err.message : String(err)}; skipping`,
      )
      continue
    }
    if (typeof fn !== "function") {
      logger(`${packageDir}: replay renderer ${abs} has no default export function; skipping`)
      continue
    }
    claimedTools.add(tool)
    registerReplayRenderer(tool, fn as ReplayToolRenderer)
  }
}
