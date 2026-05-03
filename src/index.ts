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

import { join } from "node:path"
import { Agent, c, runRepl } from "./agent.ts"
import { normalizeArgs } from "./cli-args.ts"
import { getAuth } from "./auth.ts"
import { configPath, loadUserConfig } from "./config.ts"
import { catRows, DEFAULT_CAT } from "./cats.ts"
import { displayWidth } from "./term-width.ts"
import { checkQuota, listModels } from "./client.ts"
import { Formatter, parseFormatterCommand } from "./formatter.ts"
import { resolveFormatter } from "./auto-formatter.ts"
import { BETA_FLAGS_DETAILED, DEFAULT_MODEL, VERSION } from "./headers.ts"
import { getSessionId } from "./metadata.ts"
import { ModeManager } from "./modes.ts"
import { AutoAskController } from "./auto-ask.ts"
import { buildResumeHeader, replayToScrollback } from "./session-replay.ts"
import { loadSession, firstUserPromptSnippet } from "./session-restore.ts"
import { formatSessionAsMarkdown, formatSessionAsXml } from "./session-dump.ts"
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
import { BREATHING_DOT } from "./spinner/library/frames.ts"
import { ANSI_PALETTE_RAINBOW } from "./spinner/library/palettes.ts"
import type { StatusSpinnerTheme } from "./status.ts"
import { TOOL_DEFINITIONS } from "./tools.ts"

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = normalizeArgs(process.argv.slice(2))

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
const model =
  modelIdx !== -1 && args[modelIdx + 1]
    ? args[modelIdx + 1]
    : undefined // config.model applied later (after loadUserConfig is called)

const wantListModels = args.includes("--list-models")
const wantListFlags = args.includes("--list-flags")
const wantListSpinners = args.includes("--list-spinners")

const spinnerIdx = args.indexOf("--spinner")
// Global user config (~/.minimal-agent/config.json). Lowest precedence:
// CLI flag > env var > config file > built-in default.
const userConfig = loadUserConfig()

const spinnerName =
  spinnerIdx !== -1 && args[spinnerIdx + 1]
    ? args[spinnerIdx + 1]
    : (process.env.MINIMAL_AGENT_SPINNER ?? userConfig.spinner)

const effortIdx = args.indexOf("--effort")
const effort: "high" | "medium" | "low" | "max" | undefined =
  effortIdx !== -1 && args[effortIdx + 1]
    ? (args[effortIdx + 1] as "high" | "medium" | "low" | "max")
    : userConfig.effort

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

const formatterExplicitIdx = args.indexOf("--formatter")
const formatterExplicitArg: string[] | undefined =
  formatterExplicitIdx !== -1 && args[formatterExplicitIdx + 1]
    ? parseFormatterCommand(args[formatterExplicitIdx + 1])
    : undefined

// --resume <sid>  resume a saved session (or "last" for the most recent
// session in this cwd, falling back to the global most-recent).
// --sessions       list saved sessions and exit.
const resumeIdx = args.indexOf("--resume")
const resumeArg = resumeIdx !== -1 && args[resumeIdx + 1] ? args[resumeIdx + 1] : undefined
const wantListSessions = args.includes("--sessions")

