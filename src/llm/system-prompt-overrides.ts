/**
 * Shared system-prompt override model.
 *
 * This module is intentionally pure. Startup code resolves CLI/env/config/file
 * inputs into the small raw source shape below, then both the legacy Agent and
 * modern AgentCore pass the resulting {@link SystemPromptOverrides} object into
 * the same prompt assembly seam. Builders never receive raw flags.
 *
 * @module llm/system-prompt-overrides
 */

/** A single system-prompt part after precedence and conflicts are resolved. */
export type PromptPartOverride =
  | { readonly kind: "default" }
  | { readonly kind: "replace"; readonly text: string }
  | { readonly kind: "omit" }

/** No override: preserve the current default bytes. */
export const DEFAULT_PROMPT_PART_OVERRIDE: PromptPartOverride = { kind: "default" }

/** Named prompt parts supported by the shared override seam. */
export const SYSTEM_PROMPT_OVERRIDE_PARTS = [
  "full",
  "identity",
  "providerPreamble",
  "instructions",
  "loopSafety",
  "toolOutputConventions",
  "sessionContext",
] as const

/** A named prompt part supported by the shared override seam. */
export type SystemPromptOverridePart = (typeof SYSTEM_PROMPT_OVERRIDE_PARTS)[number]

/** Resolved system-prompt overrides consumed by prompt builders. */
export interface SystemPromptOverrides {
  /** Replace or omit the whole core-controllable system prompt body. */
  readonly full?: PromptPartOverride
  /** Replace or omit the neutral identity block. Providers may still replace it. */
  readonly identity?: PromptPartOverride
  /** Replace or omit provider-owned preamble blocks, if that provider permits it. */
  readonly providerPreamble?: PromptPartOverride
  /** Replace or omit the base instructions fragment. */
  readonly instructions?: PromptPartOverride
  /** Replace or omit the loop-safety fragment. */
  readonly loopSafety?: PromptPartOverride
  /** Replace or omit the tool-output-conventions fragment. */
  readonly toolOutputConventions?: PromptPartOverride
  /** Replace or omit the session-context block currently carrying plugin prompts. */
  readonly sessionContext?: PromptPartOverride
  /** Explicit opt-in for provider preamble replacement/omission. */
  readonly unsafeProviderOverrides?: boolean
}

/** Raw input for one prompt part from one precedence tier. */
export interface PromptPartOverrideSource {
  /** Inline replacement text from a flag, env var, or config value. */
  readonly text?: string
  /** Replacement text loaded from a file before calling the pure resolver. */
  readonly fileText?: string
  /** Explicit omit signal, e.g. `--no-system-instructions` or config `false`. */
  readonly omit?: boolean
}

/** Raw input for every supported part from one precedence tier. */
export type SystemPromptOverrideSourceSet = Partial<
  Record<SystemPromptOverridePart, PromptPartOverrideSource>
> & {
  /** Explicit opt-in for provider preamble replacement/omission. */
  readonly unsafeProviderOverrides?: boolean
}

/** Raw CLI/env/config inputs before precedence collapse. */
export interface SystemPromptOverrideSources {
  readonly cli?: SystemPromptOverrideSourceSet
  readonly env?: SystemPromptOverrideSourceSet
  readonly config?: SystemPromptOverrideSourceSet
}

/** Conflict raised while resolving raw prompt override inputs. */
export class SystemPromptOverrideError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(
      `invalid system prompt override${problems.length === 1 ? "" : "s"}: ${problems.join("; ")}`,
    )
    this.name = "SystemPromptOverrideError"
    this.problems = problems
  }
}

type SourceName = "cli" | "env" | "config"

const SOURCE_ORDER: readonly SourceName[] = ["cli", "env", "config"]

/** Return true when a resolved override changes default behavior. */
export function isActivePromptOverride(override: PromptPartOverride | undefined): boolean {
  return override !== undefined && override.kind !== "default"
}

/** Apply a resolved override to a text fragment. */
export function applyPromptPartOverride(
  defaultText: string | undefined,
  override: PromptPartOverride | undefined,
): string | undefined {
  if (override === undefined || override.kind === "default") return defaultText
  if (override.kind === "omit") return undefined
  return override.text
}

