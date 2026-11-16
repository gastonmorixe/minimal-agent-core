/**
 * Boot glue for the prompt providers: the `prompts.template` provider and the
 * `systemPromptBase` provider. The loader owns the holders. A slot conflict
 * is reported as a typed diagnostic with identifiers only.
 *
 * @module plugins/loader/system-prompt-base-boot
 */

import { setSystemPromptBase } from "../../llm/system-prompt-base-registry.ts"
import { loadPromptTemplateProvider, type PromptProviderHolder } from "../prompts-context.ts"
import {
  createSystemPromptBaseHolder,
  loadSystemPromptBaseProvider,
  type SystemPromptBaseHolder,
} from "../system-prompt-base.ts"

import type { DiagnosticsRelay } from "./diagnostics-relay.ts"

export type { SystemPromptBaseHolder }

/** The two provider holders of one load. */
export interface PromptBoot {
  /** The `prompts.template` provider holder. */
  template: PromptProviderHolder
  /** The `systemPromptBase` providers. */
  systemBase: SystemPromptBaseHolder
}

/** Make empty holders. */
export function createPromptBoot(): PromptBoot {
  return { template: { current: undefined }, systemBase: createSystemPromptBaseHolder() }
}

/**
 * Store the holder of `boot` as the process-wide base holder. Returns the
 * release function. The release clears the slot only while this holder is current.
 */
export function registerBootHolder(boot: PromptBoot): () => void {
  return setSystemPromptBase(boot.systemBase)
}

/** An empty holder, for a loader that has no boot yet. */
export const noSystemPromptBase = (): SystemPromptBaseHolder => createSystemPromptBaseHolder()

/**
 * Load the template provider, then the system prompt base provider, of one
 * plugin. A conflict warns with identifiers only. `overridden` holds the
 * contracts of this plugin that a closer root tier owns (F2). Never throws.
 */
export async function bootPromptProviders(
  boot: PromptBoot,
  raws: {
    promptTemplateRaw: ReadonlyMap<string, unknown>
    systemPromptBaseRaw: ReadonlyMap<string, unknown>
  },
  pkg: { packageDir: string; manifest: { id: string } },
  logger: (msg: string) => void,
  relay: DiagnosticsRelay,
  overridden?: ReadonlySet<string>,
): Promise<void> {
  const dir = pkg.packageDir
  // F2: `text.system.<slot>` contracts a closer tier owns, as slot names.
  const prefix = "text.system."
  const except = new Set(
    [...(overridden ?? [])].filter((c) => c.startsWith(prefix)).map((c) => c.slice(prefix.length)),
  )
  await loadPromptTemplateProvider(raws.promptTemplateRaw.get(dir), dir, boot.template, logger)
  await loadSystemPromptBaseProvider(
    raws.systemPromptBaseRaw.get(dir),
    dir,
    boot.systemBase,
    pkg.manifest.id,
    (f) => relay.warn("prompt.system_base_load_failed", "", { ...f }),
    (e) =>
      relay.warn("prompt.system_base_slot_conflict", "", {
        slot: e.slot,
        owner: e.pluginIds[0],
        refused: e.pluginIds[1],
      }),
    except,
  )
}
