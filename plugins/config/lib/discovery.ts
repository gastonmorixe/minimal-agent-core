/**
 * Plugin discovery → dynamic config fields.
 *
 * The static {@link SCHEMA} covers the fixed `UserConfig` knobs. The other
 * half of `config.jsonc` is `plugins.<id>.enabled` — one toggle per
 * installed plugin. Those can't be hardcoded (plugins come and go, and
 * third-party plugins under `~/.agents/plugins` or `<cwd>/.agents/plugins`
 * are unknown ahead of time), so we DISCOVER them by scanning the same
 * roots the host loader scans and reading each `manifest.json`.
 *
 * Pure-ish: all filesystem access goes through injected {@link DiscoverDeps},
 * so this is unit-testable with an in-memory tree and has zero host
 * coupling. The handler wires the real roots + `node:fs`.
 *
 * @module config/lib/discovery
 */

import type { Field } from "./schema.ts"

/** Injected filesystem surface for discovery. */
export interface DiscoverDeps {
  /** Plugin roots to scan, in precedence order (closer-to-user wins). */
  roots: string[]
  /** List subdirectory names of a path (empty on miss). */
  readDir(path: string): string[]
  /** Read a file body, or null on miss. */
  readFile(path: string): string | null
  /** Join path segments (injected so we don't import node:path into lib). */
  join(...parts: string[]): string
}

/** One discovered plugin. */
export interface DiscoveredPlugin {
  id: string
  name: string
  description: string
  /** Absolute package directory. */
  dir: string
  /** Root the plugin was found under (for diagnostics / grouping). */
  root: string
  /**
   * Author opt-out: manifest `enabled === false`. Surfaced so the UI can
   * note "(off by default)" — the user can still flip it on.
   */
  manifestDisabled: boolean
}

/**
 * Scan `deps.roots` for plugin packages (dirs containing `manifest.json`
 * with a string `id`). First-seen id wins (matches the loader's
 * precedence: project over home over embedded when roots are ordered that way).
 */
export function discoverPlugins(deps: DiscoverDeps): DiscoveredPlugin[] {
  const seen = new Set<string>()
  const out: DiscoveredPlugin[] = []
  for (const root of deps.roots) {
    for (const name of deps.readDir(root)) {
      const dir = deps.join(root, name)
      const body = deps.readFile(deps.join(dir, "manifest.json"))
      if (body === null) continue
      let manifest: Record<string, unknown>
      try {
        const parsed = JSON.parse(body)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
        manifest = parsed as Record<string, unknown>
      } catch {
        continue
      }
      const id = manifest.id
      if (typeof id !== "string" || id.length === 0) continue
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        name: typeof manifest.name === "string" ? manifest.name : id,
        description: typeof manifest.description === "string" ? manifest.description : "",
        dir,
        root,
        manifestDisabled: manifest.enabled === false,
      })
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/**
 * Build a dynamic `Field` per discovered plugin: a boolean toggle bound to
 * `plugins.<id>.enabled`. These are appended to the static schema so the
 * model + FSM + renderer treat them like any other boolean field.
 */
export function pluginFields(plugins: DiscoveredPlugin[]): Field[] {
  return plugins.map((p) => {
    const summary = firstSentence(p.description) || "(no description)"
    const hint = p.manifestDisabled ? "off by default" : "on"
    return {
      id: `plugin:${p.id}`,
      label: p.id,
      help: summary,
      kind: "boolean",
      path: ["plugins", p.id, "enabled"],
      section: "Plugins (enable / disable)",
      defaultHint: hint,
    }
  })
}

/** First sentence (or first ~90 chars) of a description, single-lined. */
function firstSentence(desc: string, max = 90): string {
  const flat = desc.replace(/\s+/g, " ").trim()
  const dot = flat.indexOf(". ")
  const cut = dot > 0 && dot < max ? dot + 1 : Math.min(flat.length, max)
  const out = flat.slice(0, cut).trim()
  return out.length < flat.length && !out.endsWith(".") ? out + "…" : out
}
