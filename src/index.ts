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

import { existsSync } from "node:fs"
import { join } from "node:path"
import { Agent, c, runRepl } from "./agent.ts"
import { getAuth } from "./auth.ts"
import { catRows, DEFAULT_CAT } from "./cats.ts"
import { displayWidth } from "./term-width.ts"
import { checkQuota, listModels } from "./client.ts"
import { Formatter, parseFormatterCommand } from "./formatter.ts"
import { BETA_FLAGS_DETAILED, DEFAULT_MODEL, VERSION } from "./headers.ts"
import { getSessionId } from "./metadata.ts"
import { ModeManager } from "./modes.ts"
import { buildResumeHeader, replayToScrollback } from "./session-replay.ts"
import { loadSession, firstUserPromptSnippet } from "./session-restore.ts"
import {
  defaultSessionsDir,
  indexFilePath,
  type IndexRecord,
  parseLines as parseSessionLines,
  SessionStore,
  sessionFilePath,
  shortHash,
} from "./session-store.ts"
import { readFileSync } from "node:fs"
import { defaultNetworkClient } from "./network/index.ts"
import { PluginLoader } from "./plugins/loader.ts"
import { PluginStream } from "./plugins/stream.ts"
import {
  getSpinnerPreset,
  type NamedSpinnerPreset,
  SPINNER_PRESETS,
} from "./spinner/named-presets.ts"
import type { Spinner } from "./spinner.ts"
import type { StatusSpinnerTheme } from "./status.ts"
import { TOOL_DEFINITIONS } from "./tools.ts"

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

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

const modelIdx = args.indexOf("--model")
const model = modelIdx !== -1 && args[modelIdx + 1] ? args[modelIdx + 1] : undefined

const wantListModels = args.includes("--list-models")
const wantListFlags = args.includes("--list-flags")
const wantListSpinners = args.includes("--list-spinners")

const spinnerIdx = args.indexOf("--spinner")
const spinnerName =
  spinnerIdx !== -1 && args[spinnerIdx + 1]
    ? args[spinnerIdx + 1]
    : process.env.MINIMAL_AGENT_SPINNER

const effortIdx = args.indexOf("--effort")
const effort =
  effortIdx !== -1 && args[effortIdx + 1]
    ? (args[effortIdx + 1] as "high" | "medium" | "low" | "max")
    : undefined

const formatterIdx = args.indexOf("--formatter")
const DEFAULT_FORMATTER = `${process.env.HOME}/Projects/mdstream/target/release/mdstream`
const formatterCmd: string[] | undefined =
  formatterIdx !== -1 && args[formatterIdx + 1]
    ? parseFormatterCommand(args[formatterIdx + 1])
    : existsSync(DEFAULT_FORMATTER)
      ? parseFormatterCommand(DEFAULT_FORMATTER)
      : undefined

