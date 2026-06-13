#!/usr/bin/env bun

/**
 * Minimal Claude agent — entry point.
 *
 * A research tool for understanding the minimal API surface needed to make
 * authenticated, agentic requests to the Anthropic Messages API using the
 * Claude Code CLI's stored OAuth credentials.
 *
 * This script reuses the real CLI's credentials (read from macOS Keychain)
 * and replicates its exact request format (headers, metadata, system prompt,
 * beta flags, tool schemas) so the server treats it identically to the real
 * CLI. Verified against live captures via `.node-net-dbg/`.
 *
 * **Modules:**
 * - {@link auth} — Keychain reading + OAuth refresh
 * - {@link headers} — User-Agent, beta flags, system prompt
 * - {@link metadata} — `metadata.user_id` JSON construction
 * - {@link client} — HTTP layer + SSE streaming + request body
 * - {@link tools} — Tool definitions + local execution
 * - {@link agent} — Conversation state + agentic tool loop + REPL
 * - {@link formatter} — Pipe streamed output through external processes
 *
 * **Usage:**
 * ```
 * bun run src/index.ts                          # interactive REPL
 * bun run src/index.ts --model claude-opus-4-7  # specific model
 * bun run src/index.ts --debug                  # log full request/response
 * bun run src/index.ts --list-models            # show available models
 * bun run src/index.ts --list-flags             # show beta flags
 * bun run src/index.ts "hello"                  # one-shot prompt
 * bun run src/index.ts --prompt "hello"         # same, explicit flag
 * echo "hello" | bun run src/index.ts -         # read prompt from stdin
 * bun run src/index.ts --formatter mdstream     # pipe through mdstream (default)
 * bun run src/index.ts --skip-quota             # skip startup quota check
 * DEBUG=1 bun run src/index.ts                  # alternative debug activation
 * ```
 *
 * Or use the shortcut: `./minimal-agent.sh [options]`
 *
 * @module index
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  combineTurnDrains,
  instantiateTurnAttachments,
  parseReplaySidecarTasks,
} from "./agent/turn-attachments.ts"
import { Agent, c, runRepl } from "./agent.ts"
import { publishAgentHomeEnv, resolveSessionsDir } from "./agent-paths.ts"
import { getAuth } from "./auth.ts"
import { resolveFormatter } from "./auto-formatter.ts"
import { bootstrapUserPlugins } from "./auto-plugins.ts"
import { defaultBinDir } from "./binaries/store.ts"
import { loadBlobStoreConfig } from "./blob-store.ts"
import { planCommand } from "./cli/command-plan.ts"
import { normalizeArgs } from "./cli-args.ts"
import { checkQuota } from "./client.ts"
import { runAuthStatusCommand } from "./commands/auth-status.ts"
import { DumpCommandError, runDumpCommand } from "./commands/dump.ts"
import { runListFlagsCommand } from "./commands/list-flags.ts"
import { runListModelsCommand } from "./commands/list-models.ts"
import { runListProvidersCommand } from "./commands/list-providers.ts"
import { runListSpinnersCommand } from "./commands/list-spinners.ts"
import { runLoginCommand } from "./commands/login.ts"
import { runLogoutCommand } from "./commands/logout.ts"
import { resolveSessionTarget } from "./commands/session-index.ts"
import { runSessionsCommand } from "./commands/sessions.ts"
import { runUsageCommand } from "./commands/usage.ts"
import { loadModeUserOverrides, loadPluginEnabledOverrides, loadUserConfig } from "./config.ts"
import { diag, getDiagnosticBus } from "./diagnostic-bus.ts"
import { resolveEffort } from "./effort-resolution.ts"
import { extractPromptFromArgs } from "./extract-prompt.ts"
import { isColdStart, maybeShowFirstRunWelcome } from "./first-run.ts"
import { Formatter, parseFormatterCommand } from "./formatter.ts"
import { setGlobalEventBus } from "./global-bus.ts"
import { DEFAULT_MODEL } from "./headers.ts"
import { activateProviderPlugins, registerDiscoveredProviders, resolveModel } from "./llm/index.ts"
import { buildModelInfoSnapshot, buildSubagentModelRecommendations } from "./llm/model-info.ts"
import { resolveProviderSessionInfo } from "./llm/provider-session.ts"
import { lastAdvertisedModeFromHistory, ModeManager } from "./modes.ts"
import { defaultNetworkClient } from "./network/index.ts"
import { resolveInitialModeId, resolveShowHeader } from "./non-interactive-defaults.ts"
import { createAgentContext } from "./plugins/agent-context.ts"
import { PluginLoader } from "./plugins/loader.ts"
import { PluginStream } from "./plugins/stream.ts"
import { formatQuotaWindows } from "./quota-summary.ts"
import { buildReadyBanner } from "./ready-banner.ts"
import { getSessionId, setSessionId } from "./session-id.ts"
import {
  buildResumeHeader,
  replayToScrollback,
  toolDisplaysFromRecords,
  userTimestampsFromRecords,
} from "./session-replay.ts"
import { loadSession } from "./session-restore.ts"
import { shortHash } from "./session-store.ts"
import { getSpinnerPreset, type NamedSpinnerPreset } from "./spinner/named-presets.ts"
import type { Spinner } from "./spinner.ts"
import { getAuthWithFirstTimePrompt } from "./startup/auth-prompt.ts"
import { printHelp, readEmbeddedPackageVersion } from "./startup/help.ts"
import {
  modelHidesReasoning,
  providerWantsQuotaProbe,
  signInStepLabel,
} from "./startup/provider-presentation.ts"
import { bootSessionStores } from "./startup/session-store-boot.ts"
import {
  closeStartupTree,
  printStartupHeader,
  printStartupRow,
  printStartupToolsRow,
  setStartupTreeVisible,
  startStartupRowSpinner,
} from "./startup/startup-tree.ts"
import type { StatusSpinnerTheme } from "./status.ts"
import { ToolTimeTracker } from "./tool-time.ts"
import { TOOL_DEFINITIONS } from "./tools.ts"

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = normalizeArgs(process.argv.slice(2))

// Provider plugins (plugins/llm-*) are discovered + registered at the top
// of main() via the provider loader, before any model resolution. The
// entrypoint imports no provider by name.

if (args.includes("--help") || args.includes("-h")) {
  printHelp()
  process.exit(0)
}

if (args.includes("--debug")) {
  process.env.DEBUG = "1"
}

if (args.includes("--verbose")) {
  process.env.VERBOSE = "1"
}

// Propagate --show-hidden-chars to subsystems (e.g. the debug printer in
// client.ts) via env var, mirroring how --debug/--verbose work. The editor
// also reads this flag directly from `args` further down.
if (args.includes("--show-hidden-chars")) {
  process.env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS = "1"
}

const modelIdx = args.indexOf("--model")
const model = modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : undefined // config.model applied later (after loadUserConfig is called)

const wantListModels = args.includes("--list-models")
const wantListProviders = args.includes("--list-providers")
// `providers models <providerId>` carries the filter as the value after
// --list-models (e.g. `providers models openai` → ["--list-models", "openai"]).
const listModelsIdx = args.indexOf("--list-models")
const listModelsProvider =
  listModelsIdx >= 0 && args[listModelsIdx + 1] && !args[listModelsIdx + 1].startsWith("-")
    ? args[listModelsIdx + 1]
    : undefined
const wantListFlags = args.includes("--list-flags")
const wantListSpinners = args.includes("--list-spinners")

const spinnerIdx = args.indexOf("--spinner")
// Global user config (~/.minimal-agent/config.json). Lowest precedence:
// CLI flag > env var > config file > built-in default.
const userConfig = loadUserConfig()

// Whether to print the startup tree (banner + rows + closer). The
// default is hidden in non-interactive mode (`--prompt`, `-`, or a
// bare-positional prompt). See `resolveShowHeader` for the precedence
// ladder. Hoisted to module scope so the row/spinner/closer helpers
// can short-circuit cleanly without threading the flag everywhere.
const SHOW_HEADER = resolveShowHeader({
  args,
  env: { HEADER: process.env.MINIMAL_AGENT_HEADER },
  config: { header: userConfig.header },
})
// The startup-tree renderer (src/startup/startup-tree.ts) holds the
// row-printing state; arm its visibility gate once, here, so every
// printer below (and in main()) respects the resolved preference.
setStartupTreeVisible(SHOW_HEADER)

const spinnerName =
  spinnerIdx !== -1 && args[spinnerIdx + 1]
    ? args[spinnerIdx + 1]
    : (process.env.MINIMAL_AGENT_SPINNER ?? userConfig.spinner)

// Effort: --effort / -e  >  MINIMAL_AGENT_EFFORT  >  config file.
// Pass-through: the value is forwarded to output_config.effort verbatim;
// the server is the source of truth on accepted levels.
const effortIdx = args.indexOf("--effort")
const { effort, source: effortSource } = resolveEffort({
  cli: effortIdx !== -1 ? args[effortIdx + 1] : undefined,
  env: process.env.MINIMAL_AGENT_EFFORT,
  config: userConfig.effort,
})

// formatterCmd is resolved asynchronously inside main() via resolveFormatter()
// so that it can auto-download mdstream when it is not already on PATH.
// --thinking-display <summarized|omitted>  (env: MINIMAL_AGENT_THINKING_DISPLAY)
// Opt-in override for `thinking.display`. Unset → server default per model
// (omitted on opus-4.7 / mythos, summarized on sonnet-4.6 / opus-4.6).
// Set to "summarized" to force plaintext thinking_delta streaming on opus-4.7.
// Accept both `--thinking-display summarized` and `--thinking-display=summarized`.
function readFlagValue(name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1)
  const idx = args.indexOf(name)
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return undefined
}

const thinkingDisplayRaw =
  readFlagValue("--thinking-display") ??
  process.env.MINIMAL_AGENT_THINKING_DISPLAY ??
  userConfig.thinkingDisplay
const thinkingDisplay: "summarized" | "omitted" | undefined =
  thinkingDisplayRaw === "summarized" || thinkingDisplayRaw === "omitted"
    ? thinkingDisplayRaw
    : undefined

// --fast / -F  →  speed: "fast" on the request body. Opt-in only; default
// omits the field so the server treats it as normal. Capability-gated at
// the registry (sonnet-4-6 / haiku-4-5 don't support fast mode; the flag
// is forwarded silently and the Anthropic adapter's request-body builder
// no-ops it when the resolved model declares `speedFast: false`).
// Env mirror: MINIMAL_AGENT_FAST=1
const speedFast = args.includes("--fast") || process.env.MINIMAL_AGENT_FAST === "1"
const speed: "normal" | "fast" = speedFast ? "fast" : "normal"

const formatterExplicitIdx = args.indexOf("--formatter")
const formatterExplicitArg: string[] | undefined =
  formatterExplicitIdx !== -1 && args[formatterExplicitIdx + 1]
    ? parseFormatterCommand(args[formatterExplicitIdx + 1])
    : undefined

// Extra args appended to the resolved formatter command. Precedence:
//   --formatter-args  >  MINIMAL_AGENT_FORMATTER_ARGS  >  config.formatterArgs
// CLI / env are shell-parsed (so `--formatter-args "--table-fit --foo"`
// works); config can be a string[] or a shell-style string.
const formatterArgsCli = readFlagValue("--formatter-args")
const formatterExtraArgs: string[] = (() => {
  if (formatterArgsCli !== undefined) return parseFormatterCommand(formatterArgsCli)
  const envVal = process.env.MINIMAL_AGENT_FORMATTER_ARGS
  if (envVal && envVal.length > 0) return parseFormatterCommand(envVal)
  return userConfig.formatterArgs ?? []
})()

// --resume <sid>  resume a saved session (or "last" for the most recent
// session in this cwd, falling back to the global most-recent).
// --sessions [<query>]  list saved sessions (optionally fuzzy-filter on
//                       date/sid/cwd) and exit.
const resumeIdx = args.indexOf("--resume")
const resumeArg = resumeIdx !== -1 && args[resumeIdx + 1] ? args[resumeIdx + 1] : undefined

// --session-id <uuid>  pin this run's session id instead of minting a random
// one. Used by a supervising agent that spawns a headless child and needs to
// know the child's sid up front (to locate its session files / lineage).
// Seed it BEFORE any getSessionId() call below. Invalid ids exit non-zero.
const sessionIdIdx = args.indexOf("--session-id")
const sessionIdArg =
  sessionIdIdx !== -1 && args[sessionIdIdx + 1] && !args[sessionIdIdx + 1].startsWith("-")
    ? args[sessionIdIdx + 1]
    : undefined
if (sessionIdArg !== undefined) {
  try {
    setSessionId(sessionIdArg)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(2)
  }
}
const sessionsIdx = args.indexOf("--sessions")
const wantListSessions = sessionsIdx !== -1
// The token after `--sessions` is an optional fuzzy query. A leading
// dash means it's the next flag, not our value.
const sessionsQuery =
  sessionsIdx !== -1 && args[sessionsIdx + 1] && !args[sessionsIdx + 1].startsWith("-")
    ? args[sessionsIdx + 1]
    : undefined

// --usage [<period>]  token-usage stats across all saved sessions. The token
// after --usage is an optional period (today/last-day/last-month/ytd/year/all);
// a leading dash means it's the next flag, not our value.
const usageIdx = args.indexOf("--usage")
const wantUsage = usageIdx !== -1
const usagePeriod =
  usageIdx !== -1 && args[usageIdx + 1] && !args[usageIdx + 1].startsWith("-")
    ? args[usageIdx + 1]
    : undefined

const dumpIdx = args.indexOf("--dump")
const dumpArg = dumpIdx !== -1 && args[dumpIdx + 1] ? args[dumpIdx + 1] : undefined
const dumpFormatIdx = args.indexOf("--dump-format")
const dumpFormatArg =
  dumpFormatIdx !== -1 && args[dumpFormatIdx + 1] ? args[dumpFormatIdx + 1] : "md"

// Auth top-level commands. None of these consume credentials at startup —
// `--login` would be impossible if it did (cold-start case) — so they
// branch ahead of `getAuth()` in the `main()` switch. See
// src/cli/command-plan.ts for the full capability matrix.
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
  wantLogin,
  wantLogout,
  wantAuthStatus,
})

/**
 * Extract a non-interactive prompt from command-line args.
 *
 * Wraps the pure {@link extractPromptFromArgs} (in `./extract-prompt.ts`)
 * by handling the stdin-slurp case here. Lifting the classification out
 * keeps it unit-testable — see `src/extract-prompt.test.ts`.
 *
 * @returns The prompt text, or `null` for interactive REPL mode.
 */
