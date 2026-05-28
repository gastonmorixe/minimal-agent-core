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
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { SaveEchoCollector } from "../plugins/memory/lib/save-echo.ts"
import { ShortTermSnapshot } from "../plugins/memory/lib/short-term-snapshot.ts"
import { TasksAttachment } from "../plugins/tasks/lib/attachment.ts"
import { parseFile as parseTasksFile } from "../plugins/tasks/lib/parse.ts"

import { Agent, c, runRepl } from "./agent.ts"
import { getAuth } from "./auth.ts"
import { AutoAskController } from "./auto-ask.ts"
import { resolveFormatter } from "./auto-formatter.ts"
import { BlobStore, loadBlobStoreConfig } from "./blob-store.ts"
import { catRows, DEFAULT_CAT } from "./cats.ts"
import { planCommand } from "./cli/command-plan.ts"
import { normalizeArgs } from "./cli-args.ts"
import { checkQuota } from "./client.ts"
import { runAuthStatusCommand } from "./commands/auth-status.ts"
import { DumpCommandError, runDumpCommand } from "./commands/dump.ts"
import { runListFlagsCommand } from "./commands/list-flags.ts"
import { runListModelsCommand } from "./commands/list-models.ts"
import { runListSpinnersCommand } from "./commands/list-spinners.ts"
import { runLoginCommand } from "./commands/login.ts"
import { runLogoutCommand } from "./commands/logout.ts"
import { resolveSessionTarget } from "./commands/session-index.ts"
import { runSessionsCommand } from "./commands/sessions.ts"
import { loadModeUserOverrides, loadPluginEnabledOverrides, loadUserConfig } from "./config.ts"
import { getDiagnosticBus } from "./diagnostic-bus.ts"
import { resolveEffort } from "./effort-resolution.ts"
import { extractPromptFromArgs } from "./extract-prompt.ts"
import { Formatter, parseFormatterCommand } from "./formatter.ts"
import { getGlobalEventBus, setGlobalEventBus } from "./global-bus.ts"
import { DEFAULT_MODEL, VERSION } from "./headers.ts"
import { bootstrapAnthropic } from "./llm/providers/anthropic/index.ts"
import { getSessionId } from "./metadata.ts"
import { lastAdvertisedModeFromHistory, ModeManager } from "./modes.ts"
import { defaultNetworkClient } from "./network/index.ts"
import { resolveInitialModeId, resolveShowHeader } from "./non-interactive-defaults.ts"
import { PluginLoader } from "./plugins/loader.ts"
import { PluginStream } from "./plugins/stream.ts"
import { formatQuotaSummary } from "./quota-format.ts"
import { buildReadyBanner } from "./ready-banner.ts"
import {
  buildResumeHeader,
  replayToScrollback,
  toolDisplaysFromRecords,
  userTimestampsFromRecords,
} from "./session-replay.ts"
import { loadSession } from "./session-restore.ts"
import { SessionStore, shortHash } from "./session-store.ts"
import { BREATHING_DOT } from "./spinner/library/frames.ts"
import { ANSI_PALETTE_RAINBOW } from "./spinner/library/palettes.ts"
import { getSpinnerPreset, type NamedSpinnerPreset } from "./spinner/named-presets.ts"
import type { Spinner } from "./spinner.ts"
import { formatStartupToolsRow } from "./startup-tools-row.ts"
import type { StatusSpinnerTheme } from "./status.ts"
import { displayWidth, truncateDisplayWidth, wrapRows } from "./term-width.ts"
import { ToolTimeTracker } from "./tool-time.ts"
import { TOOL_DEFINITIONS } from "./tools.ts"

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = normalizeArgs(process.argv.slice(2))

// Populate the canonical LLM model + provider registry. Idempotent.
// Done at top-level so `--list-models`, `--model`, and downstream
// `Agent.run` all see the registered Anthropic catalog. Other
// providers (OpenAI, …) will register themselves the same way once
// their adapters land (see private/research/2026-05-28-llm-providers/).
bootstrapAnthropic()

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
const sessionsIdx = args.indexOf("--sessions")
const wantListSessions = sessionsIdx !== -1
// The token after `--sessions` is an optional fuzzy query. A leading
// dash means it's the next flag, not our value.
const sessionsQuery =
  sessionsIdx !== -1 && args[sessionsIdx + 1] && !args[sessionsIdx + 1].startsWith("-")
    ? args[sessionsIdx + 1]
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
  wantListFlags,
  wantListSpinners,
  wantListModels,
  wantLogin,
  wantLogout,
  wantAuthStatus,
})