// --resume <sid>  resume a saved session (or "last" for the most recent
// session in this cwd, falling back to the global most-recent).
// --sessions       list saved sessions and exit.
const resumeIdx = args.indexOf("--resume")
const resumeArg = resumeIdx !== -1 && args[resumeIdx + 1] ? args[resumeIdx + 1] : undefined
const wantListSessions = args.includes("--sessions")

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
    `    ${c.cyan("--model")} ${c.dim("<id>")}        Select model ${c.dim(`(default: ${DEFAULT_MODEL})`)}`,
    `    ${c.cyan("--effort")} ${c.dim("<level>")}    Reasoning effort: low, medium, high, max`,
    `    ${c.cyan("--formatter")} ${c.dim("<cmd>")}   Pipe output through formatter ${c.dim("(default: mdstream)")}`,
    `    ${c.cyan("--spinner")} ${c.dim("<preset>")}  Pick a status spinner preset ${c.dim("(see --list-spinners)")}`,
    `    ${c.cyan("--prompt")} ${c.dim("<text>")}     Non-interactive: send prompt, print, exit`,
    `    ${c.cyan("--debug")}             Enable debug logging ${c.dim("(or DEBUG=1)")}`,
    `    ${c.cyan("--verbose")}           Don't truncate debug output ${c.dim("(or VERBOSE=1)")}`,
    `    ${c.cyan("--skip-quota")}        Skip startup quota check`,
    "",
    `  ${c.bold("Info")}`,
    `    ${c.cyan("--list-models")}       Fetch and display available models`,
    `    ${c.cyan("--list-flags")}        Show beta feature flags`,
    `    ${c.cyan("--list-spinners")}     Show available spinner presets`,
    `    ${c.cyan("--sessions")}          List saved sessions ${c.dim("(~/.minimal-agent/sessions/)")}`,
    `    ${c.cyan("--resume")} ${c.dim("<sid|last>")} Resume a saved session`,
    `    ${c.cyan("--help")}, ${c.cyan("-h")}          Show this help`,
    "",
    `  ${c.bold("Env")}`,
    `    ${c.cyan("DEBUG=1")}                  Verbose request/response logging to stderr`,
    `    ${c.cyan("MINIMAL_AGENT_TRANSPORT")}  Transport: http2 ${c.dim("(default)")} or fetch`,
    `    ${c.cyan("MINIMAL_AGENT_ALLOW_FETCH_FALLBACK=1")}  Allow fetch fallback after HTTP/2 failure`,
    `    ${c.cyan("MINIMAL_AGENT_NET_DBG=1")}  Mirror raw HTTP req/res to ${c.dim("./.node-net-dbg/")}`,
    `    ${c.cyan("CLAUDE_CODE_EXTRA_METADATA")}  JSON object merged into metadata.user_id`,
    `    ${c.cyan("MINIMAL_AGENT_SPINNER")}    Spinner preset id ${c.dim("(same values as --spinner)")}`,
    `    ${c.cyan("MINIMAL_AGENT_THEME")}      UI theme: ${c.dim("dark | light | high-contrast")}`,
    `    ${c.cyan("MINIMAL_AGENT_NO_LIVE_AREA=1")}  Disable live-area REPL (fall back to legacy raw input)`,
    `    ${c.cyan("MINIMAL_AGENT_CONTINUATION_PROMPT")}  Override continuation-prompt prefix ${c.dim('(default: "  ")')}`,
    `    ${c.cyan("NERD_FONT=1")}              Enable Nerd Font glyphs in TUI`,
    "",
    `  ${c.bold("Docs")}`,
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
  const by = c.faintWhite(c.italic("by"))
  const author = c.faintWhite(c.italic("Gaston Morixe"))
  const sep = c.faintWhite("·")
  const url = c.faintWhite(c.italic("github.com/gastonmorixe/minimal-agent"))
  // Rounded tree: ╭ for the opener, │ for body rows, ╰ to close.
  // Standard Unicode has no rounded ├ tee, so we drop the middle tee
  // entirely and rely on the first/last rounded corners to give the
  // tree a softer, more curved feel.
  const line1 = `  ${c.faintWhite("╭")} ${c.bold(c.pink("minimal-agent"))} ${c.faintWhite(`v${VERSION}`)}`
  const line2 = `  ${c.faintWhite("│")} ${by} ${author} ${sep} ${url}`

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
  const cols = (process.stderr as { columns?: number }).columns ?? 80
  const catWidth = Math.max(displayWidth(ears), displayWidth(face))
  const fits = anchorCol + catWidth <= cols

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

let lastStartupRow: { label: string; value: string } | null = null

function printStartupRow(label: string, value: string): void {
  console.error(`  ${c.faintWhite("│")} ${c.sky(label.padEnd(7))} ${value}`)
  lastStartupRow = { label, value }
}

/**
 * Close the startup tree by rewriting the last `│` row with `╰`.
 *
 * On a TTY we walk the cursor up one line and reprint the row with the
 * closing rounded corner, so the tree terminates visually on its final
 * entry (e.g. `╰ quota   ok`). On non-TTY output (pipes, redirects) we
 * just append a standalone `╰` closer line since cursor motion wouldn't
 * render.
 */
