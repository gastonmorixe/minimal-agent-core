/**
 * CLI argument resolution for the agent entry point.
 *
 * Pure flag/env/config precedence logic lifted out of `src/index.ts` so the
 * entry point stays a thin composition root. This module does NO I/O and has
 * NO side effects: it reads a pre-normalized `args` array plus the loaded
 * user config and the process environment, and returns a fully-resolved
 * {@link CliOptions} struct. The side-effecting parts of startup (the
 * `--help` short-circuit, `setSessionId`, `setStartupTreeVisible`, env-var
 * propagation) stay in the entry point, keyed off these resolved values.
 *
 * The precedence ladder is uniform across options: CLI flag > env var >
 * config file > built-in default.
 *
 * @module cli/parse-argv
 */

import { type CacheTtl, type CacheTtlSource, resolveCacheTtl } from "../cache/cache-ttl.ts"
import type { UserConfig } from "../config/config.ts"
import { type EffortSource, resolveEffort } from "../config/effort-resolution.ts"
import { type CommandPlan, planCommand } from "../host/cli/command-plan.ts"
import { parseFormatterCommand } from "../host/ui/formatter/formatter.ts"

import { resolveShowHeader } from "./non-interactive-defaults.ts"

/** A minimal view of the process environment this resolver reads. */
export type EnvLike = Record<string, string | undefined>

/**
 * Every CLI/env/config-derived value the entry point needs, fully resolved.
 * Field names mirror the historical module-scope constants in `index.ts` so
 * the entry point can destructure this struct 1:1.
 */
export interface CliOptions {
  readonly model: string | undefined
  readonly provider: string | undefined
  readonly cliCredentialName: string | undefined
  readonly wantListModels: boolean
  readonly wantListProviders: boolean
  readonly listModelsProvider: string | undefined
  readonly wantListFlags: boolean
  readonly wantListPlugins: boolean
  readonly wantListSpinners: boolean
  readonly wantJsonOutput: boolean
  readonly outputSchemaPath: string | undefined
  readonly spinnerName: string | undefined
  readonly showHeader: boolean
  readonly effort: string | undefined
  readonly effortSource: EffortSource | undefined
  readonly thinkingDisplay: "summarized" | "omitted" | undefined
  readonly speed: "normal" | "fast"
  readonly speedFast: boolean
  readonly serviceTier: string | undefined
  readonly cacheTtl: CacheTtl
  readonly cacheTtlSource: CacheTtlSource
  readonly formatterExplicitArg: string[] | undefined
  readonly formatterExtraArgs: string[]
  readonly resumeArg: string | undefined
  readonly resumeSameArg: string | undefined
  readonly effectiveResumeArg: string | undefined
  readonly sessionIdArg: string | undefined
  readonly wantListSessions: boolean
  readonly sessionsQuery: string | undefined
  readonly wantUsage: boolean
  readonly usagePeriod: string | undefined
  readonly dumpArg: string | undefined
  readonly dumpFormatArg: string
  readonly wantLogin: boolean
  readonly wantLogout: boolean
  readonly wantAuthStatus: boolean
  readonly commandPlan: CommandPlan
}

/**
 * Read the value following a `--flag` token, or the inline `--flag=value`
 * form. Returns `undefined` when the flag is absent or has no value.
 */
function makeReadFlagValue(args: readonly string[]): (name: string) => string | undefined {
  return (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`${name}=`))
    if (eq) return eq.slice(name.length + 1)
    const idx = args.indexOf(name)
    if (idx !== -1 && args[idx + 1]) return args[idx + 1]
    return undefined
  }
}

/** The token after `flag`, unless it is missing or is itself the next flag. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("-") ? args[idx + 1] : undefined
}

/** The raw token after `flag` (a leading dash is allowed). */
function rawAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined
}

/**
 * Resolve every CLI option from the normalized args, loaded user config, and
 * environment. Pure: no I/O, no process mutation.
 *
 * @param args - Normalized argv (post `normalizeArgs`, sans `node`/script).
 * @param userConfig - The loaded `~/.minimal-agent/config.json` values.
 * @param env - The process environment (only read).
 * @returns The fully-resolved option struct.
 */
