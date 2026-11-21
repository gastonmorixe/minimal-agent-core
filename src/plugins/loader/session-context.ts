/**
 * Pure composer of the plugin `sessionContext` system-prompt block.
 *
 * Moved out of `src/plugins/loader.ts` (`buildBlock`) to keep that file
 * under the `max-lines` lint budget. The output text is byte-identical to
 * the old method. It also returns the owner of each section, in wire order,
 * so a host can show where each section came from.
 *
 * @module plugins/loader/session-context
 */

import { renderCoreBody } from "../../sideband/core-render.ts"
import type { SidebandApi } from "../../sideband/types.ts"
import type { PluginPromptSuppression } from "../plugin-prompt-resolution.ts"
import { isPluginPromptSuppressed } from "../plugin-prompt-resolution.ts"
import type { LoadedPlugin, ToolAvailabilityContext } from "../types.ts"

import {
  classifyPluginPrompt,
  PROMPT_ROLE_ORDER,
  type PromptRole,
  stripLeadingHeading,
} from "./helpers.ts"
import { isPluginToolAvailable } from "./late.ts"
import type { SessionContextSection } from "./prompt-blocks.ts"

/** Input of {@link composeSessionContext}. */
export interface SessionContextInput {
  /** Loaded plugins, in load order. */
  readonly plugins: readonly LoadedPlugin[]
  /** sessionContext fragment texts by plugin id, or `null` to omit fragments. */
  readonly fragmentTexts: Map<string, string[]> | null
  /** Per-plugin prompt-text suppression. */
  readonly pluginPrompts: PluginPromptSuppression
  /** Context for the tool availability predicates. */
  readonly availability: ToolAvailabilityContext
  /** Loader logger, for a predicate that throws. */
  readonly logger: (message: string) => void
  /**
   * The sideband API of the load (design step 7). It renders each section
   * as one system role kind (`behavior`, `context`, `emit`, `mode`, `tool`).
   */
  readonly sideband: Pick<SidebandApi, "render">
}

/** Result of {@link composeSessionContext}. */
export interface SessionContextResult {
  /** The block text, or `null` when no plugin contributes. */
  readonly text: string | null
  /** The sections of {@link SessionContextResult.text}, in wire order. */
  readonly sections: SessionContextSection[]
}

/**
 * Compose the sessionContext block. See `PluginLoader.buildBlock` for the
 * rules: one section per contributing plugin, sorted by role then name, a
 * `-N` suffix on a same-(role,name) collision.
 */
export function composeSessionContext(input: SessionContextInput): SessionContextResult {
  if (input.plugins.length === 0) return { text: null, sections: [] }
  const sections: {
    role: PromptRole
    name: string
    body: string
    pluginId: string
    packageDir: string
  }[] = []
  for (const pkg of input.plugins) {
    // Prompt-text suppression (per plugin): the plugin keeps running, but
    // contributes no section, so its PROMPT.md body and its
    // sessionContext fragment text never reach the model.
    if (isPluginPromptSuppressed(input.pluginPrompts, pkg.manifest.id)) continue
    // Drop the prompt section for a plugin whose ENTIRE tool surface is
    // currently hidden by availability predicates. A multi-tool plugin keeps
    // its section as long as at least one tool is advertised (its shared
    // PROMPT.md still describes the visible tools). A plugin contributing no
    // tools at all (behavior/context) is never affected.
    const toolHandlers = pkg.handlers.filter((h) => h.definition.trigger.type === "tool")
    if (
      toolHandlers.length > 0 &&
      !toolHandlers.some((h) => isPluginToolAvailable(h, input.availability, input.logger))
    ) {
      continue
    }
    const promptBody = pkg.prompt ? stripLeadingHeading(pkg.prompt) : ""
    const frags = input.fragmentTexts?.get(pkg.manifest.id) ?? []
    const fragSection = frags.length > 0 ? frags.map((t) => t.trimEnd()).join("\n\n") : ""
    if (!promptBody && !fragSection) continue
    const body =
      promptBody && fragSection ? `${promptBody}\n\n${fragSection}` : promptBody || fragSection
    const { role, name } = classifyPluginPrompt(pkg)
    sections.push({ role, name, body, pluginId: pkg.manifest.id, packageDir: pkg.packageDir })
  }
  if (sections.length === 0) return { text: null, sections: [] }
  // Deterministic order: role group, then name (alpha), then body as a
  // final tiebreak so two same-role same-name sections (unusual) stay
  // stable. Keeps the cached prefix byte-identical across discovery orders.
  sections.sort(
    (a, b) =>
      PROMPT_ROLE_ORDER[a.role] - PROMPT_ROLE_ORDER[b.role] ||
      a.name.localeCompare(b.name) ||
      (a.body < b.body ? -1 : a.body > b.body ? 1 : 0),
  )
  // Disambiguate same-(role,name) collisions deterministically. tool/emit/
  // mode names are already globally unique (the loader rejects colliding
  // tool/tag/mode ids before we get here), so this only ever fires for
  // behavior/context sections whose H1/display-name slugs happen to match.
  // Suffixing keeps every section addressable by a distinct name rather
  // than emitting two identical `name="…"` wrappers.
  const seen = new Map<string, number>()
  for (const s of sections) {
    const key = `${s.role}\u0000${s.name}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    if (n > 1) s.name = `${s.name}-${n}`
  }
  // The codec renders each section (kind = role, raw block body). With no
  // codec, or no kind of that role, a section is its body with no wrapper
  // ({@link renderCoreBody}): the plugin text stays, in the same order and
  // with the same separator. A body is never "" here (see the loop above).
  const rendered = sections.map((s) => ({
    s,
    text: renderCoreBody(input.sideband, s.role, { attrs: { name: s.name }, body: s.body }),
  }))
  return {
    text: rendered.map((r) => r.text).join("\n\n"),
    sections: rendered.map(({ s: { role, name, pluginId, packageDir } }) => ({
      role,
      name,
      pluginId,
      packageDir,
    })),
  }
}
