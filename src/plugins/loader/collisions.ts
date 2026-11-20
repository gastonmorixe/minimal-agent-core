/**
 * Load-time tool collision check (kept out of loader.ts for max-lines).
 *
 * @module plugins/loader/collisions
 */

import type { ManifestHandler } from "../types.ts"

/** A name index: only `has` is read (a `Map` or a `Set` fits). */
type NameIndex = { has(name: string): boolean }

/** The indexes a new plugin's names must not collide with. */
export interface CollisionIndexes {
  readonly coreToolNames: NameIndex
  readonly toolIndex: NameIndex
  readonly aliasIndex: NameIndex
  readonly tagIndex: NameIndex
}

/**
 * Check one plugin's tool and inline-tag handlers against the names
 * already taken. Returns the reject reason, or `null` when the plugin is
 * conflict-free. Partial acceptance would mean the plugin's PROMPT.md lies
 * about what's available, so one collision rejects the whole plugin.
 *
 * Aliases are checked against:
 *   - core tool names (no alias may shadow a core tool)
 *   - other plugins' canonical tool names (alias must not point at
 *     a different tool's canonical surface)
 *   - already-registered aliases (alias must not collide with
 *     another plugin's alias)
 *
 * A colliding alias is dropped (logged), not a reject. The surviving
 * aliases are written back to the handler. (Self-collision — alias ===
 * own canonical name, dups within the alias array — is caught earlier in
 * the manifest parser.)
 */
export function findToolCollision(
  tools: readonly ManifestHandler[],
  taken: CollisionIndexes,
  logger: (msg: string) => void,
): string | null {
  const { coreToolNames, toolIndex, aliasIndex, tagIndex } = taken
  for (const h of tools) {
    if (h.trigger.type === "tool") {
      const name = h.trigger.tool.name
      if (coreToolNames.has(name)) return `tool name "${name}" collides with a core tool`
      if (toolIndex.has(name) || aliasIndex.has(name)) {
        return `tool name "${name}" collides with another loaded plugin`
      }
      const validAliases: string[] = []
      for (const alias of h.trigger.tool.aliases ?? []) {
        if (coreToolNames.has(alias)) {
          logger(`dropping alias "${alias}" for tool "${name}": collides with a core tool`)
          continue
        }
        if (toolIndex.has(alias)) {
          logger(
            `dropping alias "${alias}" for tool "${name}": collides with another plugin's canonical tool`,
          )
          continue
        }
        if (aliasIndex.has(alias)) {
          logger(
            `dropping alias "${alias}" for tool "${name}": collides with another plugin's alias`,
          )
          continue
        }
        validAliases.push(alias)
      }
      h.trigger.tool.aliases = validAliases
    } else if (h.trigger.type === "inline_tag") {
      const tag = h.trigger.tag
      if (tagIndex.has(tag)) return `inline tag "${tag}" collides with another loaded plugin`
    }
  }
  return null
}
