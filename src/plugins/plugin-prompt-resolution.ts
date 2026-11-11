/**
 * Resolve plugin prompt-TEXT suppression from config, env, and CLI.
 *
 * This module decides WHICH plugin prompt text reaches the system prompt.
 * It decides nothing else. A suppressed plugin still loads, still advertises
 * its tools, and still runs its prompt fragments (a fragment can register
 * dynamic tools). Only the text is dropped.
 *
 * Precedence (highest wins): CLI \> env \> config file \> default
 * (nothing suppressed). Per tier, `all` overrides the lower tier's `all`.
 * Lists resolve per id, higher tier winning: a higher-tier `keep` removes
 * that id from a lower-tier `suppress` set, and a higher-tier `suppress`
 * removes that id from a lower-tier `keep` set.
 *
 * Pure: no I/O, no globals, no `process.env` read. The host reads the value
 * and passes it in. Mirrors {@link resolvePluginEnabledOverrides} in
 * `./plugin-enable-resolution.ts` — lifted out for unit tests.
 *
 * @module plugins/plugin-prompt-resolution
 */

/** The resolved suppression state handed to the loader. */
export interface PluginPromptSuppression {
  /** Suppress prompt text for every plugin that is not in `keep`. */
  readonly all: boolean
  /** Plugin ids whose prompt text is dropped, unless a higher tier keeps them. */
  readonly suppress: ReadonlySet<string>
  /** Plugin ids whose prompt text is kept, whatever `all` says. */
  readonly keep: ReadonlySet<string>
}

/**
 * An empty set that refuses writes.
 *
 * `Object.freeze` does NOT stop `Set.prototype.add` / `delete` / `clear`
 * (they mutate internal slots, not properties), so a frozen set would still
 * let one caller corrupt every other holder of the default. The proxy turns
 * the three mutators into a throw and forwards reads to the real set.
 */
function readonlyEmptySet(): ReadonlySet<string> {
  const target = new Set<string>()
  const deny = (): never => {
    throw new TypeError("NO_PLUGIN_PROMPT_SUPPRESSION is read-only")
  }
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "add" || prop === "delete" || prop === "clear") return deny
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** The default: every plugin keeps its prompt text. Deeply immutable. */
export const NO_PLUGIN_PROMPT_SUPPRESSION: PluginPromptSuppression = Object.freeze({
  all: false,
  suppress: readonlyEmptySet(),
  keep: readonlyEmptySet(),
})

/**
 * True when the prompt text of `pluginId` must be dropped.
 *
 * `keep` wins over `suppress`, and both win over `all`, so an explicit keep
 * of one id still works while `all` is on.
 */
export function isPluginPromptSuppressed(s: PluginPromptSuppression, pluginId: string): boolean {
  if (s.keep.has(pluginId)) return false
  if (s.suppress.has(pluginId)) return true
  return s.all
}

/** The `plugins.prompts` value as written in the user config file. */
export interface PluginPromptsConfigValue {
  /** Suppress prompt text for every plugin. Default: `false`. */
  readonly all?: boolean
  /** Plugin ids that keep their prompt text. */
  readonly keep?: readonly string[]
  /** Plugin ids whose prompt text is dropped. */
  readonly suppress?: readonly string[]
}

/** Input for {@link resolvePluginPromptSuppression}. */
export interface ResolvePluginPromptSuppressionInput {
  /** The `plugins.prompts` config value: `false`, `true`, or an object. */
  config?: PluginPromptsConfigValue | boolean | undefined
  /** The raw `MINIMAL_AGENT_PLUGIN_PROMPTS` env value. */
  env?: string | undefined
  /** The parsed CLI flags. */
  cli?:
    | {
        all?: boolean | undefined
        keep?: readonly string[] | undefined
        suppress?: readonly string[] | undefined
      }
    | undefined
}