/** True when the struct contains at least one active prompt override. */
export function hasSystemPromptOverrides(overrides: SystemPromptOverrides | undefined): boolean {
  if (!overrides) return false
  return SYSTEM_PROMPT_OVERRIDE_PARTS.some((part) => isActivePromptOverride(overrides[part]))
}

/**
 * Resolve raw CLI/env/config prompt overrides into the shared tri-state model.
 *
 * Precedence is CLI \> env \> config \> default. Within a single tier, text,
 * fileText, and omit are mutually exclusive. An empty replacement string means
 * omit, matching the CLI contract for `--flag ""`.
 */
export function resolveSystemPromptOverrides(
  sources: SystemPromptOverrideSources = {},
): SystemPromptOverrides {
  const problems: string[] = []
  const out: Partial<Record<SystemPromptOverridePart, PromptPartOverride>> & {
    unsafeProviderOverrides?: boolean
  } = {}

  for (const part of SYSTEM_PROMPT_OVERRIDE_PARTS) {
    const resolved = resolvePart(part, sources, problems)
    if (resolved && resolved.kind !== "default") out[part] = resolved
  }

  const unsafeProviderOverrides = resolveUnsafeProviderOverrides(sources)
  validateResolvedOverrides(out, unsafeProviderOverrides, problems)

  if (problems.length > 0) throw new SystemPromptOverrideError(problems)

  if (unsafeProviderOverrides !== undefined) out.unsafeProviderOverrides = unsafeProviderOverrides

  return out
}

function validateResolvedOverrides(
  out: Partial<Record<SystemPromptOverridePart, PromptPartOverride>>,
  unsafeProviderOverrides: boolean | undefined,
  problems: string[],
): void {
  if (isActivePromptOverride(out.providerPreamble) && unsafeProviderOverrides !== true) {
    problems.push("providerPreamble override requires --unsafe-system-prompt-overrides")
  }

  if (isActivePromptOverride(out.full)) {
    for (const part of SYSTEM_PROMPT_OVERRIDE_PARTS) {
      if (part === "full" || part === "providerPreamble") continue
      if (isActivePromptOverride(out[part])) delete out[part]
    }
  }
}

function resolvePart(
  part: SystemPromptOverridePart,
  sources: SystemPromptOverrideSources,
  problems: string[],
): PromptPartOverride | undefined {
  for (const sourceName of SOURCE_ORDER) {
    const source = sources[sourceName]?.[part]
    if (!hasSourceSignal(source)) continue

    const conflict = conflictForSource(part, sourceName, source)
    if (conflict) {
      problems.push(conflict)
      return undefined
    }

    if (source.omit === true) return { kind: "omit" }
    if (source.text !== undefined)
      return source.text === "" ? { kind: "omit" } : { kind: "replace", text: source.text }
    if (source.fileText !== undefined) {
      return source.fileText === "" ? { kind: "omit" } : { kind: "replace", text: source.fileText }
    }
  }
  return undefined
}

function hasSourceSignal(
  source: PromptPartOverrideSource | undefined,
): source is PromptPartOverrideSource {
  return (
    source !== undefined &&
    (source.omit === true || source.text !== undefined || source.fileText !== undefined)
  )
}

function conflictForSource(
  part: SystemPromptOverridePart,
  sourceName: SourceName,
  source: PromptPartOverrideSource,
): string | null {
  const signals: string[] = []
  if (source.text !== undefined) signals.push("text")
  if (source.fileText !== undefined) signals.push("file")
  if (source.omit === true) signals.push("omit")
  if (signals.length <= 1) return null
  return `${sourceName}.${part} sets conflicting ${signals.join(" + ")} overrides`
}

function resolveUnsafeProviderOverrides(sources: SystemPromptOverrideSources): boolean | undefined {
  for (const sourceName of SOURCE_ORDER) {
    const value = sources[sourceName]?.unsafeProviderOverrides
    if (value !== undefined) return value
  }
  return undefined
}