function printHelp(): void {
  const lines = [
    `  ${c.bold("minimal-agent")} ${c.dim(`v${VERSION}`)}`,
    `  ${c.faintWhite(c.italic("by Gaston Morixe"))} ${c.faintWhite("·")} ${c.faintWhite(c.italic("github.com/gastonmorixe/minimal-agent"))}`,
    "",
    `  ${c.bold("Usage")}`,
    `    ${c.dim("$")} minimal-agent ${c.dim("[options]")}`,
    `    ${c.dim("$")} minimal-agent ${c.dim('"prompt text"')}`,
    `    ${c.dim("$")} echo "prompt" | minimal-agent ${c.dim("-")}`,
    "",
    `  ${c.bold("Options")}`,
    `    ${c.cyan("-m")}, ${c.cyan("--model")} ${c.dim("<id>")}        Select model ${c.dim(`(default: ${DEFAULT_MODEL})`)}`,
    `    ${c.cyan("-e")}, ${c.cyan("--effort")} ${c.dim("<level>")}    Reasoning effort: low, medium, high, xhigh, max ${c.dim("(or MINIMAL_AGENT_EFFORT)")}`,
    `    ${c.cyan("--fast")}                    Fast-mode dispatch ${c.dim('(speed:"fast"; opus-4-8 only; ~2.5x tok/s, ~2x cost; or MINIMAL_AGENT_FAST=1)')}`,
    `    ${c.cyan("--thinking-display")} ${c.dim("<mode>")}  Force thinking display: summarized or omitted ${c.dim("(or MINIMAL_AGENT_THINKING_DISPLAY)")}`,
    `    ${c.cyan("-f")}, ${c.cyan("--formatter")} ${c.dim("<cmd>")}   Pipe output through formatter ${c.dim("(default: mdstream)")}`,
    `    ${c.cyan("--formatter-args")} ${c.dim("<args>")}   Extra args appended to the formatter ${c.dim('(e.g. "--table-fit"; or MINIMAL_AGENT_FORMATTER_ARGS)')}`,
    `    ${c.cyan("-s")}, ${c.cyan("--spinner")} ${c.dim("<preset>")}  Pick a status spinner preset ${c.dim("(see --list-spinners)")}`,
    `    ${c.cyan("-p")}, ${c.cyan("--prompt")} ${c.dim("<text>")}     Non-interactive: send prompt, print, exit`,
    `    ${c.cyan("--mode")} ${c.dim("<id|none>")}         Initial mode ${c.dim("(default: ask in non-interactive, plugin default otherwise)")}`,
    `    ${c.cyan("--header")} ${c.dim("/")} ${c.cyan("--no-header")}      Force startup tree on/off ${c.dim("(default: hidden in non-interactive)")}`,
    `    ${c.cyan("-d")}, ${c.cyan("--debug")}             Enable debug logging ${c.dim("(or DEBUG=1)")}`,
    `    ${c.cyan("-v")}, ${c.cyan("--verbose")}           Don't truncate debug output ${c.dim("(or VERBOSE=1)")}`,
    `    ${c.cyan("--skip-quota")}            Skip startup quota check ${c.dim("(or MINIMAL_AGENT_SKIP_QUOTA=1)")}`,
    `    ${c.cyan("--show-hidden-chars")}      Reveal spaces/tabs/newlines as faint glyphs (input editor + --debug output)`,
    "",
    `  ${c.bold("Auth")} ${c.dim("(also as subcommands: `login`, `logout`, `auth-status`)")}`,
    `    ${c.cyan("--login")} ${c.dim("[--email <addr>]")}   Sign in via OAuth (PKCE manual-paste flow)`,
    `    ${c.cyan("--logout")}                   Clear minimal-agent credentials ${c.dim("(~/.minimal-agent/auth.jsonc)")}`,
    `    ${c.cyan("--auth-status")}              Show login status, account, scopes, expiry`,
    "",
    `  ${c.bold("Info")} ${c.dim("(also as subcommands: `models [list]`, `flags [list]`, ...)")}`,
    `    ${c.cyan("--list-models")} ${c.dim("/")} ${c.cyan("--models")}       Fetch and display available models`,
    `    ${c.cyan("--list-flags")} ${c.dim("/")} ${c.cyan("--flags")}         Show beta feature flags`,
    `    ${c.cyan("--list-spinners")} ${c.dim("/")} ${c.cyan("--spinners")}   Show available spinner presets`,
    `    ${c.cyan("--sessions")} ${c.dim("[<query>]")}          List saved sessions ${c.dim("(fuzzy filter on date/sid/cwd)")}`,
    `    ${c.cyan("-r")}, ${c.cyan("--resume")} ${c.dim("<sid|last>")}     Resume a saved session ${c.dim("(also: `sessions resume <sid>`)")}`,
    `    ${c.cyan("--dump")} ${c.dim("<sid|last>")}         Dump a full session history to stdout`,
    `    ${c.cyan("--dump-format")} ${c.dim("<md|xml>")}    Output format for --dump ${c.dim("(default: md)")}`,
    `    ${c.cyan("-h")}, ${c.cyan("--help")}                 Show this help`,
    "",
    `  ${c.bold("Env")}`,
    `    ${c.cyan("DEBUG=1")}                  Verbose request/response logging to stderr`,
    `    ${c.cyan("MINIMAL_AGENT_TRANSPORT")}  Transport: http2 ${c.dim("(default)")} or fetch`,
    `    ${c.cyan("MINIMAL_AGENT_ALLOW_FETCH_FALLBACK=1")}  Allow fetch fallback after HTTP/2 failure`,
    `    ${c.cyan("MINIMAL_AGENT_NET_DBG=1")}  Mirror raw HTTP req/res to ${c.dim("./.net-dbg/")}`,
    `    ${c.cyan("CLAUDE_CODE_EXTRA_METADATA")}  JSON object merged into metadata.user_id`,
    `    ${c.cyan("MINIMAL_AGENT_SPINNER")}    Spinner preset id ${c.dim("(same values as --spinner)")}`,
    `    ${c.cyan("MINIMAL_AGENT_EFFORT")}     Reasoning effort ${c.dim("(low | medium | high | xhigh | max)")}`,
    `    ${c.cyan("MINIMAL_AGENT_FAST=1")}     Opt into fast-mode dispatch ${c.dim("(opus-4-8 only)")}`,
    `    ${c.cyan("MINIMAL_AGENT_THINKING_DISPLAY")}  Force thinking display ${c.dim("(summarized | omitted)")}`,
    `    ${c.cyan("MINIMAL_AGENT_FORMATTER_ARGS")}  Extra args for the formatter ${c.dim('(shell-style, e.g. "--table-fit")')}`,
    `    ${c.cyan("MINIMAL_AGENT_CONFIG")}     Override config path ${c.dim("(default: ~/.minimal-agent/config.jsonc)")}`,
    `    ${c.cyan("MINIMAL_AGENT_MEMORY_NAMESPACE")}  Namespace memory paths under ${c.dim("namespaces/<ns>/")} ${c.dim("(memory plugin)")}`,
    `    ${c.cyan("MINIMAL_AGENT_THEME")}      UI theme: ${c.dim("dark | light | high-contrast")}`,
    `    ${c.cyan("MINIMAL_AGENT_NO_LIVE_AREA=1")}  Disable live-area REPL (fall back to legacy raw input)`,
    `    ${c.cyan("MINIMAL_AGENT_HEADER")}     Force startup tree: ${c.dim("0|1 (default: hidden in non-interactive)")}`,
    `    ${c.cyan("MINIMAL_AGENT_MODE")}       Initial mode id (or ${c.dim('"none"')} to disable)`,
    `    ${c.cyan("MINIMAL_AGENT_CONTINUATION_PROMPT")}  Override continuation-prompt prefix ${c.dim('(default: "  ")')}`,
    `    ${c.cyan("MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1")}  Show spaces/tabs/newlines as faint glyphs in the editor`,
    `    ${c.cyan("MINIMAL_AGENT_SKIP_QUOTA=1")}       Skip startup quota check`,
    `    ${c.cyan("MINIMAL_AGENT_NO_HISTORY=1")}       Disable ↑/↓ prompt history ${c.dim("(history plugin)")}`,
    `    ${c.cyan("MINIMAL_AGENT_FILE_LOCK_DISABLED=1")}  Disable cooperative file locking ${c.dim("(file-lock plugin)")}`,
    `    ${c.cyan("NERD_FONT=1")}              Enable Nerd Font glyphs in TUI`,
    "",
    `  ${c.bold("Plugins")} ${c.dim("(toggle via ~/.minimal-agent/config.jsonc)")}`,
    `    ${c.dim("Opt out  :")} ${c.dim('{ "plugins": { "<id>": { "enabled": false } } }')}`,
    `    ${c.dim("Opt in   :")} ${c.dim('{ "plugins": { "<id>": { "enabled": true } } }')}  ${c.dim("(for plugins shipped disabled)")}`,
    "",
    `    ${c.dim("Built-in :")} ask-mode, diff-view, env-info, file-lock, history,`,
    `    ${c.dim("           ")} memory, quota-status, tasks, web-search`,
    `    ${c.dim("Disabled :")} interleave-thinking ${c.dim("(opt in to use; see Opt in above)")}`,
    "",
    `  ${c.bold("Docs")}`,
    `    ${c.dim("docs/CHANGELOG.md")}                Release notes`,
    `    ${c.dim("docs/caching.md")}                  Prompt caching: breakpoints, TTL, verification`,
    `    ${c.dim("docs/tool-icons-and-colors.md")}    Tool transcript icons and color scheme`,
    `    ${c.dim("docs/plugin-prompt-block-structure.md")}  How plugin PROMPT.md blocks compose`,
    `    ${c.dim("docs/repl-prompt-response-separator.md")}  REPL prompt↔response separator rules`,
    `    ${c.dim("docs/repl-text-transcript-separators.md")}  REPL text↔transcript separator rules`,
    `    ${c.dim("docs/input/multiline-prompt-fixes.md")}  Multiline-prompt input notes`,
  ]
  console.log(lines.join("\n"))
}

