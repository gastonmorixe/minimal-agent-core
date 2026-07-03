/**
 * Host-side setup orchestration: bridge plugin `setup()` results to the
 * {@link BinaryStore}, perform installs, and decide whether boot must halt.
 *
 * Flow (driven from `src/index.ts` at boot, before the REPL paints):
 *
 *   1. Build a {@link SetupBinaryInventory} adapter over the store and call
 *      `loader.runSetups(inventory)` → a list of per-plugin {@link SetupResult}.
 *   2. For each declared binary, classify it. `"satisfied"` → skip. Otherwise
 *      install/update via the store (which downloads, verifies sha256, extracts,
 *      installs, and records, with progress + audit).
 *   3. After provisioning, check each plugin's `haltIfMissing` names. If any is
 *      still absent, return a {@link ProvisionHalt} so boot can stop with a
 *      clear, actionable message instead of letting the user hit a broken tool.
 *
 * The plugin never performs a side effect; this module + the store do. All
 * binary lifecycle events (install / update / skip / failure / halt) are
 * emitted on the diagnostic bus, so the persistent global log
 * (`~/.minimal-agent/ma.log`) records the full audit trail.
 *
 * @module binaries/provision
 */

import { diag } from "../bus/diagnostic-bus.ts"
import type { SetupBinaryInventory, SetupBinarySpec, SetupResult } from "../plugins/types.ts"

import { BinaryStore } from "./store.ts"
import type { BinarySpec, InstallProgress } from "./types.ts"

/** A `setup()` result paired with the plugin that produced it. */
export interface PluginSetupResult {
  pluginId: string
  result: SetupResult
}

/** Returned when a mandatory binary could not be provisioned. */
export interface ProvisionHalt {
  /** Plugin that declared the missing requirement. */
  pluginId: string
  /** Logical binary names still missing after provisioning. */
  missing: string[]
  /** Plugin-supplied, user-facing explanation + remedy. */
  message: string
}

/** Summary of one provisioning pass. */
export interface ProvisionSummary {
  /** Binaries freshly installed this pass. */
  installed: string[]
  /** Binaries updated to a newer version this pass. */
  updated: string[]
  /** Binaries already satisfied (no work). */
  satisfied: string[]
  /** Binaries whose install/update failed. */
  failed: Array<{ name: string; detail: string }>
  /**
   * Version recorded per binary name touched this pass (installed / updated /
   * satisfied). Lets the caller render `+obscura (1780598942)` without re-reading
   * the store. Keyed by logical name.
   */
  versions: Record<string, string>
  /** Set when a mandatory requirement is unmet; boot should stop. */
  halt?: ProvisionHalt
}

/**
 * Adapt a {@link BinaryStore} to the plugin-facing {@link SetupBinaryInventory}.
 * Read-only projection; the plugin can inspect but not mutate.
 */
export function inventoryAdapter(store: BinaryStore): SetupBinaryInventory {
  return {
    dir: store.dir,
    has: (name) => store.has(name),
    get: (name) => {
      const e = store.get(name)
      return e ? { ...e } : undefined
    },
    status: (spec) => store.status(toBinarySpec(spec)),
  }
}

/** Map the plugin-facing spec to the internal store spec (identical fields). */
export function toBinarySpec(s: SetupBinarySpec): BinarySpec {
  return {
    name: s.name,
    version: s.version,
    source: s.source as BinarySpec["source"],
    sha256: s.sha256,
    ...(s.archiveMember ? { archiveMember: s.archiveMember } : {}),
    ...(s.archiveExtraMembers ? { archiveExtraMembers: s.archiveExtraMembers } : {}),
  }
}

/**
 * Provision every binary requested across all plugin setups, then evaluate
 * halt conditions. Best-effort + total: never throws into the boot path.
 *
 * @param store - The managed binary store (already wired with a progress sink
 *   + diagnostic logger by the caller).
 * @param setups - Output of `loader.runSetups()`.
 * @param onProgress - Optional per-binary progress sink for the host TUI. The
 *   store also reports progress through its own `onProgress`; this is a
 *   convenience passthrough so the caller can label per binary.
 */
export async function provisionSetups(
  store: BinaryStore,
  setups: PluginSetupResult[],
  onProgress?: (p: InstallProgress) => void,
): Promise<ProvisionSummary> {
  const summary: ProvisionSummary = {
    installed: [],
    updated: [],
    satisfied: [],
    failed: [],
    versions: {},
  }

  for (const { pluginId, result } of setups) {
    for (const spec of result.requireBinaries ?? []) {
      const binSpec = toBinarySpec(spec)
      // Record the spec version for every binary we touch, so the caller can
      // render it in the startup row regardless of outcome bucket.
      summary.versions[spec.name] = spec.version
      const status = store.status(binSpec)
      if (status === "satisfied") {
        summary.satisfied.push(spec.name)
        diag.info("binaries.satisfied", `${spec.name} ${spec.version} already current`, {
          plugin: pluginId,
          name: spec.name,
          version: spec.version,
        })
        continue
      }
      diag.notice("binaries.provision", `provisioning ${spec.name} ${spec.version} (${status})`, {
        plugin: pluginId,
        name: spec.name,
        version: spec.version,
        reason: status,
      })
      const outcome = await store.install(binSpec)
      if (onProgress) {
        // The store already emitted granular progress; emit a terminal marker
        // so a caller that only listens here still sees completion.
        onProgress({
          name: spec.name,
          version: spec.version,
          phase: outcome.ok ? "done" : "failed",
          fraction: outcome.ok ? 1 : null,
        })
      }
      if (outcome.ok) {
        if (outcome.action === "updated") summary.updated.push(spec.name)
        else summary.installed.push(spec.name)
      } else {
        summary.failed.push({ name: spec.name, detail: outcome.detail })
      }
    }
  }

  // Evaluate halt conditions AFTER all provisioning, so a plugin that lists
  // several mandatory binaries reports them together.
  for (const { pluginId, result } of setups) {
    const mandatory = result.haltIfMissing ?? []
    if (mandatory.length === 0) continue
    const missing = mandatory.filter((name) => !store.has(name))
    if (missing.length > 0) {
      const message =
        result.haltMessage ??
        `Plugin "${pluginId}" requires ${missing.join(", ")}, which could not be installed.`
      summary.halt = { pluginId, missing, message }
      diag.error("binaries.halt", `mandatory binaries missing for ${pluginId}`, {
        plugin: pluginId,
        missing: missing.join(","),
      })
      break // first halt wins; the host stops boot
    }
  }

  return summary
}