async function extractPrompt(): Promise<string | null> {
  const src = extractPromptFromArgs(args)
  if (src.kind === "literal") return src.text
  if (src.kind === "stdin") {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString("utf-8").trim()
  }
  return null
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point. Orchestrates the full startup flow:
 *
 * 1. Print session info to stderr
 * 2. Read OAuth credentials from macOS Keychain
 * 3. Handle one-shot subcommands (--list-flags, --list-models)
 * 4. Run the quota check (unless --skip-quota)
 * 5. Set up the agent with the selected model
 * 6. Either:
 *    - Non-interactive mode: send a single prompt and exit
 *    - Interactive REPL mode: read lines from stdin until EOF
 *
 * If `--formatter` is provided, the streamed output is piped through
 * the external process for realtime formatting.
 */
async function main() {
  // Publish the resolved agent home into the environment BEFORE anything else,
  // so every plugin (and subprocess) inherits an authoritative, relocation-
  // correct base path (`MINIMAL_AGENT_HOME`) instead of hardcoding
  // `~/.minimal-agent`. This is the host→plugin "where is my storage" signal
  // (see `src/agent-paths.ts`). Idempotent and override-preserving.
  publishAgentHomeEnv()

  // Register provider plugins by discovery (plugins/llm-*) BEFORE any model
  // resolution (the bootstrap probe + footer + canonical run() all read the
  // registry). Replaces the old static builtin barrel: the entrypoint imports
  // no provider by name. Idempotent; a missing plugins dir yields no providers
  // rather than throwing.
  const srcDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))
  await registerDiscoveredProviders(join(dirname(srcDir), "plugins"))
  activateProviderPlugins()

  switch (commandPlan.command) {
    case "dump": {
      if (!dumpArg) {
        console.error(`  ${c.boldRed("error")} --dump requires <sid|last>`)
        process.exit(1)
      }
      try {
        await runDumpCommand({
          target: dumpArg,
          format: dumpFormatArg,
          cwd: process.cwd(),
        })
      } catch (err) {
        if (err instanceof DumpCommandError) {
          console.error(`  ${c.boldRed("error")} ${err.message}`)
          process.exit(1)
        }
        console.error(
          `  ${c.boldRed("error")} could not dump session ${dumpArg}: ${err instanceof Error ? err.message : String(err)}`,
        )
        process.exit(1)
      }
      return
    }
    case "sessions":
      runSessionsCommand({ query: sessionsQuery })
      return
    case "usage":
      await runUsageCommand({ period: usagePeriod })
      return
    case "list-flags":
      runListFlagsCommand()
      return
    case "list-spinners":
      runListSpinnersCommand()
      return
    case "list-models": {
      const auth = await getAuth()
      await runListModelsCommand(auth, listModelsProvider)
      return
    }
    case "list-providers": {
      runListProvidersCommand()
      return
    }
    case "login": {
      // OAuth login flow. Never reads existing credentials — the whole
      // point of the command is to acquire (or replace) them. Email
      // pre-fill: `--login --email foo@bar.com` (or `--email-hint` if you
      // squint at the upstream CLI). We accept either form.
      const emailIdx =
        args.indexOf("--email") !== -1 ? args.indexOf("--email") : args.indexOf("--email-hint")
      const loginHint =
        emailIdx !== -1 && args[emailIdx + 1] && !args[emailIdx + 1].startsWith("-")
          ? args[emailIdx + 1]
          : undefined
      const code = await runLoginCommand({ loginHint })
      process.exit(code)
    }
    case "logout": {
      const code = await runLogoutCommand()
      process.exit(code)
    }
    case "auth-status": {
      const code = await runAuthStatusCommand()
      process.exit(code)
    }
    case "run":
      break
  }

  // Cold-start detection must happen BEFORE any subsystem creates
  // `~/.minimal-agent` (the file-log sink below does, on its first write).
  // Capture it here so the welcome card and the post-setup hint can both key
  // off a single honest "is this the very first run on this machine" signal.
  const coldStart = isColdStart()

  // First-run welcome card. Interactive cold starts only — a scripted
  // `--prompt` run stays silent. Frames the one-time auto-setup (sign-in,
  // mdstream, plugins) so the spinners that follow read as expected setup.
  // The steps listed mirror exactly what the boot flow does next.
  const firstRunInteractive = process.stdin.isTTY === true && process.stdout.isTTY === true
  if (coldStart && firstRunInteractive && SHOW_HEADER) {
    maybeShowFirstRunWelcome({
      isInteractive: true,
      steps: [
        // Provider-supplied label: names the default provider's displayName,
        // or a neutral "sign in to your account" when none is registered.
        { label: signInStepLabel() },
        { label: `fetch ${c.bold("mdstream")}, the Markdown renderer` },
        { label: `fetch the extended plugins ${c.dim("(Fetch, Skill, slash-menu, …)")}` },
      ],
    })
  }

  printStartupHeader()
  printStartupRow("session", c.dim(getSessionId()))

  // Diagnostic bus: attach the file sink as early as possible so even
  // plugin-load warnings land in `~/.minimal-agent/logs/ma-session-<sid>.log`.
  // The TUI surface attaches later from `runReplLiveArea` (it needs the
  // editor / aggregator). The stderr mirror is opt-in.
  //
  // The scrollback sink is constructed here and kept on a process-scoped
  // variable so we can `startBuffering()` it BEFORE any startup-banner
  // row is drawn and `flushBuffer()` AFTER `closeStartupTree()` commits
  // the final `╰`. Without this two-phase wiring, a plugin-loader (or
  // auth / config) warning emitted mid-banner would tear through the
  // box mid-paint instead of landing cleanly below it with the proper
  // `⚠ warn ╰` chrome.
  let scrollbackSink: import("./log-scrollback.ts").ScrollbackDiagnosticSink | null = null
  {
    const { FileLogSink } = await import("./log-file.ts")
    new FileLogSink(getSessionId()).attach(getDiagnosticBus())
    // Persistent, cross-session audit log (`~/.minimal-agent/ma.log`). Unlike
    // the per-session file sink above, this single durable log survives across
    // runs and records long-lived subsystem history — binary installs /
    // updates / removals first (see src/binaries/*), more later. Notice+ only,
    // session id stamped into every line so a global entry traces back to its
    // run. Best-effort; never throws into boot.
    const { GlobalLogSink } = await import("./log-global.ts")
    new GlobalLogSink({ sessionId: getSessionId() }).attach(getDiagnosticBus())
    // Scrollback sink — renders Warning+ events as gutter-bracketed
    // blocks (gold ⚠ warn / red ✗ error) in the persistent terminal
    // transcript. Complements the file sink (full history, off-screen)
    // and the TuiDiagnosticSurface footer slot (last 0..2 events,
    // transient). Without it, mid-stream API errors (e.g. Anthropic's
    // `event: error` overload, returned over HTTP 200) land ONLY in
    // the file log — the user sees the status bar flash then silence,
    // with no in-context signal that anything went wrong. Attached
    // here, before any other subsystem can emit, so the first error
    // of the session is captured.
    const { ScrollbackDiagnosticSink } = await import("./log-scrollback.ts")
    scrollbackSink = new ScrollbackDiagnosticSink()
    scrollbackSink.attach(getDiagnosticBus())
    // Start buffering immediately. We're about to start drawing the
    // startup banner; any diagnostic that fires during that window
    // (plugin-loader warnings, auth refresh hints, formatter
    // resolution gripes) gets queued and flushed below the banner
    // once `closeStartupTree()` has committed the final `╰` row.
    if (SHOW_HEADER) scrollbackSink.startBuffering()
    if (process.env.MINIMAL_AGENT_LOG_STDERR === "1") {
      // No interceptor yet — write straight to fd 2. Once the
      // interceptor is installed below, we'd want `rawStderrWrite` to
      // avoid the compositor; we re-attach it from the live-area
      // bootstrap after `interceptor` exists.
      const { StderrMirrorSink } = await import("./log-stderr.ts")
      new StderrMirrorSink().attach(getDiagnosticBus())
    }
  }

  const auth = await getAuthWithFirstTimePrompt()
  printStartupRow(
    "auth",
    `${auth.type}${auth.accountUuid ? ` ${c.dim(`(account: ${auth.accountUuid.slice(0, 8)}...)`)}` : ""}`,
  )

  // Resolve the SELECTED model's provider once, up front. Everything that
  // is provider-specific (startup probe, quota) keys off this so a session
  // started with e.g. `--model gpt-5.5` never contacts Anthropic.
  const selectedModel = model ?? userConfig.model ?? DEFAULT_MODEL
  const selectedModelBase = selectedModel.replace(/\[(1|2)m\]/gi, "")
  let selectedProviderId: string | undefined
  try {
    selectedProviderId = resolveModel(selectedModelBase).providerId
  } catch {
    selectedProviderId = undefined
  }

  // Provider startup probe (fire-and-forget) for the SELECTED provider only.
  // A plugin MAY overlay server-shipped data onto the canonical registry —
  // e.g. Anthropic's /api/claude_cli/bootstrap model-cost overrides. We run
  // ONLY the selected model's provider so a gpt-5.5 session does not hit
  // api.anthropic.com just because the host holds an Anthropic OAuth session.
  // The plugin still self-gates + swallows failures (local pricing stays
  // authoritative).
  if (selectedProviderId) {
    const { listProviderPlugins } = await import("./llm/provider-plugin.ts")
    const { legacyAuthToProviderAuth } = await import("./llm/adapter-legacy.ts")
    const probeCtx = { auth: legacyAuthToProviderAuth(auth), modelId: selectedModelBase }
    for (const plugin of listProviderPlugins()) {
      if (plugin.id !== selectedProviderId) continue
      plugin.onStartupProbe?.(probeCtx)
    }
  }

  // Warm the SELECTED provider's session-metadata cache so the status-bar
  // slot's first tick finds fresh data without ever issuing a network call
  // of its own. Fire-and-forget — by the time the prime probe lands, the
  // provider broadcasts `quota.headersReceived`, which refires the slot
  // and the footer populates with no blocking on the REPL boot path. A
  // provider with no `primeSessionInfo` (OpenAI / OpenRouter, whose cache
  // fills from real chat traffic) silently no-ops here.
  if (selectedProviderId) {
    void (async () => {
      const { primeProviderSessionInfo } = await import("./llm/provider-session.ts")
      await primeProviderSessionInfo(selectedModelBase)
    })().catch(() => {
      // Tolerated: prime is a UX warm-up. The slot stays on its placeholder
      // until real chat traffic broadcasts the headers — same fallback as
      // before the prime hook existed.
    })
  }

  // Resolve formatter: explicit --formatter, PATH, cached binary, or auto-download.
  let formatterCmd: string[] | undefined
  if (commandPlan.needsFormatter) {
    const formatterResolution = await resolveFormatter(formatterExplicitArg)
    if (formatterResolution.cmd) {
      formatterCmd = formatterResolution.cmd
      // Append user-supplied extra args (--formatter-args / env / config).
      // Applied here (after resolution) so they ride along regardless of
      // whether the formatter came from PATH, the cache, an auto-download,
      // or an explicit --formatter override.
      if (formatterExtraArgs.length > 0) {
        formatterCmd = [...formatterCmd, ...formatterExtraArgs]
      }
      const extraLabel =
        formatterExtraArgs.length > 0 ? ` ${c.dim(formatterExtraArgs.join(" "))}` : ""
      printStartupRow("formatter", `${c.dim(formatterResolution.label)}${extraLabel}`)
    } else {
      formatterCmd = undefined
      console.error(`  ${c.boldYellow("warn")} ${formatterResolution.warn}`)
    }
  } else {
    formatterCmd = undefined
  }

  printStartupRow("model", c.boldCyan(selectedModel))

  // Thinking + effort: surface what we'll actually send on the wire. A
  // cheap/fast-tier model that supports neither thinking nor an effort
  // parameter gets neither field, so we show "off" for both. This is a
  // capability-driven test (registry flags), not a model-name substring
  // match, so any provider's cheap tier reads correctly. See
  // `modelHidesReasoning` in src/startup/provider-presentation.ts.
  const hidesReasoning = modelHidesReasoning(selectedModel)
  const thinkingLabel = hidesReasoning
    ? c.dim("off")
    : thinkingDisplay
      ? `adaptive ${c.dim(`(display=${thinkingDisplay})`)}`
      : "adaptive"
  const effortProvenance =
    effortSource === "cli"
      ? "(--effort)"
      : effortSource === "env"
        ? "(env)"
        : effortSource === "config"
          ? "(config)"
          : ""
  const effortLabel = hidesReasoning
    ? c.dim("off")
    : effort
      ? `${effort} ${c.dim(effortProvenance)}`
      : `medium ${c.dim("(default)")}`
  printStartupRow("thinking", thinkingLabel)
  printStartupRow("effort", effortLabel)

  // Terminal viewport the compositor / mdstream will use for partial-redraw
  // and wrap math. Mirror `Compositor.effectiveColumns()` (src/ui/compositor.ts):
  // fall back to `$COLUMNS` / `$LINES` when stdout reports 0 or undefined
  // (most commonly: macOS BSD `script(1)` allocating a slave PTY without
  // propagating WINSZ). Surfacing this at boot makes width/height surprises
  // visible before they cause duplicated-paragraph or stuck-prompt artifacts.
  const envCols = Number.parseInt(process.env.COLUMNS ?? "", 10)
  const envRows = Number.parseInt(process.env.LINES ?? "", 10)
  const effCols =
    typeof process.stdout.columns === "number" && process.stdout.columns > 0
      ? process.stdout.columns
      : Number.isFinite(envCols) && envCols > 0
        ? envCols
        : 0
  const effRows =
    typeof process.stdout.rows === "number" && process.stdout.rows > 0
      ? process.stdout.rows
      : Number.isFinite(envRows) && envRows > 0
        ? envRows
        : 0
  const termLabel =
    effCols > 0 && effRows > 0
      ? `${effCols} × ${effRows} ${c.dim("(cols × rows)")}`
      : c.dim("unknown")
  printStartupRow("term", termLabel)

  // Load Plugins from ~/.agents/plugins and <cwd>/plugins.
  // Core tool names must always win over plugin names.
  const coreToolNames = new Set(TOOL_DEFINITIONS.map((t) => t.name))
  const homeDir = process.env.HOME ? join(process.env.HOME, ".agents") : undefined
  // minimal-agent's own per-user plugins root. The first-run bootstrap
  // clones `minimal-agent-plugins` here, so this is where the extended
  // first-party plugins (Fetch, Skill, slash-menu, …) live on an installed
  // box. Sits above embedded built-ins but below the user's hand-curated
  // ~/.agents/plugins and <cwd>/.agents/plugins roots. See `userDir` in
  // PluginLoaderOptions for the precedence rationale.
  const userDir = process.env.HOME ? join(process.env.HOME, ".minimal-agent") : undefined

  // First-run plugin bootstrap. On a freshly-installed box the extended
  // first-party plugins (Fetch, Skill, slash-menu, …) aren't present; clone
  // them ONCE into `<userDir>/plugins` so the loader (which scans that as the
  // `user` root) picks them up on THIS boot. Best-effort and fully gated:
  //   - skipped entirely in non-interactive runs (--prompt / `-` / piped):
  //     a one-shot scripted call shouldn't reach out to the network or grow
  //     the toolset under the user's feet.
  //   - opt-out via MINIMAL_AGENT_NO_PLUGIN_SYNC=1 or config `pluginSync:false`.
  //   - never throws; a private-repo / offline / no-git box degrades to the
  //     embedded plugins with a quiet startup row.
  if (userDir && SHOW_HEADER) {
    const pluginSyncEnabled =
      process.env.MINIMAL_AGENT_NO_PLUGIN_SYNC === "1" ? false : (userConfig.pluginSync ?? true)
    const pluginsRepo =
      process.env.MINIMAL_AGENT_PLUGINS_REPO?.trim() || userConfig.pluginsRepo || undefined
    const sync = await bootstrapUserPlugins({
      targetDir: join(userDir, "plugins"),
      enabled: pluginSyncEnabled,
      repoUrl: pluginsRepo,
      showSpinner: true,
    })
    // Only surface a startup row when something meaningful happened: a fresh
    // clone, or a failed/skipped attempt the operator may want to know about.
    // The common steady-state (`present`) and the opt-out (`disabled`) stay
    // silent so the tree doesn't gain a permanent noise row.
    if (sync.status === "cloned") {
      printStartupRow("plugins", `${c.dim("+")} ${c.dim(sync.label)}`)
    } else if (sync.status === "failed" || sync.status === "skipped") {
      // Quiet, non-fatal. Detail lands in the file log via the diagnostic bus
      // (the loader still runs with embedded plugins only).
      diag.notice("plugin-sync", sync.detail ?? sync.label)
    }
  }

  // Embedded plugins ship inside the agent's own checkout: `<repo>/plugins/`.
  // `import.meta.dirname` (Bun + Node 20+) of this file is `<repo>/src`, so
  // climb one level. This makes ask-mode/diff-view/env-info/memory work
  // regardless of the user's cwd, not just when cwd === <repo>.
  const thisFileDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))
  const embeddedDir = dirname(thisFileDir)

  // Construct the single AgentContext shared across every plugin
  // dispatch path (tool handlers, prompt fragments, event subs, hook
  // subs, live-area slots, plus their subprocess counterparts). The
  // loader and the live-area scheduler both receive THIS object so
  // plugins see one consistent identity regardless of dispatch path.
  //
  // Source of each field:
  //   - sessionId : metadata.getSessionId() (cached UUIDv4)
  //   - pid       : process.pid (Bun process)
  //   - model     : selectedModel (resolved above by resolveModelId)
  //   - version   : <embeddedDir>/package.json#version, "0.0.0" if missing
  //
  // The object is frozen by createAgentContext, so it can be passed
  // around without defensive copies.
  const agentVersion = readEmbeddedPackageVersion(embeddedDir)
  const agentContext = createAgentContext({
    sessionId: getSessionId(),
    pid: process.pid,
    model: selectedModel,
    version: agentVersion,
  })

  // Mirror MINIMAL_AGENT_MODEL into process.env for legacy direct readers
  // (notably `plugins/quota-status/handler.ts`, which reads
  // `process.env.MINIMAL_AGENT_MODEL`, not `ctx.env`). The loader will
  // also emit MINIMAL_AGENT_* via `agentContextToEnv` into every dispatched
  // ctx.env, but those values are scoped to one handler call and don't
  // reach a `process.env`-only reader.
  process.env.MINIMAL_AGENT_MODEL = selectedModel
  process.env.MINIMAL_AGENT_SESSION_ID = agentContext.sessionId
  process.env.MINIMAL_AGENT_PID = String(agentContext.pid)
  process.env.MINIMAL_AGENT_VERSION = agentContext.version
  // Advertise the managed-binary directory (`~/.minimal-agent/bin`) to every
  // plugin, every session. The host OWNS this dir and provisions binaries into
  // it (see `binaries/store.ts`); plugins must NOT scan the filesystem or
  // hard-code a home path of their own, because the home dir differs per
  // install and the agent is the single party that knows where it put things.
  // The loader already spreads `process.env` into every dispatched `ctx.env`,
  // so setting it here makes `MINIMAL_AGENT_BIN_DIR` reach module handlers and
  // any subprocess they spawn. Set UNCONDITIONALLY (not gated on header /
  // provisioning): a previously-installed binary must still resolve on a
  // scripted `--prompt` run where the provisioning phase is skipped.
  process.env.MINIMAL_AGENT_BIN_DIR = defaultBinDir()
  // Expose the resolved effort to the live-area quota-status plugin so
  // it can surface "effort <level>" as a trailing footer segment. Same
  // overwrite-with-resolved-value pattern as MINIMAL_AGENT_MODEL above:
  // the env var was a user-facing INPUT during resolution (read once at
  // module load, line 161); after this point we own it as the OUTPUT
  // "what we'll actually send on the wire". For a cheap/fast-tier model with
  // no reasoning fields the wire field is suppressed entirely, so we clear
  // the env so the footer doesn't lie.
  if (hidesReasoning) {
    delete process.env.MINIMAL_AGENT_EFFORT
  } else {
    process.env.MINIMAL_AGENT_EFFORT = effort ?? "medium"
  }
  // Mirror the RESOLVED fast-mode state the same way (output, not input):
  // `--fast` on the CLI never wrote the env var, so `process.env`-only
  // readers (session-info's `fast:` line) reported "not fast" for CLI-flag
  // sessions. One source of truth after this point: env reflects what the
  // request path will actually attempt.
  if (speedFast) {
    process.env.MINIMAL_AGENT_FAST = "1"
  } else {
    delete process.env.MINIMAL_AGENT_FAST
  }
  const pluginOverrides = loadPluginEnabledOverrides()
  // Late-bound getter for the agent's LIVE model id. The loader loads before
  // the Agent is constructed, and the model can change mid-session (/model,
  // preflight switch) or differ on resume, so the ModelInfo tool must read the
  // current value, never the boot value. Rebound to `agent.getModel()` below.
  let getLiveModelId: () => string = () => selectedModel
  const loader = await PluginLoader.load({
    embeddedDir,
    userDir,
    homeDir,
    projectDir: process.cwd(),
    coreToolNames,
    // Single AgentContext shared with every plugin dispatch path.
    // Frozen value object; see createAgentContext + AgentContext docs.
    agent: agentContext,
    // Live current-model snapshot for the decoupled `ModelInfo` tool. Reads the
    // agent's CURRENT model (via the late-bound getter) + the shared registry,
    // so it stays correct across mid-session switches and resume.
    modelInfoProvider: () => buildModelInfoSnapshot(getLiveModelId()),
    // Active-provider sub-agent model recommendations (role → concrete model),
    // read live so a delegation plugin maps roles without importing a provider.
    recommendSubagentModels: () => buildSubagentModelRecommendations(getLiveModelId()),
    // Universal opt-out: any plugin with `plugins.<id>.enabled === false`
    // in ~/.minimal-agent/config.jsonc is dropped before validation.
    // The matching `enabled === true` set overrides a manifest-level
    // `enabled: false` author opt-out, so users can flip on a plugin
    // shipped disabled by default.
    disabledPluginIds: pluginOverrides.forceDisabled,
    enabledPluginIds: pluginOverrides.forceEnabled,
  })
  // Expose the loader's event bus to deep emit-points (notably
  // `client.ts`, which broadcasts `quota.headersReceived` after every
  // successful API response — see src/global-bus.ts for the rationale).
  setGlobalEventBus(loader.bus())
  // Per-turn attachment producers + content drains, contributed by
  // plugins through the loader's `turnAttachments` manifest seam (the
  // memory plugin's short-term snapshot + save-echo collector, the
  // tasks snapshot, the sub-agents fleet digest, …). Core consumes ONLY
  // the registry — it neither knows nor imports the producers'
  // identities (the I2 invariant). A disabled/absent plugin simply
  // contributes nothing: the agent then runs without that attachment
  // (graceful degradation, pinned in `src/agent/turn-attachments.test.ts`).
  const turnAttachmentSeam = await instantiateTurnAttachments(
    { sessionId: getSessionId(), bus: loader.bus() },
    (m) => diag.notice("turn-attachments", m),
  )
  const saveEcho = combineTurnDrains(turnAttachmentSeam.drains)
  const loadedTools = loader.getExtraTools()
  const loadedModes = loader.getModes()
  const hasPromptBlock = loader.getPromptBlock() !== null
  // Aggregate flag preserved for downstream system-prompt / tool-hash
  // construction (search this file for `hasPlugins`). Independently of
  // how we choose to render the startup tree, those callers want one
  // bool: "did anything plugin-shaped get loaded".
  const hasPlugins = loadedTools.length > 0 || hasPromptBlock || loadedModes.length > 0
  // Show what the plugin layer actually contributes — names of callable
  // tools rather than an aggregate `3 tool(s)`. The active mode (if any)
  // gets its own row below at the `printStartupRow("mode", …)` site, so
  // we don't duplicate it here. Modes that exist but aren't active are
  // intentionally not surfaced — discoverable via Shift+Tab.
  //
  // The tools row is the one row that WRAPS rather than truncates: the
  // full inventory stays visible, flowing onto continuation lines under
  // the value column when it overruns the terminal width.
  if (loadedTools.length > 0) {
    printStartupToolsRow(loadedTools)
  } else if (hasPromptBlock || loadedModes.length > 0) {
    // Plugins ran but contribute only prompt fragments / live-area
    // slots / modes — keep a quiet row so it's visible the layer is
    // wired without bragging about it.
    printStartupRow("plugins", c.dim("loaded"))
  }
  // Plugin setup phase: binary provisioning. Each plugin's optional `setup()`
  // declares the external binaries it needs (hardcoded url/sha256/version); the
  // host installs/updates any that are missing or outdated into the managed
  // `~/.minimal-agent/bin/`, with a startup-row spinner + a syslog audit trail
  // in `~/.minimal-agent/ma.log`. A plugin NEVER downloads or probes paths
  // itself. If a plugin marks a binary mandatory (`haltIfMissing`) and it can't
  // be provisioned, we stop here with the plugin's message rather than let the
  // user hit a broken tool at first call.
  //
  // Gated to header runs (interactive boots) for the same reason as the plugin
  // clone: a scripted `--prompt` / piped run shouldn't reach out to the network
  // or grow the install set under the user's feet. Opt out entirely with
  // MINIMAL_AGENT_NO_BINARY_SETUP=1.
  if (SHOW_HEADER && process.env.MINIMAL_AGENT_NO_BINARY_SETUP !== "1") {
    const { provisionPluginBinaries } = await import("./startup/provision-binaries.ts")
    await provisionPluginBinaries(loader)
  }

  // Resolve the initial mode. In non-interactive (--prompt/`-`/positional)
  // we default to ASK so one-shot runs are read-only by default; the user
  // opts out via `--mode none`, `MINIMAL_AGENT_MODE=none`, or
  // `config.mode = "none"`. See `resolveInitialModeId` for full precedence.
  const initialModeId =
    loadedModes.length > 0
      ? resolveInitialModeId(
          {
            args,
            env: { MODE: process.env.MINIMAL_AGENT_MODE },
            config: { mode: userConfig.mode },
          },
          loader.getDefaultModeId(),
        )
      : null
  // Per-mode user-config overlays for permissions. Snapshotted once at
  // startup; the user can edit `~/.minimal-agent/config.jsonc` and
  // restart to apply. (Hot-reload of permissions is future work.) The
  // overlay map is queried on demand inside `ModeManager.effectivePermissions`.
  const modeUserOverrides = loadedModes.length > 0 ? loadModeUserOverrides() : new Map()
  const modeManager =
    loadedModes.length > 0
      ? new ModeManager(
          loadedModes,
          initialModeId,
          undefined,
          undefined,
          (modeId) => modeUserOverrides.get(modeId) ?? null,
        )
      : null
  if (modeManager?.active()) {
    // Use the manifest's `label` (e.g. "ASK") rather than the lowercase
    // `id` so the startup row matches the prompt prefix the user sees a
    // moment later (`ASK ❯ `). Falls back to upper-cased id when label
    // isn't declared, mirroring `ModeManager.computePromptPrefix`.
    const m = modeManager.active()!
    const label = m.label ?? m.id.toUpperCase()
    printStartupRow("mode", c.bold(c.cyan(label)))
  }

  // Quota check — verify account has quota before starting conversation
  // with a cheap probe request.
  //
  // Skipped automatically when ANY loaded plugin contributes a live-area
  // slot with id `"quota"` — the slot will fetch the same data
  // asynchronously after REPL boot, so blocking the boot here would just
  // duplicate the work and re-introduce the latency we're trying to
  // eliminate. The user-facing benefit: the live area shows up
  // instantly; the quota row populates a moment later.
  const hasQuotaSlot = loader.getLiveAreaSlots().some((s) => s.definition.id === "quota")
  const shouldSkipQuota =
    !commandPlan.needsQuota ||
    // Only meaningful for a provider that declares a quota-probe seam. A
    // provider whose quota fills from chat traffic (or that has no quota
    // concept) declares none and skips the blocking boot probe. See
    // `providerWantsQuotaProbe` in src/startup/provider-presentation.ts.
    !providerWantsQuotaProbe(selectedProviderId) ||
    args.includes("--skip-quota") ||
    process.env.MINIMAL_AGENT_SKIP_QUOTA === "1" ||
    userConfig.skipQuota === true ||
    hasQuotaSlot

  if (!shouldSkipQuota) {
    const quotaSpinner = startStartupRowSpinner("quota", c.dim("checking..."))
    const result = await checkQuota(auth)
    if (!result.ok) {
      quotaSpinner.fail(`${c.boldRed("failed")} \x1b[1;31m✗\x1b[22;39m`)
      console.error(
        `  ${c.boldRed("error")} quota check failed. Account may not have quota or token is invalid.`,
      )
      process.exit(1)
    }
    // Banner quota summary: provider-NEUTRAL path. checkQuota's broadcast
    // just populated the quota cache; the provider plugin's session-info
    // seam parses its own header shapes into neutral QuotaWindows, and core
    // renders those (Phase 14 — header-name knowledge left core).
    let quotaSegment = ""
    try {
      const info = await resolveProviderSessionInfo(selectedModel)
      quotaSegment = formatQuotaWindows(info.quota?.windows ?? [], {
        leadSpaces: 2,
        showOverage: process.env.MINIMAL_AGENT_QUOTA_OVERAGE === "1",
        overage: info.quota?.overage,
      })
    } catch {
      // No provider session seam (or cold cache): skip the segment.
    }
    quotaSpinner.ok(`${c.boldGreen("ok")} ${c.boldGreen("✔")}${quotaSegment}`)
  }
  // Resolve --resume: load prior conversation if asked.
  // We resolve the sid, load the session, hash-check against current
  // system/tools, and prepare `initialMessages` to seed the new agent.
  let resumeSid: string | null = null
  let initialMessages: import("./client.ts").Message[] = []
  let resumeBanner: string | null = null
  // tool_use_id → epoch ms, derived from each AssistantRecord's `ts` field
  // for the tool_use blocks it contained. Threaded through replayToScrollback
  // so the time-hint suffix on replayed tool headers shows the historical
  // moment, not the time-of-replay. Stays empty when not resuming.
  let toolStartTimes: Map<string, number> | null = null
  // Per-message timestamp parallel to `initialMessages`, also derived from
  // the JSONL records. Used by replayToScrollback to stamp each
  // `<mode-change>` chip with `YYYY-MM-DD HH:MM` of the prompt that
  // shipped the toggle, instead of "(now)". Stays null when not resuming.
  let userTimestamps: (Date | null)[] | null = null
  // tool_use_id → live transcript presentation overrides (display /
  // displayHeader / displayFooter) for each tool result that carried
  // them at write time. Threaded through replayToScrollback so plugin-
  // driven renders (Edit's unified diff, Tasks' tree, etc.) survive
  // `--resume` instead of regressing to the model-facing `content`
  // text. Stays null for sessions written before the field landed and
  // for non-resume runs.
  let toolDisplays: Map<
    string,
    { display?: string; displayHeader?: string; displayFooter?: string }
  > | null = null
  // Trailing user message that was typed and submitted but never got an
  // assistant reply (aborted/crashed/killed before any tokens streamed).
  // `loadSession` extracts it from `messages` so the API never sees a
  // `[..., user, user]` sequence; we restore it into the editor on REPL
  // start so the user lands on a populated input and can hit Enter (or
  // edit / clear) instead of losing their draft to the void. See
  // `extractPendingDraft` in `./session-restore.ts`.
  let pendingDraft: string | null = null
  if (resumeArg) {
    try {
      resumeSid = resolveSessionTarget(resumeArg, process.cwd())
      if (!resumeSid) {
        console.error(`  ${c.boldRed("error")} no saved sessions found to --resume last`)
        process.exit(1)
      }
      const loaded = loadSession(resumeSid)
      initialMessages = loaded.messages
      pendingDraft = loaded.pendingDraft
      // Build the tool_use_id → ts(ms) lookup for the replay time-hint.
      // We use AssistantRecord.ts because that's the moment the assistant
      // message containing the tool_use block arrived — i.e. the moment
      // the live REPL drew the `╭` header. This is approximate (the tool
      // executes shortly after) but accurate enough for the human-facing
      // "when did this happen" hint.
      toolStartTimes = new Map<string, number>()
      for (const r of loaded.records) {
        if (r.kind !== "assistant") continue
        const ms = Date.parse(r.ts)
        if (Number.isNaN(ms)) continue
        for (const blk of r.content) {
          if (blk.type === "tool_use") {
            toolStartTimes.set((blk as import("./client.ts").ToolUseBlock).id, ms)
          }
        }
      }
      // Per-message timestamps for the replay mode-change chip. Derived
      // from the same `records` walk that `foldRecords` uses, so the
      // resulting array is index-parallel to `initialMessages`. See
      // `userTimestampsFromRecords` in `src/session-replay.ts`.
      userTimestamps = userTimestampsFromRecords(loaded.records)
      // Live transcript presentation overrides (display / displayHeader
      // / displayFooter), keyed by tool_use_id. Threads the per-session
      // `<sid>.tasks.jsonl` sidecar (when present) so the Task deriver
      // can render historical task calls with full ANSI styling AND
      // per-call status snapshots, instead of falling back to the
      // structural content-split path. The sidecar load is best-effort:
      // a missing file just yields a `null` sidecar, which the deriver
      // handles by taking the structural path. Parsed via the
      // core-local `parseReplaySidecarTasks` (a structural mirror of
      // the tasks plugin's parser — the I2 invariant keeps the plugin
      // import out of core). See `toolDisplaysFromRecords` +
      // `deriveTaskDisplay` for the per-call cutoff semantics.
      const sidecarPath = join(resolveSessionsDir(), `${resumeSid}.tasks.jsonl`)
      let sidecarTasks: import("./session-replay-derivers.ts").ReplaySidecarTask[] | null = null
      try {
        if (existsSync(sidecarPath)) {
          const text = readFileSync(sidecarPath, "utf8")
          sidecarTasks = parseReplaySidecarTasks(text)
        }
      } catch {
        // Best-effort: a malformed sidecar is just treated as missing.
        sidecarTasks = null
      }
      toolDisplays = toolDisplaysFromRecords(loaded.records, { sidecarTasks })
      const turns = initialMessages.length
      const droppedNote =
        loaded.dropped.length > 0
          ? ` ${c.dim(`(dropped ${loaded.dropped.length} corrupt line(s))`)}`
          : ""
      const repairNote = loaded.repaired ? ` ${c.dim("(repaired trailing turn)")}` : ""
      // Surface draft restoration in the startup tree so the user sees a
      // single-source-of-truth explanation for the prefilled editor.
      // The hint line printed after replay (see below) gives the
      // editor-adjacent context, but a user scanning the startup banner
      // alone should still understand why their input is non-empty.
      const draftNote = pendingDraft !== null ? ` ${c.dim("(unsent draft restored)")}` : ""
      resumeBanner = `resume ${c.cyan(resumeSid)} ${c.dim(`(${turns} message(s))`)}${repairNote}${droppedNote}${draftNote}`
      printStartupRow("resume", resumeBanner)
      // Rehydrate ModeManager's lastAdvertisedModeId from the persisted
      // history so the first consume after resume does NOT re-emit a
      // redundant `from="default" to="<id>"` attachment for a mode the
      // model already saw in its conversation. The active mode in this
      // process is still set by the normal precedence (CLI > env >
      // config > plugin-default); only the "what the model knows"
      // bookkeeping is rehydrated here.
      if (modeManager) {
        const lastTo = lastAdvertisedModeFromHistory(initialMessages)
        modeManager.primeLastAdvertised(lastTo)
      }
      // Hash drift: compute below once we have system+tools.
    } catch (err) {
      console.error(
        `  ${c.boldRed("error")} could not resume session ${resumeArg}: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    }
  }
  closeStartupTree()

  // Flush any diagnostics that fired during the banner draw. The
  // scrollback sink was put into buffering mode right after construction
  // (above) precisely so a plugin-loader / auth / config warning
  // emitted mid-banner can't tear through the `╭ │ │ ╰` box mid-paint.
  // After this call any further `diag.warn(...)` lands directly in
  // scrollback via the sink's writer, which is what we want for the
  // interactive session.
  scrollbackSink?.flushBuffer()

  // Compute systemHash + toolsHash for the session-store meta record (and
  // for resume drift detection). These mirror what agent.run() would
  // compute internally — we duplicate the recipe here because the meta
  // record is written at session OPEN, before any run() call.
  const pluginBlock = (hasPlugins ? loader : null)?.getPromptBlock() ?? null
  const modeAddition = modeManager?.systemPromptAddition() ?? ""
  const sessionContextForHash =
    pluginBlock && modeAddition
      ? `${pluginBlock}\n\n${modeAddition}`
      : pluginBlock != null
        ? pluginBlock
        : modeAddition !== ""
          ? modeAddition
          : null
  const { DEFAULT_REFLECTION_INTERVAL, DEFAULT_REFLECTION_COOLDOWN_MS } = await import(
    "./headers.ts"
  )
  const { resolveSystemPromptForModel } = await import("./llm/system-prompt.ts")
  // Mirror Agent's runtime defaults explicitly so the systemHash captured
  // at session open matches what `agent.run()` will compute on the first
  // turn. Resume drift detection compares these two hashes : if they
  // diverge, a yellow warning fires on --resume. The defaults below MUST
  // track the Agent class field defaults in src/agent.ts (reflectionInterval,
  // reflectionCooldownMs, maxToolRounds=Number.POSITIVE_INFINITY).
  //
  // Routed through the SAME provider-resolving `resolveSystemPromptForModel`
  // the Agent uses (keyed by the selected model + auth kind), so the
  // provider's preamble (Anthropic billing/identity, or a neutral identity)
  // is folded into the hash identically at both call sites. If we later add
  // CLI flags / config knobs for these values, both call sites must thread
  // the same value. Resolve blob-store enablement BEFORE the hash so the
  // resume drift detector treats "blob store on" vs "off" as distinct
  // prefix shapes (cheap; config loader is memoized).
  const blobStoreEnabled = loadBlobStoreConfig().config.enabled
  const systemForHash = sessionContextForHash
    ? JSON.stringify(
        resolveSystemPromptForModel(selectedModelBase, {
          sessionContext: sessionContextForHash,
          reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
          reflectionCooldownMs: DEFAULT_REFLECTION_COOLDOWN_MS,
          maxToolRounds: Number.POSITIVE_INFINITY,
          blobStoreEnabled,
          authKind: auth.type,
        }),
      )
    : ""
  const allToolsForHash = (hasPlugins ? loader : null)
    ? [...TOOL_DEFINITIONS, ...(loader.getExtraTools() as typeof TOOL_DEFINITIONS)]
    : [...TOOL_DEFINITIONS]
  const toolsForHash = JSON.stringify(
    allToolsForHash.map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.input_schema,
    })),
  )
  const systemHash = shortHash(systemForHash)
  const toolsHash = shortHash(toolsForHash)

  // Session store + blob store + resume warnings + attach/detach
  // lifecycle markers. Lives in `src/startup/session-store-boot.ts`;
  // see that module for the fork-on-resume + best-effort semantics.
  const sid = getSessionId()
  const { store, blobStore } = await bootSessionStores({
    sid,
    resumeSid,
    selectedModel,
    systemHash,
    toolsHash,
  })

  // Shared time-hint tracker. One instance threads through both
  // session-replay (for the historical tool headers when --resume hydrates
  // from JSONL) AND the live Agent (for new tool headers in this session).
  // The tracker carries day-state across calls so the date prefix only
  // re-emits on calendar rollover — including the rollover from the last
  // replayed tool to the first live tool.
  const toolTimeTracker = new ToolTimeTracker()

  const agent = new Agent({
    auth,
    model: selectedModel,
    effort,
    speed,
    thinkingDisplay,
    loader: hasPlugins ? loader : null,
    modeManager,
    saveEcho,
    // All plugin-contributed producers ride the generic array, in
    // registry order (memory's short-term snapshot, tasks snapshot,
    // sub-agents fleet digest, …) — same model-visible attachment order
    // as the old named wiring. The named `shortTermSnapshot` /
    // `tasksAttachment` params stay unset: core no longer knows those
    // producers' identities.
    turnAttachments: turnAttachmentSeam.producers,
    store,
    blobStore,
    initialMessages,
    toolTimeTracker,
  })
  // Point the ModelInfo provider at the agent's live model from here on.
  getLiveModelId = () => agent.getModel()

  // Ready banner : emitted ONCE here so it lands in scrollback right
  // under the startup header, BEFORE any resume replay. Previously the
  // banner was emitted from inside `runRepl` / `runReplLiveArea`, which
  // on resume placed it BELOW the replayed content (visible jump:
  // header > replay > hint, instead of header > hint > replay).
  //
  // Skipped for non-interactive modes (`--prompt`, `-`, bare positional)
  // where there's no REPL prompt to introduce. `extractPromptFromArgs`
  // is pure (no stdin read) so calling it here is cheap; the later
  // `extractPrompt()` call still runs to drive the actual non-interactive
  // branch.
  const promptSource = extractPromptFromArgs(args)
  const willEnterRepl = promptSource.kind === "none"
  if (willEnterRepl) {
    const stdoutCols = (process.stdout as { columns?: number }).columns ?? 80
    process.stdout.write(buildReadyBanner(modeManager, stdoutCols))
  }

  // Replay prior conversation to scrollback when resuming. We write
  // straight to stdout BEFORE the live-area compositor mounts, so the
  // history lands in normal terminal scrollback and the pinned editor
  // appears underneath it. For non-interactive (`--prompt`) mode we skip
  // the replay — the user just wants the next reply, not the history.
  //
  // `formatterCmd` is passed through so assistant text/thinking blocks
  // render through mdstream (or whatever formatter the user configured),
  // matching the live REPL's markdown rendering. Without this, replayed
  // markdown shows up as raw `**bold**` / `# heading` source text.
  //
  // We also enter this block when `pendingDraft` is set but the
  // conversation history is empty (a session that was aborted before any
  // assistant turn ever completed). In that case there's nothing to
  // replay but we still want the resume header + draft hint to paint, so
  // the user sees a coherent "you're resuming session X, here's your
  // unsent prompt" story instead of an unexplained populated editor.
  const isInteractiveResume = resumeSid && !args.includes("--prompt")
  const shouldEmitResumeBlock =
    isInteractiveResume && (initialMessages.length > 0 || pendingDraft !== null)
  if (shouldEmitResumeBlock) {
    const stdoutSink = { write: (s: string) => process.stdout.write(s) }
    stdoutSink.write(
      buildResumeHeader({
        sid: resumeSid as string,
        turns: initialMessages.length,
        model: selectedModel,
      }),
    )
    if (initialMessages.length > 0) {
      // Build the tool presentation map (icon + color) for replay. Mirror
      // the live agent's `toolPresentation` construction in
      // `src/agent.ts`: built-ins come from `TOOL_DEFINITIONS`, plugin
      // tools come from `PluginLoader.getExtraTools`, and aliases inherit
      // their canonical's presentation. Without this map the replayed
      // `╭` header drops the icon (`» Bash`, `✦ Edit`, `✔ Task`) and
      // falls back to the bare bold tool name in orange.
      const toolPresentation = new Map<
        string,
        { icon?: string; color?: string; headerKey?: string }
      >()
      for (const t of TOOL_DEFINITIONS) {
        if (t.icon || t.color) toolPresentation.set(t.name, { icon: t.icon, color: t.color })
      }
      if (loader) {
        for (const t of loader.getExtraTools()) {
          if (t.icon || t.color || t.headerKey)
            toolPresentation.set(t.name, { icon: t.icon, color: t.color, headerKey: t.headerKey })
        }
        for (const [alias, canonical] of loader.getToolAliases()) {
          const pres = toolPresentation.get(canonical)
          if (pres && !toolPresentation.has(alias)) toolPresentation.set(alias, pres)
        }
      }
      await replayToScrollback(initialMessages, stdoutSink, {
        modeManager,
        formatterCmd,
        toolTimeTracker,
        toolStartTimes,
        userTimestamps: userTimestamps ?? undefined,
        toolDisplays,
        toolPresentation,
      })
      stdoutSink.write("\n")
    }
    if (pendingDraft !== null) {
      // One-line dim hint directly above where the live editor will
      // mount. The draft text itself is NOT painted here, the editor's
      // own prefilled buffer is the visual proof. Keeping this compact
      // avoids a heavy strikethrough echo for multi-KB drafts (the
      // motivating session in #7548d4b2 had a 4222-char draft).
      stdoutSink.write(
        `  ${c.dim("──")} ${c.dim("unsent draft restored to input · press Enter to send, or edit")} ${c.dim("──")}\n\n`,
      )
    }
  }

  // Non-interactive mode: send prompt, print response, exit
  const prompt = await extractPrompt()
  if (prompt) {
    // Breathing room between the closed startup tree (stderr) and the
    // streamed response (stdout). The interactive REPL gets this for
    // free via the Compositor; the non-interactive path doesn't. When
    // the header is suppressed (typical for `--prompt`) there's nothing
    // to breathe from, so skip the leading blank line — script-friendly.
    if (SHOW_HEADER) process.stdout.write("\n")
    const formatter = formatterCmd ? new Formatter(formatterCmd, process.stdout) : null
    if (formatter) formatter.start()

    const baseSink = (s: string) => {
      if (formatter) formatter.write(s)
      else process.stdout.write(s)
    }
    const pluginStream = hasPlugins ? new PluginStream(baseSink, loader, process.cwd()) : null

    try {
      const gen = agent.run(prompt)
      while (true) {
        const { done, value } = await gen.next()
        if (done) break
        if (pluginStream) {
          const p = pluginStream.feed(value)
          if (p) await p
        } else {
          baseSink(value)
        }
      }
      if (pluginStream) await pluginStream.end()
    } finally {
      if (formatter) await formatter.end()
    }

    process.stdout.write("\n")
    return
  }

  // Interactive REPL mode.
  //
  // Live-area path: when stdout is a TTY and the user hasn't opted out, we
  // mount a {@link Compositor} so the multiline prompt stays pinned to the
  // bottom of the screen while streamed output and tool transcripts scroll
  // above. Disabled when not a TTY, when MINIMAL_AGENT_NO_LIVE_AREA=1, or
  // when TERM=dumb (which doesn't reliably honor DECSTBM).
  const noLiveArea =
    process.env.MINIMAL_AGENT_NO_LIVE_AREA === "1" ||
    process.env.TERM === "dumb" ||
    process.stdout.isTTY !== true

  // Resolve --spinner / MINIMAL_AGENT_SPINNER → instantiated spinner.
  // Unknown names log a warning and fall back to the default preset so a
  // typo never breaks the REPL.
  let spinner: Spinner<StatusSpinnerTheme> | undefined
  if (spinnerName) {
    const preset: NamedSpinnerPreset | null = getSpinnerPreset(spinnerName)
    if (preset) {
      spinner = preset.factory()
    } else {
      console.error(
        `  ${c.boldRed("warn")} unknown spinner preset "${spinnerName}". ` +
          `Run with ${c.cyan("--list-spinners")} to see available ids.`,
      )
    }
  }

  if (noLiveArea) {
    await runRepl(agent, { formatterCmd, auth, spinner })
  } else {
    // Full interactive TTY stack (capability probes, compositor,
    // interceptor, editor, resize fan-out, Auto-ASK) lives in
    // `src/startup/live-repl.ts`. `runRepl` is passed in as a value to
    // keep that module import-cycle-free with `../agent.ts`.
    const { runLiveAreaRepl } = await import("./startup/live-repl.ts")
    await runLiveAreaRepl({
      agent,
      repl: runRepl,
      formatterCmd,
      auth,
      spinner,
      args,
      userConfig,
      modeManager,
      hasPlugins,
      loader,
      pendingDraft,
    })
  }

  process.exit(0)
}

main()
  .finally(async () => {
    await defaultNetworkClient.close()
  })
  .catch((err: Error) => {
    console.error("fatal:", err.message)
    process.exit(1)
  })
