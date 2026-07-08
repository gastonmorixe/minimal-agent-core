import { readFileSync } from "node:fs"

import type { SystemPromptUserConfig, UserConfig } from "../config/config.ts"
import {
  type PromptPartOverrideSource,
  resolveSystemPromptOverrides,
  SystemPromptOverrideError,
  type SystemPromptOverridePart,
  type SystemPromptOverrideSourceSet,
  type SystemPromptOverrides,
} from "../llm/system-prompt-overrides.ts"

import { SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS } from "./system-prompt-override-flags.ts"

type MutablePromptPartOverrideSource = {
  text?: string
  fileText?: string
  omit?: boolean
}

type MutableSystemPromptOverrideSourceSet = Partial<
  Record<SystemPromptOverridePart, PromptPartOverrideSource>
> & {
  unsafeProviderOverrides?: boolean
}

/** Minimal environment shape for system-prompt override resolution. */
export type SystemPromptOverrideEnv = Record<string, string | undefined>

/** Filesystem reader dependency, injected by tests and defaulted in production. */
export type SystemPromptOverrideFileReader = (path: string) => string

/** Resolve CLI/env/config system-prompt overrides for startup. */
export function resolveSystemPromptOverridesForStartup(input: {
  readonly args: readonly string[]
  readonly env: SystemPromptOverrideEnv
  readonly config: UserConfig
  readonly readFile?: SystemPromptOverrideFileReader
}): SystemPromptOverrides {
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, "utf8"))
  const cli = sourceSetFromArgs(input.args, readFile)
  const env = sourceSetFromEnv(input.env, readFile, activeParts(cli))
  const config = sourceSetFromConfig(input.config, readFile, activeParts(cli, env))
  return resolveSystemPromptOverrides({ cli, env, config })
}

function activeParts(
  ...sets: readonly SystemPromptOverrideSourceSet[]
): ReadonlySet<SystemPromptOverridePart> {
  const out = new Set<SystemPromptOverridePart>()
  for (const set of sets) {
    for (const spec of SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS) {
      if (hasSource(set[spec.part] ?? {})) out.add(spec.part)
    }
  }
  return out
}

function sourceSetFromArgs(
  args: readonly string[],
  readFile: SystemPromptOverrideFileReader,
): SystemPromptOverrideSourceSet {
  const out: MutableSystemPromptOverrideSourceSet = {}
  const problems: string[] = []
  for (const spec of SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS) {
    const source: MutablePromptPartOverrideSource = {}
    if (args.includes(spec.noFlag)) source.omit = true
    const text = readArgValue(args, spec.valueFlag)
    if (text !== undefined) source.text = text
    const filePath = readArgValue(args, spec.fileFlag)
    if (filePath !== undefined)
      source.fileText = readOverrideFile(spec.fileFlag, filePath, readFile, problems)
    if (hasSource(source)) out[spec.part] = source
  }
  if (args.includes("--unsafe-system-prompt-overrides")) out.unsafeProviderOverrides = true
  if (problems.length > 0) throw new SystemPromptOverrideError(problems)
  return out
}

function sourceSetFromEnv(
  env: SystemPromptOverrideEnv,
  readFile: SystemPromptOverrideFileReader,
  skipParts: ReadonlySet<SystemPromptOverridePart>,
): SystemPromptOverrideSourceSet {
  const out: MutableSystemPromptOverrideSourceSet = {}
  const problems: string[] = []
  for (const spec of SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS) {
    if (skipParts.has(spec.part)) continue
    const source: MutablePromptPartOverrideSource = {}
    const text = env[spec.envVar]
    if (text !== undefined) source.text = text
    const filePath = env[spec.fileEnvVar]
    if (filePath !== undefined)
      source.fileText = readOverrideFile(spec.fileEnvVar, filePath, readFile, problems)
    if (hasSource(source)) out[spec.part] = source
  }
  const unsafe = env.MINIMAL_AGENT_UNSAFE_SYSTEM_PROMPT_OVERRIDES
  if (unsafe !== undefined) out.unsafeProviderOverrides = unsafe === "1" || unsafe === "true"
  if (problems.length > 0) throw new SystemPromptOverrideError(problems)
  return out
}

function sourceSetFromConfig(
  config: UserConfig,
  readFile: SystemPromptOverrideFileReader,
  skipParts: ReadonlySet<SystemPromptOverridePart>,
): SystemPromptOverrideSourceSet {
  const out: MutableSystemPromptOverrideSourceSet = {}
  const problems: string[] = []
  const cfg = config.systemPrompt
  if (!cfg) return out
  for (const spec of SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS) {
    if (skipParts.has(spec.part)) continue
    const source: MutablePromptPartOverrideSource = {}
    const value = cfg[spec.configKey as keyof SystemPromptUserConfig]
    if (value === false || value === null) source.omit = true
    else if (typeof value === "string") source.text = value
    const filePath = cfg[spec.configFileKey as keyof SystemPromptUserConfig]
    if (typeof filePath === "string") {
      source.fileText = readOverrideFile(
        `systemPrompt.${spec.configFileKey}`,
        filePath,
        readFile,
        problems,
      )
    }
    if (hasSource(source)) out[spec.part] = source
  }
  if (cfg.unsafeProviderOverrides !== undefined) {
    out.unsafeProviderOverrides = cfg.unsafeProviderOverrides
  }
  if (problems.length > 0) throw new SystemPromptOverrideError(problems)
  return out
}

function readArgValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined
}

function readOverrideFile(
  label: string,
  path: string,
  readFile: SystemPromptOverrideFileReader,
  problems: string[],
): string | undefined {
  if (path.length === 0) {
    problems.push(`${label}: file path is empty`)
    return undefined
  }
  try {
    return readFile(path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    problems.push(`${label}: ${msg}`)
    return undefined
  }
}

function hasSource(source: PromptPartOverrideSource): boolean {
  return source.omit === true || source.text !== undefined || source.fileText !== undefined
}