function printStartupHeader(): void {
  if (!SHOW_HEADER) return
  const by = c.faintWhite(c.italic("by"))
  const author = c.faintWhite(c.italic("Gaston Morixe"))
  const sep = c.faintWhite("·")
  const url = c.faintWhite(c.italic("github.com/gastonmorixe/minimal-agent"))
  // Rounded tree: ╭ for the opener, │ for body rows, ╰ to close.
  // Standard Unicode has no rounded ├ tee, so we drop the middle tee
  // entirely and rely on the first/last rounded corners to give the
  // tree a softer, more curved feel.
  const line1 = `  ${c.faintWhite("╭")} ${c.bold(c.pink("minimal-agent"))} ${c.faintWhite(`v${VERSION}`)}`
  // Truncate line2 to terminal width so it never wraps and leaves an
  // unstyled continuation on narrow terminals (e.g. mobile-sized 52-col).
  const cols = stderrCols()
  const line2Full = `  ${c.faintWhite("│")} ${by} ${author} ${sep} ${url}`
  const line2 = truncateDisplayWidth(line2Full, cols)

  // Tiny cat mascot, anchored a fixed gap after the LONGER of the two
  // header lines — not flush to the terminal's right edge. Anchoring
  // to the terminal width means a resize re-flows the cat sideways
  // and breaks alignment between line 1 and line 2; anchoring to the
  // header content keeps the cat glued to the wordmark forever.
  //
  // We only use the top two rows of the 3-row cat (ears + face) because
  // the third header line is just `│` and the user's request was the
  // two title lines specifically. Faint color so the cat doesn't
  // upstage the wordmark.
  const [ears, face /*, mouth */] = catRows(DEFAULT_CAT)
  const GAP = 4 // spaces between header text and cat
  const anchorCol = Math.max(displayWidth(line1), displayWidth(line2)) + GAP
  // If the terminal is too narrow to fit even the cat, drop it rather
  // than wrap. The cat's widest row is `( ^.^ )` ≈ 7 cells; require
  // anchorCol + catWidth ≤ columns, otherwise skip.
  const catWidth = Math.max(displayWidth(ears), displayWidth(face))
  const fits = anchorCol + catWidth <= cols

  // Breathing room between the user's shell prompt and our banner when
  // running interactively. Skipped on non-TTY (piped/redirected stderr)
  // so log files don't gain a stray leading blank line.
  if (process.stderr.isTTY) console.error("")
  console.error(fits ? padTo(line1, anchorCol) + c.faintWhite(ears) : line1)
  console.error(fits ? padTo(line2, anchorCol) + c.faintWhite(face) : line2)
  console.error(`  ${c.faintWhite("│")}`)
}

/**
 * Pad `line` with spaces on the right so its visible width reaches
 * `targetCol`. ANSI escapes are excluded from width math. If `line`
 * is already wider than `targetCol`, returned unchanged (no truncation).
 */
function padTo(line: string, targetCol: number): string {
  const w = displayWidth(line)
  if (w >= targetCol) return line
  return line + " ".repeat(targetCol - w)
}

// Visible-cell count of the fixed chrome that precedes the value in every
// startup row: "  │ " (4) + label.padEnd(9) (9) + "  " (2) = 15 cells.
const STARTUP_ROW_OVERHEAD = 15

/** Current stderr terminal width, falling back to 80 for non-TTY / unknown. */
function stderrCols(): number {
  return (process.stderr as { columns?: number }).columns ?? 80
}

/**
 * Truncate a startup-row value so the full row fits on a single terminal
 * line. Prevents wrapped rows from confusing the cursor-up math in
 * `closeStartupTree` and keeps the tree visually compact on narrow terminals.
 */
function fitRowValue(value: string): string {
  const cols = stderrCols()
  const maxWidth = Math.max(0, cols - STARTUP_ROW_OVERHEAD)
  return truncateDisplayWidth(value, maxWidth)
}

let lastStartupRow: { label: string; value: string; rowWidth: number } | null = null

function printStartupRow(label: string, value: string): void {
  if (!SHOW_HEADER) return
  const v = fitRowValue(value)
  const row = `  ${c.faintWhite("│")} ${c.sky(label.padEnd(9))}  ${v}`
  console.error(row)
  lastStartupRow = { label, value: v, rowWidth: displayWidth(row) }
}

