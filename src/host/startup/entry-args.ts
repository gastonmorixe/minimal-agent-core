/**
 * Entrypoint argument preparation.
 *
 * This module owns the side-effecting CLI startup bits that sit above the
 * pure `src/cli/*` parsers: smart-dash rejection, help dispatch, env flag
 * propagation, config loading, command planning, startup-tree visibility, and
 * early session-id seeding. `src/index.ts` calls it once and stays as the
 * composition root for startup ordering.
 *
 * @module host/startup/entry-args
 */

import { findDashTypos, formatDashTypoError, normalizeArgs } from "../../cli/cli-args.ts"
import { extractPromptFromArgs } from "../../cli/extract-prompt.ts"
import { type CliOptions, parseCliOptions } from "../../cli/parse-argv.ts"
import { loadUserConfig, type UserConfig } from "../../config/config.ts"
import { setSessionId } from "../../session/session-id.ts"
import { type CommandPlan, planCommand } from "../cli/command-plan.ts"
import { resolveSessionTarget } from "../commands/session-index.ts"
import { parseFormatterCommand } from "../ui/formatter/formatter.ts"
import { setStartupTreeVisible } from "../ui/startup/tree.ts"

import { printHelp } from "./help.ts"

/** Process environment shape used by startup argument preparation. */
export type EntrypointEnv = Record<string, string | undefined>

/** Writable stream slice used for early CLI errors. */
export type EntrypointStderr = Pick<NodeJS.WriteStream, "write">

/** Input accepted by the stdin prompt reader. */
export type PromptInput = AsyncIterable<Buffer | Uint8Array | string>

/** Dependencies for {@link prepareEntrypointArgs}. */
export interface PrepareEntrypointArgsInput {
  /** Raw argv, without the executable and script slots. */
  readonly rawArgv: string[]
  /** Mutable process environment. Debug/verbose flags are propagated here. */
  readonly env: EntrypointEnv
  /** Current working directory, used for `--resume-same-sid last` resolution. */
  readonly cwd: string
  /** Error sink for early failures. Defaults to `process.stderr`. */
  readonly stderr?: EntrypointStderr
  /** Exit hook for tests. Defaults to `process.exit`. */
  readonly exit?: (code: number) => never
  /** Help renderer override for tests. Defaults to the real startup help. */
  readonly printHelp?: () => void
}

/** Prepared CLI state consumed by `src/index.ts`. */
export interface EntrypointArgs {
  /** Normalized long-form argv. */
  readonly args: string[]
  /** Loaded user config. */
  readonly userConfig: UserConfig
  /** Fully resolved CLI/env/config options. */
  readonly opts: CliOptions
  /** Planned top-level command and capability profile. */
  readonly commandPlan: CommandPlan
  /** Startup tree visibility, exposed as a named value for call-site clarity. */
  readonly showHeader: boolean
  /** Read an inline-or-spaced flag value from normalized args. */
  readonly readFlagValue: (name: string) => string | undefined
  /** Resolve the one-shot prompt, reading stdin only for the `-` sentinel. */
  readonly extractPrompt: (stdin?: PromptInput) => Promise<string | null>
}

/**
 * Normalize argv and apply the entrypoint's early side effects.
 *
 * This intentionally does not discover providers, load plugins, or resolve
 * auth. It only prepares the values needed for the rest of startup.
 */
export function prepareEntrypointArgs(input: PrepareEntrypointArgsInput): EntrypointArgs {
  const stderr = input.stderr ?? process.stderr
  const exit = input.exit ?? ((code: number): never => process.exit(code))
  const renderHelp = input.printHelp ?? printHelp

  const dashTypos = findDashTypos(input.rawArgv)
  if (dashTypos.length > 0) {
    stderr.write(`${formatDashTypoError(dashTypos)}\n`)
    exit(2)
  }

  const args = normalizeArgs(input.rawArgv)

  if (args.includes("--help") || args.includes("-h")) {
    renderHelp()
    exit(0)
  }

  if (args.includes("--debug")) {
    input.env.DEBUG = "1"
  }
  if (args.includes("--verbose")) {
    input.env.VERBOSE = "1"
  }
  if (args.includes("--show-hidden-chars")) {
    input.env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS = "1"
  }

  const userConfig = loadUserConfig()
  const opts = parseCliOptions(args, userConfig, input.env, parseFormatterCommand)
  const commandPlan = planCommand({
    dumpArg: opts.dumpArg,
    wantListSessions: opts.wantListSessions,
    wantUsage: opts.wantUsage,
    wantListFlags: opts.wantListFlags,
    wantListSpinners: opts.wantListSpinners,
    wantListModels: opts.wantListModels,
    wantListProviders: opts.wantListProviders,
    wantListPlugins: opts.wantListPlugins,
    wantLogin: opts.wantLogin,
    wantLogout: opts.wantLogout,
    wantAuthStatus: opts.wantAuthStatus,
  })

  setStartupTreeVisible(opts.showHeader)

  if (opts.sessionIdArg !== undefined) {
    try {
      setSessionId(opts.sessionIdArg)
    } catch (e) {
      stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      exit(2)
    }
  }

  if (opts.resumeSameArg !== undefined) {
    try {
      const resolved = resolveSessionTarget(opts.resumeSameArg, input.cwd)
      if (!resolved) {
        stderr.write(`error: no saved sessions found for --resume-same-sid ${opts.resumeSameArg}\n`)
        exit(1)
      } else {
        setSessionId(resolved)
      }
    } catch (e) {
      stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
      exit(2)
    }
  }

  const readFlagValue = makeReadFlagValue(args)

  return {
    args,
    userConfig,
    opts,
    commandPlan,
    showHeader: opts.showHeader,
    readFlagValue,
    extractPrompt: (stdin = process.stdin) => extractPrompt(args, stdin),
  }
}

function makeReadFlagValue(args: readonly string[]): (name: string) => string | undefined {
  return (name: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`${name}=`))
    if (eq) return eq.slice(name.length + 1)
    const idx = args.indexOf(name)
    if (idx !== -1 && args[idx + 1]) return args[idx + 1]
    return undefined
  }
}

async function extractPrompt(args: readonly string[], stdin: PromptInput): Promise<string | null> {
  const src = extractPromptFromArgs(args)
  if (src.kind === "literal") return src.text
  if (src.kind === "stdin") {
    const chunks: Buffer[] = []
    for await (const chunk of stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString("utf-8").trim()
  }
  return null
}