export function parseCliOptions(
  args: readonly string[],
  userConfig: UserConfig,
  env: EnvLike,
): CliOptions {
  const readFlagValue = makeReadFlagValue(args)

  const model = valueAfter(args, "--model") ?? rawAfter(args, "--model")
  const provider = valueAfter(args, "--provider")
  const cliCredentialName = valueAfter(args, "--credential-name")

  const wantListModels = args.includes("--list-models")
  const wantListProviders = args.includes("--list-providers")
  const listModelsProvider = valueAfter(args, "--list-models")
  const wantListFlags = args.includes("--list-flags")
  const wantListPlugins = args.includes("--list-plugins")
  const wantListSpinners = args.includes("--list-spinners")

  const wantJsonOutput = args.includes("--json")
  const outputSchemaPath = valueAfter(args, "--output-schema")

  const showHeader = resolveShowHeader({
    args: [...args],
    env: { HEADER: env.MINIMAL_AGENT_HEADER },
    config: { header: userConfig.header },
  })

  const spinnerName = rawAfter(args, "--spinner") ?? env.MINIMAL_AGENT_SPINNER ?? userConfig.spinner

  const { effort, source: effortSource } = resolveEffort({
    cli: rawAfter(args, "--effort"),
    env: env.MINIMAL_AGENT_EFFORT,
    config: userConfig.effort,
  })

  const thinkingDisplayRaw =
    readFlagValue("--thinking-display") ??
    env.MINIMAL_AGENT_THINKING_DISPLAY ??
    userConfig.thinkingDisplay
  const thinkingDisplay: "summarized" | "omitted" | undefined =
    thinkingDisplayRaw === "summarized" || thinkingDisplayRaw === "omitted"
      ? thinkingDisplayRaw
      : undefined

  const speedFast = args.includes("--fast") || env.MINIMAL_AGENT_FAST === "1"
  const speed: "normal" | "fast" = speedFast ? "fast" : "normal"

  const serviceTierIdx = args.indexOf("--service-tier")
  const serviceTier: string | undefined =
    serviceTierIdx !== -1 ? args[serviceTierIdx + 1] : env.MINIMAL_AGENT_SERVICE_TIER

  const { ttl: cacheTtl, source: cacheTtlSource } = resolveCacheTtl({
    cli: readFlagValue("--cache-ttl"),
    env: env.MINIMAL_AGENT_CACHE_TTL,
    config: userConfig.cacheTtl,
  })

  const formatterExplicitArg: string[] | undefined = (() => {
    const raw = rawAfter(args, "--formatter")
    return raw ? parseFormatterCommand(raw) : undefined
  })()

  const formatterArgsCli = readFlagValue("--formatter-args")
  const formatterExtraArgs: string[] = (() => {
    if (formatterArgsCli !== undefined) return parseFormatterCommand(formatterArgsCli)
    const envVal = env.MINIMAL_AGENT_FORMATTER_ARGS
    if (envVal && envVal.length > 0) return parseFormatterCommand(envVal)
    return userConfig.formatterArgs ?? []
  })()

  const resumeArg = rawAfter(args, "--resume")
  const resumeSameArg = rawAfter(args, "--resume-same-sid")
  const effectiveResumeArg = resumeSameArg ?? resumeArg

  const sessionIdArg = valueAfter(args, "--session-id")

  const wantListSessions = args.indexOf("--sessions") !== -1
  const sessionsQuery = valueAfter(args, "--sessions")

  const wantUsage = args.indexOf("--usage") !== -1
  const usagePeriod = valueAfter(args, "--usage")

  const dumpArg = rawAfter(args, "--dump")
  const dumpFormatArg = rawAfter(args, "--dump-format") ?? "md"

  const wantLogin = args.includes("--login")
  const wantLogout = args.includes("--logout")
  const wantAuthStatus = args.includes("--auth-status")

  const commandPlan = planCommand({
    dumpArg,
    wantListSessions,
    wantUsage,
    wantListFlags,
    wantListSpinners,
    wantListModels,
    wantListProviders,
    wantListPlugins,
    wantLogin,
    wantLogout,
    wantAuthStatus,
  })

  return {
    model,
    provider,
    cliCredentialName,
    wantListModels,
    wantListProviders,
    listModelsProvider,
    wantListFlags,
    wantListPlugins,
    wantListSpinners,
    wantJsonOutput,
    outputSchemaPath,
    spinnerName,
    showHeader,
    effort,
    effortSource,
    thinkingDisplay,
    speed,
    speedFast,
    serviceTier,
    cacheTtl,
    cacheTtlSource,
    formatterExplicitArg,
    formatterExtraArgs,
    resumeArg,
    resumeSameArg,
    effectiveResumeArg,
    sessionIdArg,
    wantListSessions,
    sessionsQuery,
    wantUsage,
    usagePeriod,
    dumpArg,
    dumpFormatArg,
    wantLogin,
    wantLogout,
    wantAuthStatus,
    commandPlan,
  }
}