/**
 * Close the startup tree by rewriting the last `│` row with `╰`.
 *
 * On a TTY we walk the cursor up to the start of the last row and erase
 * everything to end-of-screen before reprinting with the closing corner,
 * so the tree terminates visually on its final entry (e.g. `╰ quota   ok`).
 * Using `\x1b[J` (erase to end of screen) instead of `\x1b[2K` (erase
 * current line only) handles the edge case where the previous row wrapped
 * to multiple physical lines — all continuation lines are cleared cleanly.
 *
 * On non-TTY output (pipes, redirects) we just append a standalone `╰`
 * closer line since cursor motion wouldn't render.
 */
function closeStartupTree(): void {
  if (!SHOW_HEADER) return
  if (!lastStartupRow) return
  const { label, value, rowWidth } = lastStartupRow
  lastStartupRow = null
  if (process.stderr.isTTY) {
    const cols = stderrCols()
    // How many physical lines did the last row occupy? With fitRowValue()
    // applied this is always 1, but we compute it defensively so any
    // future caller that bypasses fitRowValue still gets correct cursor math.
    const physLines = wrapRows(rowWidth, cols)
    // Go up physLines lines to the start of the row, then erase from
    // cursor to end of screen (clears the row + any wrapped continuation).
    process.stderr.write(`\x1b[${physLines}A\x1b[J`)
    console.error(`  ${c.faintWhite("╰")} ${c.sky(label.padEnd(9))}  ${value}`)
  } else {
    console.error(`  ${c.faintWhite("╰")}`)
  }
}

/**
 * Print a startup row that animates a breathing-dot spinner while an async
 * task runs, then resolves to a final value in-place.
 *
 * Returns `{ ok(value), fail(value) }` — call one of them when the task
 * settles to overwrite the spinner with the final state and advance the
 * cursor. `lastStartupRow` is updated so `closeStartupTree` works correctly.
 *
 * On non-TTY output the spinner is skipped and only the final value prints.
 */
function startStartupRowSpinner(
  label: string,
  checking: string,
): {
  ok(value: string): void
  fail(value: string): void
} {
  // Header suppressed (typical for non-interactive `--prompt` runs):
  // no rows, no spinner, no settle output. Callers don't need to know.
  if (!SHOW_HEADER) {
    return { ok() {}, fail() {} }
  }
  const PIPE = `  ${c.faintWhite("│")} `
  const prefix = `${PIPE}${c.sky(label.padEnd(9))}  `

  // Non-TTY: no cursor tricks — just print the row when settled.
  if (!process.stderr.isTTY) {
    return {
      ok(value) {
        const v = fitRowValue(value)
        const row = `${prefix}${v}`
        console.error(row)
        lastStartupRow = { label, value: v, rowWidth: displayWidth(row) }
      },
      fail(value) {
        const v = fitRowValue(value)
        const row = `${prefix}${v}`
        console.error(row)
        lastStartupRow = { label, value: v, rowWidth: displayWidth(row) }
      },
    }
  }

  let frameIdx = 0
  let colorIdx = 0

  function coloredDot(): string {
    const char = BREATHING_DOT[frameIdx] ?? "·"
    return ANSI_PALETTE_RAINBOW[colorIdx % ANSI_PALETTE_RAINBOW.length]!(char)
  }

  // Print the first frame immediately (no trailing newline — will be overwritten).
  process.stderr.write(`${prefix}${coloredDot()} ${checking}`)

  const timer = setInterval(() => {
    frameIdx = (frameIdx + 1) % BREATHING_DOT.length
    colorIdx++
    process.stderr.write(`\r${prefix}${coloredDot()} ${checking}`)
  }, 160)

  function settle(value: string): void {
    clearInterval(timer)
    const v = fitRowValue(value)
    process.stderr.write(`\r\x1b[2K${prefix}${v}\n`)
    lastStartupRow = { label, value: v, rowWidth: displayWidth(`${prefix}${v}`) }
  }

  return {
    ok: settle,
    fail: settle,
  }
}

// `formatQuotaSummary` lives in `./quota-format.ts` so the startup tree
// AND the live-area `quota-status` plugin can share one source of
// truth. The startup row passes `leadSpaces: 2` to align with the
// tree's `╰ ok ✔` indent; the live-area slot passes `0`.

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

/**
 * Wrap `getAuth()` with a first-time / stale-credentials login prompt.
 *
 * On a fresh install minimal-agent's own store (`~/.minimal-agent/auth.jsonc`)
 * is empty; `getAuth()` throws `"No minimal-agent credentials found …"`.
 * Rather than dump the user back at the shell with an error, we detect that
 * case in interactive mode (TTY on stdout AND stdin) and offer to run
 * `--login` inline. If they accept, we run the OAuth flow and retry
 * `getAuth()`.
 *
 * Non-interactive runs (non-TTY, `--prompt`, piped stdin) keep the current
 * "fail fast with a hint" behavior — script-friendly and predictable.
 *
 * Stale credentials (refresh token rejected) take a similar path: we surface
 * the error and ask if they want to re-login. `getAuth()` itself doesn't
 * eagerly refresh unless the token is within `EXPIRY_BUFFER_MS` of expiry,
 * so this branch only fires when we're about to make a real API call AND
 * the cached token won't survive it. The 401-after-refresh case in
 * `client.ts` is handled separately (it bubbles a clean error that already
 * mentions `--login`).
 */
async function getAuthWithFirstTimePrompt(): Promise<Awaited<ReturnType<typeof getAuth>>> {
  try {
    return await getAuth()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const looksLikeMissing =
      /No minimal-agent credentials|No credentials found|No OAuth access token|No refresh token/i.test(
        msg,
      )
    const looksLikeStale = /invalid_grant|stale/i.test(msg)
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true

    if (!interactive || (!looksLikeMissing && !looksLikeStale)) {
      throw err
    }

    // Interactive — offer a one-shot login. Print the diagnosis first so
    // the user sees WHY the prompt appeared, then ask y/N. Default is
    // "no" for stale credentials (user might prefer to re-run with
    // different flags) and "yes" for fresh installs (the only sane next
    // step).
    const headline = looksLikeMissing
      ? `${c.bold("Welcome to minimal-agent")} — you're not signed in yet.`
      : `${c.bold("Credentials expired")} — refresh token rejected.`
    console.error("")
    console.error(`  ${c.bold(c.pink("⮕"))} ${headline}`)
    console.error(`  ${c.faintWhite("│")} ${c.dim(msg)}`)
    const defaultYes = looksLikeMissing
    const promptText = `  ${c.faintWhite("│")} Sign in now? ${c.dim(defaultYes ? "[Y/n]" : "[y/N]")} `
    const answer = await readSingleLineFromStdin(promptText)
    const yes = answer === "" ? defaultYes : /^y(es)?$/i.test(answer.trim())
    if (!yes) {
      console.error(
        `  ${c.faintWhite("╰")} ${c.dim("aborted — run `minimal-agent --login` later to sign in.")}`,
      )
      throw err
    }
    console.error(`  ${c.faintWhite("╰")} ${c.dim("starting login…")}`)
    console.error("")

    const code = await runLoginCommand()
    if (code !== 0) {
      // Preserve the original error as `cause` so callers (or a future
      // structured-logging hook) can surface BOTH the post-login retry
      // failure AND the original "no creds / invalid_grant" diagnosis.
      throw new Error(
        "Login failed; see messages above. Re-run `minimal-agent --login` to retry.",
        { cause: err },
      )
    }
    // Login wrote the keychain; retry. If THIS still fails, surface
    // the error — we're not going to loop.
    return await getAuth()
  }
}