/** One normalized tier: the `all` flag (when the tier sets it) plus its lists. */
interface Tier {
  all?: boolean
  keep: readonly string[]
  suppress: readonly string[]
}

/**
 * Merge config, env, and CLI into the final {@link PluginPromptSuppression}.
 *
 * A bad env value (`MINIMAL_AGENT_PLUGIN_PROMPTS=maybe`) is IGNORED and
 * reported in `warnings`, then the config tier applies. Accepted env values:
 * `1` / `true` (suppress all) and `0` / `false` (suppress none).
 */
export function resolvePluginPromptSuppression(input: ResolvePluginPromptSuppressionInput): {
  suppression: PluginPromptSuppression
  warnings: string[]
} {
  const warnings: string[] = []
  const config = configTier(input.config)
  const env = envTier(input.env, warnings)
  const cli = cliTier(input.cli)

  // `all` is a plain tier override; a list never sets it.
  const all = cli.all ?? env.all ?? config.all ?? false

  // Lists merge per id, higher tier winning. An `all` in a higher tier does
  // NOT erase a lower tier's lists: `keep` beats `all` by definition in
  // {@link isPluginPromptSuppressed}, so an explicit keep survives a
  // coarser suppress-everything switch.
  const keep = new Set<string>(config.keep)
  const suppress = new Set<string>(config.suppress)
  applyLists(keep, suppress, env)
  applyLists(keep, suppress, cli)

  return { suppression: { all, suppress, keep }, warnings }
}

/**
 * Apply one tier's lists over the running pair. A `keep` entry removes the
 * id from `suppress`. A `suppress` entry removes it from `keep`. `keep` is
 * applied last so a tier that lists an id in both wins as keep.
 */
function applyLists(keep: Set<string>, suppress: Set<string>, tier: Tier): void {
  for (const id of tier.suppress) {
    if (id.length === 0) continue
    suppress.add(id)
    keep.delete(id)
  }
  for (const id of tier.keep) {
    if (id.length === 0) continue
    keep.add(id)
    suppress.delete(id)
  }
}

/** Normalize the config value: `false` / `true` / an object / absent. */
function configTier(value: PluginPromptsConfigValue | boolean | undefined): Tier {
  if (value === true) return { all: true, keep: [], suppress: [] }
  if (value === false) return { all: false, keep: [], suppress: [] }
  if (value === undefined || value === null) return { keep: [], suppress: [] }
  return {
    ...(typeof value.all === "boolean" ? { all: value.all } : {}),
    keep: cleanIds(value.keep),
    suppress: cleanIds(value.suppress),
  }
}

/** Normalize the env grammar. A bad value pushes a warning and is ignored. */
function envTier(raw: string | undefined, warnings: string[]): Tier {
  const tier: Tier = { keep: [], suppress: [] }
  if (raw === undefined) return tier
  const value = raw.trim().toLowerCase()
  if (value === "1" || value === "true") return { ...tier, all: true }
  if (value === "0" || value === "false") return { ...tier, all: false }
  warnings.push(
    `MINIMAL_AGENT_PLUGIN_PROMPTS=${JSON.stringify(raw)} is not valid; ` +
      `ignored (accepted: 1, true, 0, false). Falling back to the config file.`,
  )
  return tier
}

/** Normalize the CLI tier. An absent `all` means "this tier does not decide". */
function cliTier(cli: ResolvePluginPromptSuppressionInput["cli"]): Tier {
  if (!cli) return { keep: [], suppress: [] }
  return {
    ...(typeof cli.all === "boolean" ? { all: cli.all } : {}),
    keep: cleanIds(cli.keep),
    suppress: cleanIds(cli.suppress),
  }
}

/** Trim, drop empty entries, and split comma-separated ids. */
function cleanIds(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return []
  const out: string[] = []
  for (const value of raw) {
    for (const part of value.split(",")) {
      const id = part.trim()
      if (id.length > 0) out.push(id)
    }
  }
  return out
}
