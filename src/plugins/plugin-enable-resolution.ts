/**
 * Resolve plugin enable/disable overrides from config, env, and CLI.
 *
 * Precedence (highest wins per id): CLI \> env \> config file \> manifest
 * default (manifest is applied later in the loader). Within each layer,
 * disable beats enable.
 *
 * Pure: no I/O, no globals. Mirrors {@link resolveEffort} /
 * {@link resolveShowHeader} — lifted out of `index.ts` for unit tests.
 *
 * @module plugin-enable-resolution
 */

export interface PluginEnableOverrideSets {
  forceDisabled: Set<string>
  forceEnabled: Set<string>
}

export interface ResolvePluginEnableInput {
  config: PluginEnableOverrideSets
  env?: { disable?: string; enable?: string }
  cli?: { disable?: readonly string[]; enable?: readonly string[] }
}

/**
 * Collect every value for a repeatable long flag from normalized argv.
 * Supports `--flag value`, `--flag=value`, and comma-separated ids
 * inside each value (`web-search,memory` → two ids).
 */
export function collectFlagValues(args: readonly string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith(`${name}=`)) {
      const v = a.slice(name.length + 1)
      if (v.length > 0) out.push(...splitIds(v))
      continue
    }
    if (a === name && args[i + 1] !== undefined && !args[i + 1].startsWith("-")) {
      out.push(...splitIds(args[i + 1]))
      i++
    }
  }
  return out
}

/** Parse a comma-separated env var value into trimmed, non-empty ids. */
export function parseCommaSeparatedIds(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return []
  return splitIds(raw)
}

/**
 * Merge config, env, and CLI override sets into the final
 * `forceDisabled` / `forceEnabled` pair passed to `PluginLoader.load`.
 */
export function resolvePluginEnabledOverrides(
  input: ResolvePluginEnableInput,
): PluginEnableOverrideSets {
  const forceDisabled = new Set(input.config.forceDisabled)
  const forceEnabled = new Set(input.config.forceEnabled)

  applyLayer(forceDisabled, forceEnabled, {
    enable: parseCommaSeparatedIds(input.env?.enable),
    disable: parseCommaSeparatedIds(input.env?.disable),
  })
  applyLayer(forceDisabled, forceEnabled, {
    enable: [...(input.cli?.enable ?? [])],
    disable: [...(input.cli?.disable ?? [])],
  })

  return { forceDisabled, forceEnabled }
}

function applyLayer(
  forceDisabled: Set<string>,
  forceEnabled: Set<string>,
  layer: { enable: readonly string[]; disable: readonly string[] },
): void {
  for (const id of layer.enable) {
    if (id.length === 0) continue
    forceEnabled.add(id)
    forceDisabled.delete(id)
  }
  for (const id of layer.disable) {
    if (id.length === 0) continue
    forceDisabled.add(id)
    forceEnabled.delete(id)
  }
}

function splitIds(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