function closeStartupTree(): void {
  if (!lastStartupRow) return
  const { label, value } = lastStartupRow
  lastStartupRow = null
  if (process.stderr.isTTY) {
    // Move cursor up 1 line, clear it, carriage return, reprint with ╰.
    process.stderr.write("\x1b[1A\x1b[2K\r")
    console.error(`  ${c.faintWhite("╰")} ${c.sky(label.padEnd(7))} ${value}`)
  } else {
    console.error(`  ${c.faintWhite("╰")}`)
  }
}

function printFlagsView(): void {
  console.log(`\n  ${c.bold("Beta feature flags")}`)
  console.log(`  ${c.dim("Sent with every Messages API request")}\n`)
  for (const flag of BETA_FLAGS_DETAILED) {
    console.log(`  ${c.dimCyan("╭")} ${c.cyan(flag.id)}`)
    console.log(`  ${c.dimCyan("│")} ${flag.description}`)
    console.log(`  ${c.dimCyan("│")} ${c.dim(`source: ${flag.source}`)}`)
    console.log(`  ${c.dimCyan("╰")} ${c.dim(`when:   ${flag.condition}`)}`)
    console.log()
  }
  console.log(`  ${c.dim(`${BETA_FLAGS_DETAILED.length} flags total`)}`)
}

function printSpinnersView(): void {
  console.log(`\n  ${c.bold("Spinner presets")}`)
  console.log(`  ${c.dim("Pick one with --spinner <id> or env MINIMAL_AGENT_SPINNER=<id>")}\n`)
  for (const p of SPINNER_PRESETS) {
    console.log(`  ${c.dimCyan("╭")} ${c.cyan(p.id)}`)
    console.log(`  ${c.dimCyan("╰")} ${c.dim(p.description)}`)
    console.log()
  }
  console.log(`  ${c.dim(`${SPINNER_PRESETS.length} presets total`)}`)
}

function printModelsView(models: Awaited<ReturnType<typeof listModels>>): void {
  const families = new Map<string, typeof models>()
  for (const modelInfo of models) {
    const family = modelInfo.id.replace(/-\d.*$/, "")
    if (!families.has(family)) {
      families.set(family, [])
    }
    families.get(family)!.push(modelInfo)
  }

  console.log("")
  for (const [family, members] of [...families.entries()].sort()) {
    console.log(`  ${c.bold(family)}`)
    for (const modelInfo of members.sort((a, b) => a.id.localeCompare(b.id))) {
      const id = c.cyan(modelInfo.id.padEnd(24))
      const name = modelInfo.display_name ? c.dim(modelInfo.display_name.padEnd(28)) : "".padEnd(28)
      const date = modelInfo.created_at ? c.dim(modelInfo.created_at.slice(0, 10)) : ""
      console.log(`    ${id} ${name} ${date}`)
    }
    console.log("")
  }
  console.log(`  ${c.dim(`${models.length} models available`)}`)
}

// ---------------------------------------------------------------------------
// Session listing / "resume last" resolution
// ---------------------------------------------------------------------------

/**
 * Read the global sessions index. Returns one record per saved session,
 * in append order (oldest first). Missing index file → empty array.
 */
function readSessionIndex(): IndexRecord[] {
  const path = indexFilePath()
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return []
  }
  const out: IndexRecord[] = []
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    try {
      out.push(JSON.parse(line) as IndexRecord)
    } catch {
      // Skip malformed lines silently — index is best-effort metadata.
    }
  }
  return out
}

/**
 * Resolve `--resume last` to a sid. Prefer the most recent session whose
 * `cwd` matches the current process cwd; fall back to the global most
 * recent. Returns null when no sessions exist.
 */
function resolveLastSessionId(cwd: string): string | null {
  const all = readSessionIndex()
  if (all.length === 0) return null
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].cwd === cwd) return all[i].sid
  }
  return all[all.length - 1].sid
}

