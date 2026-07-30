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
 * The precedence ladder is uniform across options: CLI flag then env var
 * then config file then built-in default.
 *
 * @module cli/parse-argv
 */

import { type CacheTtl, type CacheTtlSource, resolveCacheTtl } from "../cache/cache-ttl.ts"
import type { UserConfig } from "../config/config.ts"
import { type EffortSource, resolveEffort } from "../config/effort-resolution.ts"
import type { SystemPromptOverrides } from "../llm/system-prompt-overrides.ts"
import type { ToolNamePolicy } from "../sdk/tool-filter.ts"

import { resolveShowHeader } from "./non-interactive-defaults.ts"
import { type OutputFormat, resolveOutputFormat } from "./output-format.ts"
import { type PrintFormat, parsePrintFormat } from "./print-format.ts"

/** A minimal view of the process environment this resolver reads. */
export type EnvLike = Record<string, string | undefined>

/**
 * Parse a formatter command string into argv. Injected by the caller so this
 * pure `cli/` module never imports the host tree (keeps the core→host ratchet
 * green). The entry point passes the host's `parseFormatterCommand`.
 */
export type FormatterParser = (raw: string) => string[]

/**
 * CLI-level tool name policy (`--tools` / `--no-tools`).
 * Alias of the SDK {@link ToolNamePolicy} — single source of truth.
 */
export type CliToolFilter = ToolNamePolicy

/**
 * Every CLI/env/config-derived value the entry point needs, fully resolved.
 * Field names mirror the historical module-scope constants in `index.ts` so
 * the entry point can destructure this struct 1:1.
 */
export interface CliOptions {
  readonly model: string | undefined
  readonly cliToolFilter: CliToolFilter
  readonly provider: string | undefined
  readonly endpoint: string | undefined
  readonly format: string | undefined
  readonly authType: "api-key" | "bearer" | "none" | "custom-header" | undefined
  readonly apiKey: string | undefined
  readonly authHeader: string | undefined
  readonly providerModel: string | undefined
  readonly effortLevels: string[] | undefined
  readonly cliCredentialName: string | undefined
  readonly wantListModels: boolean
  /** Live catalogs: `--list-models-live` / `providers models-live`. */
  readonly wantListModelsLive: boolean
  readonly wantListProviders: boolean
  readonly listModelsProvider: string | undefined
  /** Inspection command print format (`--print-format`). */
  readonly printFormat: PrintFormat
  readonly wantListFlags: boolean
  readonly wantListPlugins: boolean
  readonly wantListSpinners: boolean
  readonly wantJsonOutput: boolean
  /**
   * The resolved non-interactive output format (`text` | `json` |
   * `stream-json`). Precedence: a valid `--output-format` value wins, then the
   * `--json` alias (mirrored by `wantJsonOutput`), then `text`. See
   * {@link resolveOutputFormat}.
   */
  readonly outputFormat: OutputFormat
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
  readonly systemPromptOverrides: SystemPromptOverrides
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
 * @param parseFormatter - Host-provided formatter-command parser (injected so
 *   this module stays host-free).
 * @returns The fully-resolved option struct.
 */
export function parseCliOptions(
  args: readonly string[],
  userConfig: UserConfig,
  env: EnvLike,
  parseFormatter: FormatterParser,
  systemPromptOverrides: SystemPromptOverrides = {},
): CliOptions {
  const readFlagValue = makeReadFlagValue(args)

  const model = valueAfter(args, "--model") ?? rawAfter(args, "--model")
  const provider = valueAfter(args, "--provider")
  const endpoint = readFlagValue("--endpoint") ?? env.MINIMAL_AGENT_ENDPOINT ?? userConfig.endpoint
  const format =
    readFlagValue("--format") ??
    readFlagValue("--surface") ??
    env.MINIMAL_AGENT_FORMAT ??
    env.MINIMAL_AGENT_SURFACE ??
    userConfig.format
  const authTypeRaw =
    readFlagValue("--auth-type") ?? env.MINIMAL_AGENT_AUTH_TYPE ?? userConfig.authType
  const authType =
    authTypeRaw === "api-key" ||
    authTypeRaw === "bearer" ||
    authTypeRaw === "none" ||
    authTypeRaw === "custom-header"
      ? authTypeRaw
      : undefined
  const apiKey = readFlagValue("--api-key") ?? env.MINIMAL_AGENT_API_KEY ?? userConfig.apiKey
  const authHeader =
    readFlagValue("--auth-header") ?? env.MINIMAL_AGENT_AUTH_HEADER ?? userConfig.authHeader
  const providerModel =
    readFlagValue("--provider-model") ??
    env.MINIMAL_AGENT_PROVIDER_MODEL ??
    userConfig.providerModel
  // Generic endpoint effort ladder. Comma-separated levels the ad-hoc model
  // advertises (e.g. "low,medium,high"), so `--effort <level>` is accepted for
  // a runtime-configured backend whose codec defaults declare none.
  const effortLevelsRaw =
    readFlagValue("--effort-levels") ?? env.MINIMAL_AGENT_EFFORT_LEVELS ?? undefined
  const effortLevels: string[] | undefined = effortLevelsRaw
    ? effortLevelsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : userConfig.effortLevels
  const cliCredentialName = valueAfter(args, "--credential-name")

  const wantListModels = args.includes("--list-models")
  const wantListModelsLive = args.includes("--list-models-live")
  const wantListProviders = args.includes("--list-providers")
  // Provider filter for whichever models command won (live preferred if both).
  const listModelsProvider =
    valueAfter(args, "--list-models-live") ?? valueAfter(args, "--list-models")
  const printFormat = parsePrintFormat(
    valueAfter(args, "--print-format") ?? env.MINIMAL_AGENT_PRINT_FORMAT,
  )
  const wantListFlags = args.includes("--list-flags")
  const wantListPlugins = args.includes("--list-plugins")
  const wantListSpinners = args.includes("--list-spinners")

  const wantJsonOutput = args.includes("--json")
  // The `--output-format <text|json|stream-json>` flag. `--json` is the legacy
  // alias; a valid `--output-format` value wins over it (see resolveOutputFormat).
  const outputFormat = resolveOutputFormat({
    outputFormatFlag: valueAfter(args, "--output-format"),
    jsonFlag: wantJsonOutput,
  })
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
    return raw ? parseFormatter(raw) : undefined
  })()

  const formatterArgsCli = readFlagValue("--formatter-args")
  const formatterExtraArgs: string[] = (() => {
    if (formatterArgsCli !== undefined) return parseFormatter(formatterArgsCli)
    const envVal = env.MINIMAL_AGENT_FORMATTER_ARGS
    if (envVal && envVal.length > 0) return parseFormatter(envVal)
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

  // --tools "Read,Task,Grep" → allow-list; --no-tools → deny-all
  const cliToolFilter: CliToolFilter = (() => {
    if (args.includes("--no-tools")) return { kind: "deny-all" }
    const toolsVal = readFlagValue("--tools")
    if (toolsVal) {
      const tools = toolsVal
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
      return tools.length > 0 ? { kind: "allow-list", tools } : null
    }
    return null
  })()

  return {
    model,
    provider,
    endpoint,
    format,
    authType,
    apiKey,
    authHeader,
    providerModel,
    effortLevels,
    cliCredentialName,
    wantListModels,
    wantListModelsLive,
    wantListProviders,
    listModelsProvider,
    printFormat,
    wantListFlags,
    wantListPlugins,
    wantListSpinners,
    wantJsonOutput,
    outputFormat,
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
    systemPromptOverrides,
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
    cliToolFilter,
  }
}
