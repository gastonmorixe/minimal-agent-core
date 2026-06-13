/**
 * `--help` text + embedded-package-version helper for the CLI entry
 * point.
 *
 * Split out of `src/index.ts` to keep that file under the `max-lines`
 * lint budget. Pure presentation + read-only fs; no startup state.
 *
 * @module startup/help
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { c } from "../agent/ansi.ts"
import { VERSION } from "../headers.ts"

/**
 * Read the agent's semver from the embedded `<repo>/package.json` next
 * to the source tree. Returns `"0.0.0"` on any failure (missing file,
 * malformed JSON, missing `version` field) so the AgentContext factory
 * never throws on a dev tree with a broken manifest. Called once at boot.
 */
export function readEmbeddedPackageVersion(embeddedDir: string): string {
  try {
    const raw = readFileSync(join(embeddedDir, "package.json"), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version
    }
  } catch {
    // Best-effort. Fall through to default below.
  }
  return "0.0.0"
}

/** Print the full `--help` usage text to stdout. */
export function printHelp(): void {
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
    `    ${c.cyan("-m")}, ${c.cyan("--model")} ${c.dim("<id>")}        Select model ${c.dim("(else MINIMAL_AGENT_MODEL, config model, provider default)")}`,
    `    ${c.cyan("-e")}, ${c.cyan("--effort")} ${c.dim("<level>")}    Reasoning effort: low, medium, high, xhigh, max ${c.dim("(or MINIMAL_AGENT_EFFORT)")}`,
    `    ${c.cyan("--fast")}                    Fast-mode dispatch ${c.dim('(speed:"fast", fast-capable models only, ~2.5x tok/s, ~2x cost, or MINIMAL_AGENT_FAST=1)')}`,
    `    ${c.cyan("--thinking-display")} ${c.dim("<mode>")}  Force thinking display: summarized or omitted ${c.dim("(or MINIMAL_AGENT_THINKING_DISPLAY)")}`,
    `    ${c.cyan("-f")}, ${c.cyan("--formatter")} ${c.dim("<cmd>")}   Pipe output through formatter ${c.dim("(default: mdstream)")}`,
    `    ${c.cyan("--formatter-args")} ${c.dim("<args>")}   Extra args appended to the formatter ${c.dim('(e.g. "--table-fit", or MINIMAL_AGENT_FORMATTER_ARGS)')}`,
    `    ${c.cyan("-s")}, ${c.cyan("--spinner")} ${c.dim("<preset>")}  Pick a status spinner preset ${c.dim("(see --list-spinners)")}`,
    `    ${c.cyan("-p")}, ${c.cyan("--prompt")} ${c.dim("<text>")}     Non-interactive: send prompt, print, exit`,
    `    ${c.cyan("--mode")} ${c.dim("<id|none>")}         Initial mode ${c.dim("(default: ask in non-interactive, plugin default otherwise)")}`,
    `    ${c.cyan("--header")} ${c.dim("/")} ${c.cyan("--no-header")}      Force startup tree on/off ${c.dim("(default: hidden in non-interactive)")}`,
    `    ${c.cyan("--session-id")} ${c.dim("<uuid>")}      Pin this run's session id ${c.dim("(else MINIMAL_AGENT_SESSION_ID, else random)")}`,
    `    ${c.cyan("-d")}, ${c.cyan("--debug")}             Enable debug logging ${c.dim("(or DEBUG=1)")}`,
    `    ${c.cyan("-v")}, ${c.cyan("--verbose")}           Don't truncate debug output ${c.dim("(or VERBOSE=1)")}`,
    `    ${c.cyan("--skip-quota")}            Skip startup quota check ${c.dim("(or MINIMAL_AGENT_SKIP_QUOTA=1)")}`,
    `    ${c.cyan("--show-hidden-chars")}      Reveal spaces/tabs/newlines as faint glyphs (input editor + --debug output)`,
    "",
    `  ${c.bold("Auth")} ${c.dim("(provider-owned auth flows; flags remain legacy aliases)")}`,
    `    ${c.cyan("provider")} ${c.dim("<id>")} ${c.cyan("login")} ${c.dim("[--email <addr>]")}  Sign in to a provider, e.g. ${c.dim("provider openai login")}`,
    `    ${c.cyan("login")} ${c.dim("<id>")} ${c.dim("[--email <addr>]")}      Short alias for provider login`,
    `    ${c.cyan("--logout")}                   Clear minimal-agent credentials ${c.dim("(~/.minimal-agent/auth.jsonc)")}`,
    `    ${c.cyan("--auth-status")}              Show login status, account, scopes, expiry`,
    "",
    `  ${c.bold("Info")} ${c.dim("(also as subcommands: `models [list]`, `flags [list]`, ...)")}`,
    `    ${c.cyan("providers")}                     List registered providers ${c.dim("(id · surfaces)")}`,
    `    ${c.cyan("providers models")} ${c.dim("[<id>]")}      List models, optionally one provider ${c.dim("(alias: --list-models)")}`,
    `    ${c.cyan("--list-flags")} ${c.dim("/")} ${c.cyan("--flags")}         Show beta feature flags`,
    `    ${c.cyan("--list-spinners")} ${c.dim("/")} ${c.cyan("--spinners")}   Show available spinner presets`,
    `    ${c.cyan("--sessions")} ${c.dim("[<query>]")}          List saved sessions ${c.dim("(fuzzy filter on date/sid/cwd)")}`,
    `    ${c.cyan("usage")} ${c.dim("[<period>]")}             Token-usage stats ${c.dim("(today|last-day|last-month|ytd|year|all, interactive on a TTY)")}`,
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
    `    ${c.cyan("MINIMAL_AGENT_FAST=1")}     Opt into fast-mode dispatch ${c.dim("(fast-capable models only)")}`,
    `    ${c.cyan("MINIMAL_AGENT_THINKING_DISPLAY")}  Force thinking display ${c.dim("(summarized | omitted)")}`,
    `    ${c.cyan("MINIMAL_AGENT_FORMATTER_ARGS")}  Extra args for the formatter ${c.dim('(shell-style, e.g. "--table-fit")')}`,
    `    ${c.cyan("MINIMAL_AGENT_CONFIG")}     Override config path ${c.dim("(default: ~/.minimal-agent/config.jsonc)")}`,
    `    ${c.cyan("MINIMAL_AGENT_MODEL")}      Default model id ${c.dim("(same as --model)")}`,
    `    ${c.cyan("MINIMAL_AGENT_MEMORY_NAMESPACE")}  Namespace memory paths under ${c.dim("namespaces/<ns>/")} ${c.dim("(memory plugin)")}`,
    `    ${c.cyan("MINIMAL_AGENT_THEME")}      UI theme: ${c.dim("dark | light | high-contrast")}`,
    `    ${c.cyan("MINIMAL_AGENT_NO_LIVE_AREA=1")}  Disable live-area REPL (fall back to legacy raw input)`,
    `    ${c.cyan("MINIMAL_AGENT_HEADER")}     Force startup tree: ${c.dim("0|1 (default: hidden in non-interactive)")}`,
    `    ${c.cyan("MINIMAL_AGENT_MODE")}       Initial mode id (or ${c.dim('"none"')} to disable)`,
    `    ${c.cyan("MINIMAL_AGENT_CONTINUATION_PROMPT")}  Override continuation-prompt prefix ${c.dim('(default: "  ")')}`,
    `    ${c.cyan("MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1")}  Show spaces/tabs/newlines as faint glyphs in the editor`,
    `    ${c.cyan("MINIMAL_AGENT_SKIP_QUOTA=1")}       Skip startup quota check`,
    `    ${c.cyan("MINIMAL_AGENT_NO_PLUGIN_SYNC=1")}   Skip the first-run extended-plugins clone`,
    `    ${c.cyan("MINIMAL_AGENT_PLUGINS_REPO")}  Git URL for the extended plugins repo ${c.dim("(fork/mirror)")}`,
    `    ${c.cyan("MINIMAL_AGENT_GITHUB_TOKEN")}  Token to clone a ${c.dim("private")} plugins repo ${c.dim("(else GITHUB_TOKEN / GH_TOKEN / gh)")}`,
    `    ${c.cyan("MINIMAL_AGENT_NO_HISTORY=1")}       Disable ↑/↓ prompt history ${c.dim("(history plugin)")}`,
    `    ${c.cyan("MINIMAL_AGENT_FILE_LOCK_DISABLED=1")}  Disable cooperative file locking ${c.dim("(file-lock plugin)")}`,
    `    ${c.cyan("MINIMAL_AGENT_SUBAGENT_MODEL")}  Force a model for spawned workers ${c.dim("(else they inherit your model, sub-agents plugin)")}`,
    `    ${c.cyan("MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1")}  Let specialists pick a per-role model ${c.dim("(cheap scout / flagship deep, default off, workers inherit your model)")}`,
    `    ${c.cyan("NERD_FONT=1")}              Enable Nerd Font glyphs in TUI`,
    "",
    `  ${c.bold("Plugins")} ${c.dim("(toggle via ~/.minimal-agent/config.jsonc)")}`,
    `    ${c.dim("Opt out  :")} ${c.dim('{ "plugins": { "<id>": { "enabled": false } } }')}`,
    `    ${c.dim("Opt in   :")} ${c.dim('{ "plugins": { "<id>": { "enabled": true } } }')}  ${c.dim("(for plugins shipped disabled)")}`,
    "",
    `    ${c.dim("Built-in :")} ask-mode, config, diff-view, env-info, file-lock,`,
    `    ${c.dim("           ")} history, memory, model-info, quota-status, schedule,`,
    `    ${c.dim("           ")} session-info, sub-agents, tasks, usage, web-search`,
    `    ${c.dim("Disabled :")} interleave-thinking ${c.dim("(opt in to use, see Opt in above)")}`,
    "",
    `  ${c.bold("Docs")}`,
    `    ${c.dim("docs/CHANGELOG.md")}          Release notes, newest first`,
    `    ${c.dim("docs/tui/")}                  Terminal renderer architecture (compositor, live area, editor)`,
    `    ${c.dim("docs/network/")}              HTTP transport, retry, and wire-capture notes`,
    `    ${c.dim("docs/sub-agents-prompt.md")}  How the sub-agents system prompt composes`,
    `    ${c.dim("docs/changes/")}              Per-change write-ups, dated`,
  ]
  console.log(lines.join("\n"))
}