/**
 * `--sessions`: print a table of saved sessions and exit. We read from
 * `index.jsonl` (cheap) and grab a one-line snippet of the first user
 * prompt from each session file (slightly more expensive but only one
 * fs.readFileSync per session, and only enough bytes to find the first
 * `"kind":"user"` record).
 */
function printSessionsView(): void {
  const all = readSessionIndex()
  if (all.length === 0) {
    console.log(`\n  ${c.dim("no saved sessions yet")}`)
    console.log(`  ${c.dim(`(sessions are stored at ${defaultSessionsDir()})`)}`)
    return
  }
  console.log("")
  console.log(
    `  ${c.bold("when".padEnd(20))} ${c.bold("sid".padEnd(38))} ${c.bold("model".padEnd(22))} ${c.bold("preview")}`,
  )
  for (const rec of all) {
    let snippet = ""
    try {
      // Read the whole file — they're append-only JSONL, typically small.
      // For huge sessions this is still fine because we only do it on
      // explicit `--sessions` listing (one-shot), not in any hot path.
      const text = readFileSync(sessionFilePath(rec.sid), "utf-8")
      const { records: parsed } = parseSessionLines(text)
      snippet = firstUserPromptSnippet(parsed, 40)
    } catch {
      // ignore — session file may have been deleted
    }
    const when = c.dim(rec.createdAt.replace("T", " ").slice(0, 19))
    const sid = c.cyan(rec.sid.padEnd(38))
    const model = c.dim(rec.model.padEnd(22))
    console.log(`  ${when}  ${sid} ${model} ${c.faintWhite(snippet)}`)
  }
  console.log("")
  console.log(`  ${c.dim(`${all.length} session(s) at ${defaultSessionsDir()}`)}`)
  console.log(`  ${c.dim(`resume with: --resume <sid>  (or --resume last)`)}`)
}

/**
 * Extract a non-interactive prompt from command-line args.
 *
 * Three forms supported (checked in this order):
 * 1. `--prompt <text>` — explicit flag
 * 2. `-` — read from stdin (for piping: `echo hi | minimal-agent -`)
 * 3. Bare positional arg — first non-flag, non-flag-value argument
 *
 * Returns `null` if none of the three forms is present, in which case
 * the agent enters interactive REPL mode instead.
 *
 * @returns The prompt text, or `null` for interactive mode
 */
