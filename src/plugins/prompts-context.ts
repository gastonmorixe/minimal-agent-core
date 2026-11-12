/**
 * `ctx.prompts` for plugin contexts, and the loader side of the
 * `prompts.template` slot. Holds no prompt text and no marker syntax.
 *
 * @module plugins/prompts-context
 */

import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

import { CoreError } from "../errors/core-error.ts"

import type {
  ManifestPromptTemplate,
  PluginPromptsContext,
  PromptTemplateProvider,
  PromptTemplateVars,
} from "./types.ts"

/** Thrown when a plugin calls `ctx.prompts` and no provider is loaded. */
export class PromptTemplateProviderMissingError extends CoreError {
  static readonly kind = "PromptTemplateProviderMissingError"
  declare readonly kind: "PromptTemplateProviderMissingError"
  /** Id of the plugin that called. */
  readonly pluginId: string

  constructor(pluginId: string, options?: { cause?: unknown }) {
    super(options)
    this.pluginId = pluginId
  }
}

/** Private holder for the loaded provider. */
export interface PromptProviderHolder {
  /** The provider, once the template plugin is loaded. */
  current: PromptTemplateProvider | undefined
}

/**
 * Build `ctx.prompts` for one plugin. `render` adds only the plugin id and
 * dir. With no provider, both methods throw
 * {@link PromptTemplateProviderMissingError}.
 */
export function createPluginPromptsContext(
  provider: () => PromptTemplateProvider | undefined,
  pluginId: string,
  pluginDir: string,
): PluginPromptsContext {
  const need = (): PromptTemplateProvider => {
    const p = provider()
    if (p === undefined) throw new PromptTemplateProviderMissingError(pluginId)
    return p
  }
  return {
    render: (name: string, vars?: PromptTemplateVars): string =>
      need().render({ pluginId, pluginDir, name, ...(vars !== undefined ? { vars } : {}) }),
    expand: (text: string): string => need().expand(text),
  }
}

/** Parse a raw `promptTemplate` value. Returns undefined when it is not `{id, entry}` of non-empty strings. */
export function parsePromptTemplateRaw(raw: unknown): ManifestPromptTemplate | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const { id, entry } = raw as Record<string, unknown>
  if (typeof id !== "string" || id.length === 0) return undefined
  if (typeof entry !== "string" || entry.length === 0) return undefined
  return { id, entry }
}

/** Shape check for a provider object. */
function isProvider(v: unknown): v is PromptTemplateProvider {
  if (v === null || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return typeof o.render === "function" && typeof o.expand === "function"
}

/**
 * Import the provider entry of the template plugin and store it in `holder`.
 * The default export is a factory or a provider object. A failure is passed
 * to `logger` and leaves the holder empty. Never throws.
 */
export async function loadPromptTemplateProvider(
  raw: unknown,
  packageDir: string,
  holder: PromptProviderHolder,
  logger: (msg: string) => void,
): Promise<void> {
  const decl = parsePromptTemplateRaw(raw)
  if (decl === undefined) return
  const abs = isAbsolute(decl.entry) ? decl.entry : resolve(packageDir, decl.entry)
  try {
    if (!existsSync(abs)) throw new Error(`module not found: ${abs}`)
    const mod = (await import(abs)) as { default?: unknown }
    const made = typeof mod.default === "function" ? (mod.default as () => unknown)() : mod.default
    if (!isProvider(made)) throw new Error(`${abs} has no provider export`)
    holder.current = made
  } catch (e) {
    logger(`${packageDir}: promptTemplate failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