/**
 * Read one line from stdin without entering raw mode. Used for the
 * first-time-login y/N prompt. Implementation is the same shape as
 * `commands/login.ts`'s `readLine` but inlined so we don't pull in the
 * full login command module before we know it's needed.
 */
async function readSingleLineFromStdin(promptText: string): Promise<string> {
  const { createInterface } = await import("node:readline")
  return new Promise<string>((resolve) => {
    process.stderr.write(promptText)
    const rl = createInterface({ input: process.stdin, terminal: false })
    // Resolve BEFORE closing + a `settled` guard: `rl.close()` emits
    // `'close'` synchronously, so `resolve(line)` after `rl.close()` would
    // lose the race to the close handler's `resolve("")`. Mirrors the fix in
    // commands/login.ts's `readLine` and src/input.ts's `readFallback`.
    let settled = false
    rl.once("line", (line) => {
      settled = true
      resolve(line)
      rl.close()
    })
    rl.once("close", () => {
      if (!settled) resolve("")
    })
  })
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
    case "list-flags":
      runListFlagsCommand()
      return
    case "list-spinners":
      runListSpinnersCommand()
      return
    case "list-models": {
      const auth = await getAuth()
      await runListModelsCommand(auth)
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

  // Fire-and-forget Anthropic bootstrap probe (v2.1.154+). Hits
  // /api/claude_cli/bootstrap once and overlays any server-shipped
  // model-cost overrides (`additional_model_costs`) onto the canonical
  // registry — lets Anthropic ship a new model id without a CLI release.
  //
  // OAuth-only (the endpoint 4xx's API-key callers). Failures (network
  // hiccup, server error) are absorbed silently; the local pricing
  // tables remain authoritative as a fallback.
  if (auth.type === "oauth") {
    const { fetchBootstrap, applyBootstrapOverrides } = await import(
      "./llm/providers/anthropic/index.ts"
    )
    const registry = await import("./llm/model-registry.ts")
    const selectedModelForBootstrap = model ?? userConfig.model ?? DEFAULT_MODEL
    void fetchBootstrap({
      auth: { kind: "oauth", token: auth.token },
      modelId: selectedModelForBootstrap.replace(/\[(1|2)m\]/gi, ""),
    })
      .then((resp) => applyBootstrapOverrides(resp, registry))
      .catch(() => {
        // Tolerated: bootstrap is a UX improvement, not a correctness
        // requirement. Local pricing tables stay authoritative.
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

  const selectedModel = model ?? userConfig.model ?? DEFAULT_MODEL
  printStartupRow("model", c.boldCyan(selectedModel))

  // Thinking + effort: surface what we'll actually send on the wire.
  // Defaults live in `sendMessage` in src/client.ts:
  //   thinking: { type: "adaptive" }   — non-haiku only
  //   output_config.effort: "medium"   — non-haiku only
  // Haiku models get neither field, so show "off" for both.
  const isHaiku = selectedModel.includes("haiku")
  const thinkingLabel = isHaiku
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
  const effortLabel = isHaiku
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
  // Embedded plugins ship inside the agent's own checkout: `<repo>/plugins/`.
  // `import.meta.dirname` (Bun + Node 20+) of this file is `<repo>/src`, so
  // climb one level. This makes ask-mode/diff-view/env-info/memory work
  // regardless of the user's cwd, not just when cwd === <repo>.
  const thisFileDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))
  const embeddedDir = dirname(thisFileDir)
  // Expose the resolved model id to plugin prompt fragments (e.g. env-info)
  // so they can embed it in the system prompt. Subprocess probes inherit
  // process.env, so a plain assignment is enough.
  process.env.MINIMAL_AGENT_MODEL = selectedModel
  // Expose the resolved effort to the live-area quota-status plugin so
  // it can surface "effort <level>" as a trailing footer segment. Same
  // overwrite-with-resolved-value pattern as MINIMAL_AGENT_MODEL above:
  // the env var was a user-facing INPUT during resolution (read once at
  // module load, line 161); after this point we own it as the OUTPUT
  // "what we'll actually send on the wire". For haiku the wire field is
  // suppressed entirely, so we clear the env so the footer doesn't lie.
  if (isHaiku) {
    delete process.env.MINIMAL_AGENT_EFFORT
  } else {
    process.env.MINIMAL_AGENT_EFFORT = effort ?? "medium"
  }
  // Expose the full session id so the live-area footer can render a
  // shortened anchor (the renderer takes the first 8 hex chars — enough
  // to disambiguate inside `~/.minimal-agent/sessions/` for any
  // realistic session count; collision probability ≈ N²/2^33). We
  // forward the FULL id and let the consumer decide on truncation so
  // other consumers (env-info prompt fragments, downstream tools) can
  // still see the unabridged value if they need it.
  process.env.MINIMAL_AGENT_SESSION_ID = getSessionId()
  const pluginOverrides = loadPluginEnabledOverrides()
  const loader = await PluginLoader.load({
    embeddedDir,
    homeDir,
    projectDir: process.cwd(),
    coreToolNames,
    // getSessionId() was already called above (printStartupRow "session"),
    // so it's safely cached; passing it lets prompt fragments embed the
    // id (e.g. env-info ships it in the <env> block).
    sessionId: getSessionId(),
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
  // Memory plugin v0.3 collectors. Both subscribe to the loader's bus
  // (or read from disk on demand). The Agent receives them via its
  // optional `saveEcho` / `shortTermSnapshot` constructor params and
  // drains them at every user-message seam — see `Agent.run` and
  // `plugins/memory/lib/{save-echo,short-term-snapshot}.ts`.
  const saveEcho = SaveEchoCollector.attach(loader.bus())
  const shortTermSnapshot = new ShortTermSnapshot(getSessionId())
  // Tasks plugin attachment producer. Reads the per-session JSONL on
  // every initial-seam call and renders `<ma::plugin::tasks …>…</ma::plugin::tasks>`
  // for the model. Unconditional construction (mirrors ShortTermSnapshot):
  // if the user disables the `tasks` plugin in config, the Task tool is
  // skipped at loader time and the file stays empty, so this attachment
  // returns null and costs nothing. See
  // `plugins/tasks/lib/attachment.ts`.
  const tasksAttachment = new TasksAttachment(getSessionId())
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
  const toolsValue = formatStartupToolsRow(loadedTools)
  if (toolsValue !== null) {
    printStartupRow("tools", toolsValue)
  } else if (hasPromptBlock || loadedModes.length > 0) {
    // Plugins ran but contribute only prompt fragments / live-area
    // slots / modes — keep a quiet row so it's visible the layer is
    // wired without bragging about it.
    printStartupRow("plugins", c.dim("loaded"))
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

  // Quota check — verify account has quota before starting conversation.
  // Matches v2.1.91 behavior: cheap haiku request with max_tokens=1.
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
    quotaSpinner.ok(
      `${c.boldGreen("ok")} ${c.boldGreen("✔")}${formatQuotaSummary(result.rateLimits, { leadSpaces: 2 })}`,
    )
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
      // handles by taking the structural path. See
      // `toolDisplaysFromRecords` + `deriveTaskDisplay` for the
      // per-call cutoff semantics.
      const sidecarPath = join(homedir(), ".minimal-agent", "sessions", `${resumeSid}.tasks.jsonl`)
      let sidecarTasks: import("../plugins/tasks/lib/parse.ts").Task[] | null = null
      try {
        if (existsSync(sidecarPath)) {
          const text = readFileSync(sidecarPath, "utf8")
          sidecarTasks = parseTasksFile(text)
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
  const { buildSystemPrompt, DEFAULT_REFLECTION_INTERVAL, DEFAULT_REFLECTION_COOLDOWN_MS } =
    await import("./headers.ts")
  // Mirror Agent's runtime defaults explicitly so the systemHash captured
  // at session open matches what `agent.run()` will compute on the first
  // turn. Resume drift detection compares these two hashes : if they
  // diverge, a yellow warning fires on --resume. The defaults below MUST
  // track the Agent class field defaults in src/agent.ts (reflectionInterval,
  // reflectionCooldownMs, maxToolRounds=Number.POSITIVE_INFINITY).
  //
  // If we later add CLI flags or config-file knobs for these values, both
  // call sites must thread the same value : the buildSystemPrompt arg here
  // and the Agent constructor opt at the session-startup point further down.
  // Resolve blob-store enablement BEFORE the hash so the resume drift
  // detector treats "blob store on" vs "blob store off" as distinct
  // prefix shapes. Cheap (config loader is memoized) and matches the
  // "thread the same value to buildSystemPrompt and the Agent" rule
  // documented in the comment above.
  const blobStoreEnabled = loadBlobStoreConfig().config.enabled
  const systemForHash = sessionContextForHash
    ? JSON.stringify(
        buildSystemPrompt({
          sessionContext: sessionContextForHash,
          reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
          reflectionCooldownMs: DEFAULT_REFLECTION_COOLDOWN_MS,
          maxToolRounds: Number.POSITIVE_INFINITY,
          blobStoreEnabled,
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

  // Open the session store. Two paths:
  //   - new session: SessionStore.open(getSessionId())
  //   - resume:      SessionStore.fork({ srcSid: resumeSid, dstSid: getSessionId() })
  //
  // Fork semantics matter: every other subsystem (banner, file log, plugin
  // sessionId, tasks/scratch files, goodbye banner's `--resume <id>` hint)
  // ALREADY uses `getSessionId()` — the fresh per-process UUID. Before this
  // path was wired, the store was the only outlier: it appended to the
  // parent's `<resumeSid>.jsonl` (with existsOk:true), so the goodbye
  // banner's `minimal-agent --resume <new-sid>` pointed to a file that
  // did not exist. Forking copies the parent's records into a new file
  // under the new sid, aligns the store with everything else, and leaves
  // the parent untouched (non-destructive — re-resuming the parent works
  // forever).
  //
  // `SessionStore.fork` ALSO copies per-sid sidecar files (tasks plugin's
  // `<sid>.tasks.jsonl`, memory plugin's `<sid>.scratch.md`, draft store's
  // `<sid>.draft`, …) from `srcSid` to `dstSid`. Without this, sidecar
  // plugins read from an empty file on resume even though the
  // conversation log references their prior state (e.g. the model marks
  // task #6 done but task #6 doesn't exist in the new file). The blob
  // DIRECTORY is the one exception — tool results carry absolute paths
  // into the parent's `<srcSid>.blobs/`, so blobs survive resume by
  // reference without duplication.
  //
  // Resume drift check emits a one-line yellow warning when system/tools
  // have changed since the parent was saved.
  const sid = getSessionId()
  let store: SessionStore | null = null
  try {
    store = resumeSid
      ? SessionStore.fork({
          srcSid: resumeSid,
          dstSid: sid,
          model: selectedModel,
          cwd: process.cwd(),
          systemHash,
          toolsHash,
          agentVersion: VERSION,
          argv: process.argv,
        })
      : SessionStore.open({
          sid,
          model: selectedModel,
          cwd: process.cwd(),
          systemHash,
          toolsHash,
          agentVersion: VERSION,
          argv: process.argv,
        })
  } catch (err) {
    // Persistence is best-effort; never block startup on it. The agent
    // will work without a store (just no resume for THIS session).
    console.error(
      `  ${c.boldYellow("warn")} session store unavailable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Per-session blob store for raw tool outputs. Lives at
  // `~/.minimal-agent/sessions/<sid>.blobs/`, populated lazily as tools
  // emit large or truncated bodies. Best-effort like the session store:
  // a missing or disabled blob store means tool results still flow,
  // just without the `<ma::agent::raw-output …/>` footer pointer. The config gates
  // (enabled, minBytesToPersist, max caps, skipTools, env opt-out) are
  // resolved here and frozen for the session.
  let blobStore: BlobStore | null = null
  try {
    const { config: blobConfig } = loadBlobStoreConfig()
    if (blobConfig.enabled) {
      blobStore = new BlobStore({
        sid,
        config: blobConfig,
      })
    }
  } catch (err) {
    console.error(
      `  ${c.boldYellow("warn")} blob store unavailable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Soft warn-on-resume: if another agent process appears to be live on
  // this same session, the user is about to fork the conversation.
  // Liveness is OS-probed (kill(0) + ps -o lstart=) so this catches the
  // common cases (running, dead, pid-reused) without relying on clean
  // detach markers. See `src/session-liveness.ts`.
  if (resumeSid) {
    try {
      const { getSessionLiveness } = await import("./session-liveness.ts")
      const live = getSessionLiveness(resumeSid)
      if (live.status === "live" && live.pid !== process.pid) {
        console.error(
          `  ${c.boldYellow("warn")} session ${resumeSid} appears live ` +
            `(pid ${live.pid}, since ${live.since}); resuming anyway will ` +
            `fork the conversation`,
        )
      }
    } catch {
      // best-effort; never block resume on liveness probing
    }

    try {
      const loaded = loadSession(resumeSid)
      const drifted =
        loaded.meta &&
        (loaded.meta.systemHash !== systemHash || loaded.meta.toolsHash !== toolsHash)
      if (drifted) {
        console.error(
          `  ${c.boldYellow("warn")} system prompt or tool set changed since this session was saved — resuming anyway`,
        )
      }
    } catch {
      // already reported above
    }
  }

  // Mark this process as the current owner of the session (new OR resume).
  // Liveness is OS-probed by readers; the AttachRecord is just the pointer
  // they walk. The matching DetachRecord is best-effort and missing it is
  // explicitly fine — readers verify against the live OS, not the log.
  if (store) {
    try {
      store.appendAttach()
    } catch {
      // best-effort
    }
    let detachWritten = false
    const writeDetach = (reason: "exit" | "signal" | "error", code?: number) => {
      if (detachWritten || !store) return
      detachWritten = true
      // Skip cleanup on the error paths — a SIGINT/uncaughtException
      // mid-turn may have committed nothing yet but the user still wants
      // an audit trail (and the on-disk meta can be useful for debugging
      // a crash). Only the clean "exit" path with no recorded
      // conversation is eligible for the session to vanish.
      if (reason === "exit") {
        try {
          if (store.cleanupIfUnused()) return
        } catch {
          // best-effort; fall through and write the detach marker
        }
      }
      try {
        store.appendDetach(reason, code)
      } catch {
        // swallow — we may already be inside process.exit
      }
    }
    // The editor-controller's signal handlers call process.exit(), which
    // fires the 'exit' event and runs this handler. So a single 'exit'
    // hook covers SIGINT/SIGTERM/SIGHUP plus clean exits. Fatal handlers
    // only record the detach marker, then rethrow so the runtime still
    // terminates instead of continuing in a corrupted state.
    process.on("exit", (code) => writeDetach("exit", typeof code === "number" ? code : 0))
    process.on("uncaughtException", (err) => {
      writeDetach("error")
      throw err
    })
    process.on("unhandledRejection", (reason) => {
      writeDetach("error")
      throw reason
    })
  }

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
    shortTermSnapshot,
    tasksAttachment,
    store,
    blobStore,
    initialMessages,
    toolTimeTracker,
  })

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
      const toolPresentation = new Map<string, { icon?: string; color?: string }>()
      for (const t of TOOL_DEFINITIONS) {
        if (t.icon || t.color) toolPresentation.set(t.name, { icon: t.icon, color: t.color })
      }
      if (loader) {
        for (const t of loader.getExtraTools()) {
          if (t.icon || t.color) toolPresentation.set(t.name, { icon: t.icon, color: t.color })
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
    const { Compositor } = await import("./ui/compositor.ts")
    const { EditorController } = await import("./editor-controller.ts")
    const { StdioInterceptor } = await import("./ui/stdio-interceptor.ts")
    const { detectSynchronizedOutput } = await import("./ui/term-caps.ts")
    const { probeNerdGlyphCells, setNerdGlyphCells } = await import("./nerd-glyph-width.ts")

    // Probe the terminal for DEC mode 2026 (synchronized output) BEFORE
    // creating the editor. Detection puts stdin into raw mode briefly,
    // sends a DECRPM query, and parses the reply. If the terminal supports
    // it, the Compositor wraps each redraw batch in BSU/ESU so the user
    // sees a single atomic frame instead of erase→write→redraw flicker.
    // Any typeahead bytes that arrived during the probe are saved and
    // re-emitted to the editor below so a fast-typing user doesn't lose
    // a keystroke. Disabled (and detection is skipped) when MINIMAL_AGENT_NO_SYNC=1.
    const syncProbe =
      process.env.MINIMAL_AGENT_NO_SYNC === "1"
        ? { syncOutput: false, unparsed: "" }
        : await detectSynchronizedOutput(process.stdin as any, process.stdout as any)

    // Resolve PUA Nerd-Font glyph cell width. Precedence:
    //   env MINIMAL_AGENT_NERD_GLYPH_CELLS  >  config.nerdGlyphCells  >  probe
    //
    // The env / config values "1" and "2" force the width without probing.
    // "auto" (or unset) runs the probe; on probe failure / non-TTY / inside
    // tmux the module default (`1`) survives. We re-use stdin in raw mode
    // here -- detectSynchronizedOutput already raw'd it -- and chain the
    // probes with `alreadyRaw: true` so we don't double-toggle.
    const envCells = process.env.MINIMAL_AGENT_NERD_GLYPH_CELLS
    const cfgCells = userConfig.nerdGlyphCells
    let nerdProbeUnparsed = ""
    if (envCells === "1" || cfgCells === 1) {
      setNerdGlyphCells(1)
    } else if (envCells === "2" || cfgCells === 2) {
      setNerdGlyphCells(2)
    } else if (envCells === undefined || envCells === "auto" || cfgCells === "auto") {
      const r = await probeNerdGlyphCells(process.stdin as any, process.stdout as any, {
        alreadyRaw: true,
      })
      nerdProbeUnparsed = r.unparsed
      // r.cells is null on failure → module-level default (`1`) is preserved.
    } else if (envCells === "0" || envCells === "off" || envCells === "false") {
      // Treat falsy values as "skip probe, keep default" -- matches
      // MINIMAL_AGENT_NO_SYNC's stance for the sync probe.
      // (No-op: setNerdGlyphCells not called.)
    } else {
      // Unrecognized value: fall through to probe (don't break startup on a typo).
      const r = await probeNerdGlyphCells(process.stdin as any, process.stdout as any, {
        alreadyRaw: true,
      })
      nerdProbeUnparsed = r.unparsed
    }

    // Two-phase wiring: the StdioInterceptor needs a compositor to forward
    // intercepted writes to, and the Compositor needs an output that
    // bypasses the interceptor (so its own escape sequences don't recurse).
    // We give the compositor an adapter whose write() goes through the
    // interceptor's raw-write escape hatch when available.
    let interceptorRef: import("./ui/stdio-interceptor.ts").StdioInterceptor | null = null
    const compositor = new Compositor({
      output: {
        isTTY: process.stdout.isTTY,
        get columns() {
          return process.stdout.columns
        },
        get rows() {
          return process.stdout.rows
        },
        write: (s: string) => {
          if (interceptorRef) {
            return interceptorRef.rawStdoutWrite(s) as boolean
          }
          return process.stdout.write(s)
        },
      } as any,
      syncOutput: syncProbe.syncOutput,
    })
    const interceptor = new StdioInterceptor(compositor)
    interceptorRef = interceptor

    const continuationPrompt = process.env.MINIMAL_AGENT_CONTINUATION_PROMPT ?? "  "
    const showHiddenCharsInit =
      process.env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS === "1" ||
      args.includes("--show-hidden-chars") ||
      (modeManager?.editorShowHidden() ?? false)
    const editor = new EditorController({
      prompt: `${c.bold(c.pink("❯"))} `,
      continuationPrompt,
      compositor,
      maxLiveHeight: () => Math.max(2, Math.floor((process.stdout.rows ?? 24) / 2)),
      showHidden: showHiddenCharsInit,
      // Pass the plugin hooks facade so the editor can emit `editor.key`
      // for ArrowUp / ArrowDown / Ctrl+R. Plugins (notably `history`)
      // subscribe via their manifest's `hooks` array. Null when no
      // plugins are loaded — the editor short-circuits the emit.
      ...(hasPlugins ? { hooks: loader.hooks() } : {}),
    })
    // Restore the unsent draft (if any) into the editor buffer. This is
    // the resume-time twin of the abort-flow's setBuffer call in
    // `agent.ts` (search "setBuffer" in the abort branch) — same visual
    // idiom: the user sees a populated input with their text, cursor at
    // end, ready to edit or press Enter. The corresponding hint line
    // above the editor was emitted as part of the resume block (see
    // `pendingDraft` handling earlier in this function). Safe before
    // `editor.start()` because `setBuffer` only paints when
    // `this.started` is true; the buffer state is captured and the
    // first repaint shows the prefilled text.
    if (pendingDraft !== null) {
      editor.setBuffer(pendingDraft)
    }
    // Keep show-hidden in sync with mode changes: a mode with
    // `editorShowHidden: true` overrides the env-var/flag baseline.
    if (modeManager) {
      const showHiddenBase =
        process.env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS === "1" || args.includes("--show-hidden-chars")
      modeManager.subscribe((_active) => {
        editor.setShowHidden(showHiddenBase || (modeManager.editorShowHidden() ?? false))
      })
    }
    const onResize = () => {
      compositor.notifyResize()
      editor.notifyResize()
      // Broadcast on the plugin event bus so live-area slots that
      // declare `refreshOn: ["terminal.resize"]` can re-fire their
      // handler off-cycle and reflow. We pass the new cols/rows in
      // the payload for any plugin that wants to skip a refresh when
      // only one dimension changed.
      //
      // This is the "high-level resize notification" the quota-status
      // plugin subscribes to — it must NOT install its own
      // `process.stdout.on("resize", ...)` listener (low-level SIGWINCH
      // ownership lives here and only here, so the order of
      // `notifyResize()` → bus emit stays deterministic).
      const cols = typeof process.stdout.columns === "number" ? process.stdout.columns : 0
      const rows = typeof process.stdout.rows === "number" ? process.stdout.rows : 0
      getGlobalEventBus()?.emit("terminal.resize", { cols, rows })
    }
    process.stdout.on("resize", onResize)

    // Auto-ASK: silently flip into ASK mode when the editor buffer reads
    // like a question, revert on action verbs, never override a manual
    // Shift+Tab. Opt-out via `MINIMAL_AGENT_AUTO_ASK=0` or `autoAsk:false`
    // in the user config. Only wires up when an "ask" mode actually
    // exists in the active manifest set (otherwise: dead code).
    if (modeManager && modeManager.list().some((m) => m.id === "ask")) {
      const envOff = process.env.MINIMAL_AGENT_AUTO_ASK === "0"
      const cfgOff = userConfig.autoAsk === false
      if (!envOff && !cfgOff) {
        // Controller installs itself on the editor; the reference is intentionally
        // not retained — it lives until the editor is destroyed.
        void new AutoAskController(editor, modeManager, {
          logger:
            process.env.DEBUG === "1"
              ? (m) => process.stderr.write(`[auto-ask] ${m}\n`)
              : undefined,
        })
      }
    }

    // Install AFTER the editor is built but BEFORE handing control to
    // runRepl: from this point on, every console.log / console.error /
    // direct stderr.write goes through the compositor and respects the
    // live area.
    interceptor.install()

    try {
      await runRepl(agent, {
        formatterCmd,
        auth,
        spinner,
        useLiveArea: true,
        compositor,
        editor,
        // Forward typeahead bytes captured by EITHER probe (DECRPM and the
        // Nerd-glyph CPR probe) so a fast-typing user's first keystroke
        // isn't lost. Order: sync probe first (ran first), then nerd probe.
        initialStdinBytes: syncProbe.unparsed + nerdProbeUnparsed,
        // Threaded into the goodbye banner's `--resume <id>` hint. Empty
        // string when not yet initialized; runReplLiveArea degrades the
        // closer copy in that case.
        sessionId: getSessionId(),
      })
    } finally {
      interceptor.uninstall()
      process.stdout.off("resize", onResize)
    }
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