async function extractPrompt(): Promise<string | null> {
  // --prompt "text"
  const promptIdx = args.indexOf("--prompt")
  if (promptIdx !== -1 && args[promptIdx + 1]) {
    return args[promptIdx + 1]
  }

  // "-" means read from stdin
  if (args.includes("-")) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString("utf-8").trim()
  }

  // Bare positional: any arg that isn't a flag or flag value
  const flagsWithValues = new Set(["--model", "--prompt", "--formatter", "--effort", "--spinner"])
  const flagsNoValue = new Set([
    "--debug",
    "--verbose",
    "--list-models",
    "--list-flags",
    "--list-spinners",
    "--help",
    "-h",
    "-",
    "--skip-quota",
  ])
  const skipNext = new Set<number>()
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValues.has(args[i])) {
      skipNext.add(i)
      skipNext.add(i + 1)
    } else if (flagsNoValue.has(args[i])) {
      skipNext.add(i)
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (!skipNext.has(i) && !args[i].startsWith("--")) {
      return args[i]
    }
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
  printStartupHeader()

  // --sessions: metadata-only; doesn't need auth. Handle before any
  // network/keychain calls so the user can list sessions even when offline
  // or when the keychain isn't available.
  if (wantListSessions) {
    closeStartupTree()
    printSessionsView()
    return
  }

  printStartupRow("session", c.dim(getSessionId()))

  const auth = await getAuth()
  printStartupRow(
    "auth",
    `${auth.type}${auth.accountUuid ? ` ${c.dim(`(account: ${auth.accountUuid.slice(0, 8)}...)`)}` : ""}`,
  )

  // --list-flags: show beta feature flags with documentation and exit
  if (wantListFlags) {
    closeStartupTree()
    printFlagsView()
    return
  }

  // --list-spinners: enumerate registered spinner presets and exit
  if (wantListSpinners) {
    closeStartupTree()
    printSpinnersView()
    return
  }

  // --list-models: fetch available models from the API and exit
  if (wantListModels) {
    closeStartupTree()
    console.error(`\n  ${c.dim("fetching models...")}`)
    const models = await listModels(auth)
    printModelsView(models)
    return
  }

  const selectedModel = model ?? DEFAULT_MODEL
  printStartupRow("model", c.boldCyan(selectedModel))

  // Thinking + effort: surface what we'll actually send on the wire.
  // Defaults live in `sendMessage` in src/client.ts:
  //   thinking: { type: "adaptive" }   — non-haiku only
  //   output_config.effort: "medium"   — non-haiku only
  // Haiku models get neither field, so show "off" for both.
  const isHaiku = selectedModel.includes("haiku")
  const thinkingLabel = isHaiku ? c.dim("off") : "adaptive"
  const effortLabel = isHaiku
    ? c.dim("off")
    : effort
      ? `${effort} ${c.dim("(--effort)")}`
      : `medium ${c.dim("(default)")}`
  printStartupRow("think", thinkingLabel)
  printStartupRow("effort", effortLabel)

  // Quota check — verify account has quota before starting conversation
  // Matches v2.1.91 behavior: cheap haiku request with max_tokens=1
  if (!args.includes("--skip-quota")) {
    const hasQuota = await checkQuota(auth)
    if (!hasQuota) {
      console.error(
        `  ${c.boldRed("error")} quota check failed. Account may not have quota or token is invalid.`,
      )
      process.exit(1)
    }
    printStartupRow("quota", c.boldGreen("ok"))
  }

  // Load TUI plugins from ~/.agents/tui-plugins and <cwd>/tui-plugins.
  // Core tool names must always win over plugin names.
  const coreToolNames = new Set(TOOL_DEFINITIONS.map((t) => t.name))
  const homeDir = process.env.HOME ? join(process.env.HOME, ".agents") : undefined
  // Expose the resolved model id to plugin prompt fragments (e.g. env-info)
  // so they can embed it in the system prompt. Subprocess probes inherit
  // process.env, so a plain assignment is enough.
  process.env.MINIMAL_AGENT_MODEL = selectedModel
  const loader = await PluginLoader.load({
    homeDir,
    projectDir: process.cwd(),
    coreToolNames,
    // getSessionId() was already called above (printStartupRow "session"),
    // so it's safely cached; passing it lets prompt fragments embed the
    // id (e.g. env-info ships it in the <env> block).
    sessionId: getSessionId(),
  })
  const loadedModes = loader.getModes()
  const hasPlugins =
    loader.getExtraTools().length > 0 || loader.getPromptBlock() !== null || loadedModes.length > 0
  if (hasPlugins) {
    const tools = loader.getExtraTools().length
    const modes = loadedModes.length
    const bits: string[] = []
    if (tools > 0) bits.push(`${tools} tool(s)`)
    if (modes > 0) bits.push(`${modes} mode(s)`)
    if (bits.length === 0) bits.push("prompt block")
    printStartupRow("plugins", bits.join(", "))
  }
  const modeManager =
    loadedModes.length > 0 ? new ModeManager(loadedModes, loader.getDefaultModeId()) : null
  if (modeManager?.active()) {
    printStartupRow("mode", c.bold(c.cyan(modeManager.active()!.id)))
  }
  // Resolve --resume: load prior conversation if asked.
  // We resolve the sid, load the session, hash-check against current
  // system/tools, and prepare `initialMessages` to seed the new agent.
  let resumeSid: string | null = null
  let initialMessages: import("./client.ts").Message[] = []
  let resumeBanner: string | null = null
  if (resumeArg) {
    try {
      resumeSid = resumeArg === "last" ? resolveLastSessionId(process.cwd()) : resumeArg
      if (!resumeSid) {
        console.error(`  ${c.boldRed("error")} no saved sessions found to --resume last`)
        process.exit(1)
      }
      const loaded = loadSession(resumeSid)
      initialMessages = loaded.messages
      const turns = initialMessages.length
      const droppedNote = loaded.dropped.length > 0 ? ` ${c.dim(`(dropped ${loaded.dropped.length} corrupt line(s))`)}` : ""
      const repairNote = loaded.repaired ? ` ${c.dim("(repaired trailing turn)")}` : ""
      resumeBanner = `resume ${c.cyan(resumeSid)} ${c.dim(`(${turns} message(s))`)}${repairNote}${droppedNote}`
      printStartupRow("resume", resumeBanner)
      // Hash drift: compute below once we have system+tools.
    } catch (err) {
      console.error(
        `  ${c.boldRed("error")} could not resume session ${resumeArg}: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    }
  }
  closeStartupTree()

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
  const { buildSystemPrompt } = await import("./headers.ts")
  const systemForHash = sessionContextForHash
    ? JSON.stringify(buildSystemPrompt({ sessionContext: sessionContextForHash }))
    : ""
  const allToolsForHash = (hasPlugins ? loader : null)
    ? [...TOOL_DEFINITIONS, ...(loader.getExtraTools() as typeof TOOL_DEFINITIONS)]
    : [...TOOL_DEFINITIONS]
  const toolsForHash = JSON.stringify(
    allToolsForHash.map((t) => ({ name: t.name, description: t.description, schema: t.input_schema })),
  )
  const systemHash = shortHash(systemForHash)
  const toolsHash = shortHash(toolsForHash)

  // Open the session store. New session: open(sid). Resume: existsOk:true
  // so subsequent appends go to the existing file. Resume drift check
  // emits a one-line yellow warning when system/tools have changed.
  const sid = resumeSid ?? getSessionId()
  let store: SessionStore | null = null
  try {
    store = SessionStore.open({
      sid,
      model: selectedModel,
      cwd: process.cwd(),
      systemHash,
      toolsHash,
      agentVersion: VERSION,
      argv: process.argv,
      existsOk: !!resumeSid,
    })
  } catch (err) {
    // Persistence is best-effort; never block startup on it. The agent
    // will work without a store (just no resume for THIS session).
    console.error(
      `  ${c.boldYellow("warn")} session store unavailable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (resumeSid) {
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

  const agent = new Agent({
    auth,
    model: selectedModel,
    effort,
    loader: hasPlugins ? loader : null,
    modeManager,
    store,
    initialMessages,
  })

  // Replay prior conversation to scrollback when resuming. We write
  // straight to stdout BEFORE the live-area compositor mounts, so the
  // history lands in normal terminal scrollback and the pinned editor
  // appears underneath it. For non-interactive (`--prompt`) mode we skip
  // the replay — the user just wants the next reply, not the history.
  if (resumeSid && initialMessages.length > 0 && !args.includes("--prompt")) {
    const stdoutSink = { write: (s: string) => process.stdout.write(s) }
    stdoutSink.write(
      buildResumeHeader({
        sid: resumeSid,
        turns: initialMessages.length,
        model: selectedModel,
      }),
    )
    replayToScrollback(initialMessages, stdoutSink)
    stdoutSink.write("\n")
  }

  // Non-interactive mode: send prompt, print response, exit
  const prompt = await extractPrompt()
  if (prompt) {
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
    })
    const interceptor = new StdioInterceptor(compositor)
    interceptorRef = interceptor

    const continuationPrompt = process.env.MINIMAL_AGENT_CONTINUATION_PROMPT ?? "  "
    const editor = new EditorController({
      prompt: `${c.bold(c.pink("❯"))} `,
      continuationPrompt,
      compositor,
      maxLiveHeight: () => Math.max(2, Math.floor((process.stdout.rows ?? 24) / 2)),
    })
    const onResize = () => {
      compositor.notifyResize()
      editor.notifyResize()
    }
    process.stdout.on("resize", onResize)

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
