/**
 * Loader-side resolution of manifest-declared turn-attachment factories.
 *
 * A plugin may declare a `turnAttachments` array in its `manifest.json`
 * (see `plugins/tasks/manifest.json` for the canonical example): each
 * entry carries an `id`, an optional `order`, and a module `handler`
 * path.
 *
 * An entry binds a FACTORY to the agent's per-turn attachment seam: the
 * loader resolves the module through its blessed runtime-discovery seam
 * (computed dynamic import) and registers the default export into the
 * core registry in `src/agent/turn-attachments.ts`. The boot path
 * (`src/index.ts`) then instantiates the factories with the live
 * session context and hands the resulting producers/drains to the
 * Agent — WITHOUT core importing the plugins tree (the I2 invariant).
 * When no plugin registers anything, the agent simply emits no
 * plugin-sourced attachments.
 *
 * Validation is deliberately lenient and loader-local (the manifest
 * parser ignores the key entirely): a malformed entry, missing module,
 * or non-function export is logged and skipped — it never disqualifies
 * the plugin's tools. Key collisions across packages resolve first-wins
 * in load precedence order (project, then home, then user, then
 * embedded), mirroring the loader's tool-index and replay-renderer
 * policies.
 *
 * Split out of `loader.ts` for the same `max-lines` budget reason as
 * `./event-subs.ts`, `./helpers.ts`, and `./replay-renderers.ts`.
 *
 * @module plugins/loader/turn-attachments
 */

import { existsSync } from "node:fs"

import {
  registerTurnAttachmentFactory,
  type TurnAttachmentFactory,
} from "../../agent/turn-attachments.ts"

import { resolvePath } from "./helpers.ts"

/**
 * Resolve and register every `turnAttachments` entry of one package.
 *
 * @param rawEntries - The raw `turnAttachments` value straight from the
 *   package's `manifest.json` (unvalidated; the manifest parser does
 *   not model this key).
 * @param pluginId - The owning plugin's manifest id (registry keys are
 *   `<pluginId>/<entryId>`).
 * @param packageDir - Absolute package directory for path resolution
 *   and log prefixes.
 * @param claimedKeys - Registry keys already claimed by an earlier
 *   (higher-precedence) package in this load. Mutated in place.
 * @param logger - Diagnostic sink for skipped entries.
 */
export async function registerManifestTurnAttachments(
  rawEntries: unknown,
  pluginId: string,
  packageDir: string,
  claimedKeys: Set<string>,
  logger: (msg: string) => void,
): Promise<void> {
  if (rawEntries == null) return
  if (!Array.isArray(rawEntries)) {
    logger(`${packageDir}: turnAttachments must be an array; skipping`)
    return
  }
  for (const entry of rawEntries) {
    if (typeof entry !== "object" || entry === null) {
      logger(`${packageDir}: turn attachment entry must be an object; skipping`)
      continue
    }
    const e = entry as Record<string, unknown>
    const id = typeof e.id === "string" ? e.id : ""
    const handler = (e.handler ?? null) as Record<string, unknown> | null
    const handlerType = handler && typeof handler.type === "string" ? handler.type : ""
    const handlerPath = handler && typeof handler.path === "string" ? handler.path : ""
    if (id === "" || handlerType !== "module" || handlerPath === "") {
      logger(
        `${packageDir}: turn attachment entry needs an "id" and a ` +
          `module handler ({type:"module", path}); skipping`,
      )
      continue
    }
    const key = `${pluginId}/${id}`
    if (claimedKeys.has(key)) {
      logger(
        `${packageDir}: turn attachment "${key}" already registered ` +
          `by a higher-precedence plugin; skipping`,
      )
      continue
    }
    const abs = resolvePath(packageDir, handlerPath)
    if (!existsSync(abs)) {
      logger(`${packageDir}: turn attachment module not found: ${abs}; skipping`)
      continue
    }
    let fn: unknown
    try {
      const mod = (await import(abs)) as { default?: unknown }
      fn = mod.default
    } catch (err) {
      logger(
        `${packageDir}: turn attachment import failed for ${abs}: ` +
          `${err instanceof Error ? err.message : String(err)}; skipping`,
      )
      continue
    }
    if (typeof fn !== "function") {
      logger(`${packageDir}: turn attachment ${abs} has no default export function; skipping`)
      continue
    }
    claimedKeys.add(key)
    const order = typeof e.order === "number" && Number.isFinite(e.order) ? e.order : undefined
    registerTurnAttachmentFactory(
      key,
      fn as TurnAttachmentFactory,
      order === undefined ? {} : { order },
    )
  }
}