const dumpIdx = args.indexOf("--dump")
const dumpArg = dumpIdx !== -1 && args[dumpIdx + 1] ? args[dumpIdx + 1] : undefined
const dumpFormatIdx = args.indexOf("--dump-format")
const dumpFormatArg = dumpFormatIdx !== -1 && args[dumpFormatIdx + 1] ? args[dumpFormatIdx + 1] : "md"

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
    `    ${c.cyan("-e")}, ${c.cyan("--effort")} ${c.dim("<level>")}    Reasoning effort: low, medium, high, max`,
    `    ${c.cyan("--thinking-display")} ${c.dim("<mode>")}  Force thinking display: summarized or omitted ${c.dim("(or MINIMAL_AGENT_THINKING_DISPLAY)")}`,
    `    ${c.cyan("-f")}, ${c.cyan("--formatter")} ${c.dim("<cmd>")}   Pipe output through formatter ${c.dim("(default: mdstream)")}`,
    `    ${c.cyan("-s")}, ${c.cyan("--spinner")} ${c.dim("<preset>")}  Pick a status spinner preset ${c.dim("(see --list-spinners)")}`,
    `    ${c.cyan("-p")}, ${c.cyan("--prompt")} ${c.dim("<text>")}     Non-interactive: send prompt, print, exit`,
    `    ${c.cyan("-d")}, ${c.cyan("--debug")}             Enable debug logging ${c.dim("(or DEBUG=1)")}`,
    `    ${c.cyan("-v")}, ${c.cyan("--verbose")}           Don't truncate debug output ${c.dim("(or VERBOSE=1)")}`,
    `    ${c.cyan("--skip-quota")}            Skip startup quota check`,
    `    ${c.cyan("--show-hidden-chars")}      Reveal spaces/tabs/newlines as faint glyphs (input editor + --debug output)`,
    "",
    `  ${c.bold("Info")} ${c.dim("(also as subcommands: `models [list]`, `flags [list]`, ...)")}`,
    `    ${c.cyan("--list-models")} ${c.dim("/")} ${c.cyan("--models")}       Fetch and display available models`,
    `    ${c.cyan("--list-flags")} ${c.dim("/")} ${c.cyan("--flags")}         Show beta feature flags`,
    `    ${c.cyan("--list-spinners")} ${c.dim("/")} ${c.cyan("--spinners")}   Show available spinner presets`,
    `    ${c.cyan("--sessions")}                  List saved sessions ${c.dim("(~/.minimal-agent/sessions/)")}`,
    `    ${c.cyan("-r")}, ${c.cyan("--resume")} ${c.dim("<sid|last>")}     Resume a saved session`,
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
    `    ${c.cyan("MINIMAL_AGENT_THINKING_DISPLAY")}  Force thinking display ${c.dim("(summarized | omitted)")}`,
    `    ${c.cyan("MINIMAL_AGENT_CONFIG")}     Override config path ${c.dim("(default: ~/.minimal-agent/config.jsonc)")}`,
    `    ${c.cyan("MINIMAL_AGENT_THEME")}      UI theme: ${c.dim("dark | light | high-contrast")}`,
    `    ${c.cyan("MINIMAL_AGENT_NO_LIVE_AREA=1")}  Disable live-area REPL (fall back to legacy raw input)`,
    `    ${c.cyan("MINIMAL_AGENT_CONTINUATION_PROMPT")}  Override continuation-prompt prefix ${c.dim('(default: "  ")')}`,
    `    ${c.cyan("MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1")}  Show spaces/tabs/newlines as faint glyphs in the editor`,
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

let lastStartupRow: { label: string; value: string } | null = null

function printStartupRow(label: string, value: string): void {
  console.error(`  ${c.faintWhite("│")} ${c.sky(label.padEnd(9))}  ${value}`)
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
function startStartupRowSpinner(label: string, checking: string): {
  ok(value: string): void
  fail(value: string): void
} {
  const PIPE = `  ${c.faintWhite("│")} `
  const prefix = `${PIPE}${c.sky(label.padEnd(9))}  `

  // Non-TTY: no cursor tricks — just print the row when settled.
  if (!process.stderr.isTTY) {
    return {
      ok(value) {
        console.error(`${prefix}${value}`)
        lastStartupRow = { label, value }
      },
      fail(value) {
        console.error(`${prefix}${value}`)
        lastStartupRow = { label, value }
      },
    }
  }

  let frameIdx = 0
  let colorIdx = 0

  function coloredDot(): string {
    const char = BREATHING_DOT[frameIdx] ?? "·"
    return (ANSI_PALETTE_RAINBOW[colorIdx % ANSI_PALETTE_RAINBOW.length]!)(char)
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
    process.stderr.write(`\r\x1b[2K${prefix}${value}\n`)
    lastStartupRow = { label, value }
  }

  return {
    ok: settle,
    fail: settle,
  }
}

/**
 * Format the parsed rate-limit headers from a successful quota check into a
 * compact, single-line summary appended after `ok ✔`.
 *
 * Style: minimalist, mid-dot separated. Window names are normal weight,
 * percentages are color-graded (green/yellow/red) by utilization, the soonest
 * reset is shown faint. Returns "" when there's nothing useful to show
 * (e.g. test fakes without rate-limit headers).
 */
function formatQuotaSummary(rl: Map<string, string>): string {
  if (rl.size === 0) return ""

  type Win = { util?: number; status?: string; reset?: number }
  const windows = new Map<string, Win>()
  // Two header shapes:
  //   anthropic-ratelimit-unified-<window>-<field>   (e.g. 5h, 7d, overage)
  //   anthropic-ratelimit-unified-<field>            (aggregate, no window)
  // We map the aggregate form to the synthetic key "overall" so it sorts and
  // renders alongside the windowed entries.
  const FIELDS = new Set(["utilization", "status", "reset"])
  for (const [k, v] of rl) {
    let win: string | null = null
    let field: string | null = null
    const mw = k.match(/^anthropic-ratelimit-unified-([\w]+)-(\w+)$/)
    if (mw) {
      win = mw[1]!
      field = mw[2]!
    } else {
      const ma = k.match(/^anthropic-ratelimit-unified-(\w+)$/)
      if (ma && FIELDS.has(ma[1]!)) {
        win = "overall"
        field = ma[1]!
      }
    }
    if (!win || !field) continue
    if (!windows.has(win)) windows.set(win, {})
    const w = windows.get(win)!
    if (field === "utilization") w.util = Number(v)
    else if (field === "status") w.status = v
    else if (field === "reset") w.reset = Number(v) * 1000
  }

  const colorPct = (util: number): string => {
    const pct = util * 100
    // Round so 0.099 doesn't render as "9.9%". We show integers for
    // compactness — sub-percent precision isn't useful at a glance.
    const txt = `${Math.round(pct)}%`
    if (pct >= 85) return c.red(txt)
    if (pct >= 60) return c.yellow(txt)
    return c.green(txt)
  }

  const humanReset = (resetAt: number): string | null => {
    const diffMs = resetAt - Date.now()
    if (diffMs <= 0) return null
    const totalMins = Math.floor(diffMs / 60_000)
    const days = Math.floor(totalMins / (60 * 24))
    const hrs = Math.floor((totalMins % (60 * 24)) / 60)
    const mins = totalMins % 60
    if (days > 0) return hrs > 0 ? `${days}d${hrs}h` : `${days}d`
    if (hrs > 0) return `${hrs}h${mins}m`
    return `${mins}m`
  }

  const parts: string[] = []
  // Stable, narrow→wide order: 5h, 7d, overall (aggregate). Anything else
  // sorts after, alphabetical.
  const order = (w: string): number =>
    w === "5h" ? 0 : w === "7d" ? 1 : w === "overall" ? 2 : 3
  const winEntries = [...windows.entries()]
    .filter(([w]) => w !== "overage" && w !== "fallback" && w !== "representative")
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))

  for (const [name, info] of winEntries) {
    if (info.util == null) continue
    let segment = `${c.faintWhite(name)} ${colorPct(info.util)}`
    if (info.reset) {
      const human = humanReset(info.reset)
      if (human) segment += ` ${c.dim("↻")} ${c.dim(human)}`
    }
    parts.push(segment)
  }

  // Overage status — only surface when explicitly disabled (the common case
  // is "allowed" and noise-free is better here).
  const ov = rl.get("anthropic-ratelimit-unified-overage-status")
  if (ov && ov !== "allowed") {
    parts.push(`${c.faintWhite("overage")} ${c.red("off")}`)
  }

  if (parts.length === 0) return ""
  const sep = c.dim(" · ")
  return `  ${parts.join(sep)}`
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
  const flagsWithValues = new Set([
    "--model",
    "--prompt",
    "--formatter",
    "--effort",
    "--spinner",
    "--thinking-display",
  ])
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
    "--show-hidden-chars",
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

  // Resolve formatter: explicit --formatter, PATH, cached binary, or auto-download.
  const formatterResolution = await resolveFormatter(formatterExplicitArg)
  let formatterCmd: string[] | undefined
  if (formatterResolution.cmd) {
    formatterCmd = formatterResolution.cmd
    printStartupRow("formatter", c.dim(formatterResolution.label))
  } else {
    formatterCmd = undefined
    console.error(`  ${c.boldYellow("warn")} ${formatterResolution.warn}`)
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
  const effortLabel = isHaiku
    ? c.dim("off")
    : effort
      ? `${effort} ${c.dim(userConfig.effort === effort && effortIdx === -1 ? "(config)" : "(--effort)")}`
      : `medium ${c.dim("(default)")}`
  printStartupRow("thinking", thinkingLabel)
  printStartupRow("effort", effortLabel)

  // Quota check — verify account has quota before starting conversation
  // Matches v2.1.91 behavior: cheap haiku request with max_tokens=1
  if (!args.includes("--skip-quota")) {
    const quotaSpinner = startStartupRowSpinner("quota", c.dim("checking..."))
    const result = await checkQuota(auth)
    if (!result.ok) {
      quotaSpinner.fail(`${c.boldRed("failed")} \x1b[1;31m✗\x1b[22;39m`)
      console.error(
        `  ${c.boldRed("error")} quota check failed. Account may not have quota or token is invalid.`,
      )
      process.exit(1)
    }
    quotaSpinner.ok(`${c.boldGreen("ok")} ${c.boldGreen("✔")}${formatQuotaSummary(result.rateLimits)}`)
  }

  // --dump <sid|last>: output full session to stdout and exit
  if (dumpArg) {
    closeStartupTree()
    try {
      const dumpSid = dumpArg === "last" ? resolveLastSessionId(process.cwd()) : dumpArg
      if (!dumpSid) {
        console.error(`  ${c.boldRed("error")} no saved sessions found to dump`)
        process.exit(1)
      }
      const loaded = loadSession(dumpSid)
      if (dumpFormatArg === "xml") {
        process.stdout.write(formatSessionAsXml(loaded))
      } else {
        process.stdout.write(formatSessionAsMarkdown(loaded))
      }
    } catch (err) {
      console.error(
        `  ${c.boldRed("error")} could not dump session ${dumpArg}: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    }
    return
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
    printStartupRow("plugins", bits.join(" · "))
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
    thinkingDisplay,
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
    const { detectSynchronizedOutput } = await import("./ui/term-caps.ts")

    // Probe the terminal for DEC mode 2026 (synchronized output) BEFORE
    // creating the editor. Detection puts stdin into raw mode briefly,
    // sends a DECRPM query, and parses the reply. If the terminal supports
    // it, the Compositor wraps each redraw batch in BSU/ESU so the user
    // sees a single atomic frame instead of erase→write→redraw flicker.
    // Any typeahead bytes that arrived during the probe are saved and
    // re-emitted to the editor below so a fast-typing user doesn't lose
    // a keystroke. Disabled (and detection is skipped) when MINIMAL_AGENT_NO_SYNC=1.
    const syncProbe = process.env.MINIMAL_AGENT_NO_SYNC === "1"
      ? { syncOutput: false, unparsed: "" }
      : await detectSynchronizedOutput(process.stdin as any, process.stdout as any)

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
    })
    // Keep show-hidden in sync with mode changes: a mode with
    // `editorShowHidden: true` overrides the env-var/flag baseline.
    if (modeManager) {
      const showHiddenBase =
        process.env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS === "1" ||
        args.includes("--show-hidden-chars")
      modeManager.subscribe((_active) => {
        editor.setShowHidden(showHiddenBase || (modeManager.editorShowHidden() ?? false))
      })
    }
    const onResize = () => {
      compositor.notifyResize()
      editor.notifyResize()
    }
    process.stdout.on("resize", onResize)

    // Auto-ASK: silently flip into ASK mode when the editor buffer reads
    // like a question, revert on action verbs, never override a manual
    // Shift+Tab. Opt-out via `MINIMAL_AGENT_AUTO_ASK=0` or `autoAsk:false`
    // in the user config. Only wires up when an "ask" mode actually
    // exists in the active manifest set (otherwise: dead code).
    let autoAsk: AutoAskController | null = null
    if (modeManager && modeManager.list().some((m) => m.id === "ask")) {
      const envOff = process.env.MINIMAL_AGENT_AUTO_ASK === "0"
      const cfgOff = userConfig.autoAsk === false
      if (!envOff && !cfgOff) {
        autoAsk = new AutoAskController(editor, modeManager, {
          logger: process.env.DEBUG === "1"
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
        initialStdinBytes: syncProbe.unparsed,
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
