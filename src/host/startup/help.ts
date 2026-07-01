/**
 * `--help` text + embedded-package-version helper for the CLI entry
 * point.
 *
 * Split out of `src/index.ts` to keep that file under the `max-lines`
 * lint budget. Pure presentation + read-only fs, no startup state.
 *
 * @module startup/help
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { AGENT_VERSION } from "../../build-info.ts"
import { type CommandOutput, writeCommandRows } from "../ui/command-output.ts"
import { type HelpSection, renderHelpSections } from "../ui/help/render.ts"
import { c } from "../ui/style/ansi.ts"

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

/** Render the full `--help` usage text without writing to stdout. */
export function renderHelp(): string[] {
  return [
    `  ${c.bold("minimal-agent")} ${c.dim(`v${AGENT_VERSION}`)}`,
    `  ${c.faintWhite(c.italic("by Gaston Morixe"))} ${c.faintWhite("·")} ${c.faintWhite(c.italic("github.com/gastonmorixe/minimal-agent"))}`,
    "",
    `  ${c.bold("Usage")}`,
    `    ${c.dim("$")} minimal-agent ${c.dim("[options]")}`,
    `    ${c.dim("$")} minimal-agent ${c.dim('"prompt text"')}`,
    `    ${c.dim("$")} echo "prompt" | minimal-agent ${c.dim("-")}`,
    "",
    ...renderHelpSections(buildHelpSections()),
  ]
}

/** Print the full `--help` usage text to stdout. */
export function printHelp(output: CommandOutput = process.stdout): void {
  writeCommandRows(renderHelp(), output)
}

function buildHelpSections(): HelpSection[] {
  return [
    {
      title: c.bold("Options"),
      rows: [
        row(`${c.cyan("-m")}, ${c.cyan("--model")} ${c.dim("<id>")}`, "Select model", [
          "requires --provider, else MINIMAL_AGENT_MODEL, config model",
        ]),
        row(`${c.cyan("--provider")} ${c.dim("<id>")}`, "Select provider for --model", [
          "else MINIMAL_AGENT_PROVIDER, config provider",
        ]),
        row(
          `${c.cyan("-e")}, ${c.cyan("--effort")} ${c.dim("<level>")}`,
          "Reasoning effort: low, medium, high, xhigh, max",
          ["or MINIMAL_AGENT_EFFORT"],
        ),
        row(c.cyan("--fast"), "Fast-mode dispatch", [
          'speed:"fast", fast-capable models only, ~2.5x tok/s, ~2x cost, or MINIMAL_AGENT_FAST=1',
        ]),
        row(
          `${c.cyan("--thinking-display")} ${c.dim("<mode>")}`,
          "Force thinking display: summarized or omitted",
          ["or MINIMAL_AGENT_THINKING_DISPLAY"],
        ),
        row(`${c.cyan("--cache-ttl")} ${c.dim("<5m|1h>")}`, "Prompt-cache breakpoint TTL", [
          "default: 5m, or MINIMAL_AGENT_CACHE_TTL, config cacheTtl",
        ]),
        row(
          `${c.cyan("-f")}, ${c.cyan("--formatter")} ${c.dim("<cmd>")}`,
          "Pipe output through formatter",
          ["default: mdstream"],
        ),
        row(
          `${c.cyan("--formatter-args")} ${c.dim("<args>")}`,
          "Extra args appended to the formatter",
          ['e.g. "--table-fit", or MINIMAL_AGENT_FORMATTER_ARGS'],
        ),
        row(
          `${c.cyan("-s")}, ${c.cyan("--spinner")} ${c.dim("<preset>")}`,
          "Pick a status spinner preset",
          ["see --list-spinners"],
        ),
        row(
          `${c.cyan("-p")}, ${c.cyan("--prompt")} ${c.dim("<text>")}`,
          "Non-interactive: send prompt, print, exit",
        ),
        row(c.cyan("--json"), "Non-interactive: emit the final answer as JSONL", [
          "final-answer JSONL, not a structured event stream",
        ]),
        row(
          `${c.cyan("--output-schema")} ${c.dim("<file>")}`,
          "Constrain the final answer to a JSON Schema",
          [
            "run exits non-zero if the answer is absent or non-conforming",
            "enforces a SUBSET: type, required, properties,",
            "additionalProperties, items, enum (deep-equal)",
            "accepted but NOT enforced: minimum/maxLength/pattern/",
            "anyOf/oneOf/allOf/not/$ref/format/const, don't rely on them",
          ],
        ),
        row(`${c.cyan("--mode")} ${c.dim("<id|none>")}`, "Initial mode", [
          "default: ask in non-interactive, plugin default otherwise",
        ]),
        row(`${c.cyan("--disable-plugin")} ${c.dim("<id>")}`, "Skip a plugin for this run", [
          "repeatable, comma-separated ok, see plugins list",
        ]),
        row(`${c.cyan("--enable-plugin")} ${c.dim("<id>")}`, "Force-enable a plugin for this run", [
          "overrides config + manifest opt-out",
        ]),
        row(
          `${c.cyan("--header")} ${c.dim("/")} ${c.cyan("--no-header")}`,
          "Force startup tree on/off",
          ["default: hidden in non-interactive"],
        ),
        row(`${c.cyan("--session-id")} ${c.dim("<uuid>")}`, "Pin this run's session id", [
          "else MINIMAL_AGENT_SESSION_ID, else random",
        ]),
        row(`${c.cyan("-d")}, ${c.cyan("--debug")}`, "Enable debug logging", ["or DEBUG=1"]),
        row(`${c.cyan("-v")}, ${c.cyan("--verbose")}`, "Don't truncate debug output", [
          "or VERBOSE=1",
        ]),
        row(c.cyan("--skip-quota"), "Skip startup quota check", ["or MINIMAL_AGENT_SKIP_QUOTA=1"]),
        row(c.cyan("--show-hidden-chars"), "Reveal spaces/tabs/newlines as faint glyphs"),
      ],
    },
    {
      title: c.bold("Auth"),
      note: c.dim("(provider-owned auth flows, flags remain legacy aliases)"),
      rows: [
        row(
          `${c.cyan("provider")} ${c.dim("<id>")} ${c.cyan("login")} ${c.dim("[method]")}`,
          "Sign in to a provider",
          ["provider <id> login oauth"],
        ),
        row(`${c.cyan("login")} ${c.dim("<id> [method]")}`, "Short alias for provider login", [
          "method: oauth | api-key",
        ]),
        row(c.cyan("--logout"), "Clear minimal-agent credentials", ["~/.minimal-agent/auth.jsonc"]),
        row(c.cyan("--auth-status"), "Show login status, account, scopes, expiry"),
      ],
    },
    {
      title: c.bold("Info"),
      note: c.dim("(also as subcommands: `models [list]`, `plugins [list]`, `flags [list]`, ...)"),
      rows: [
        row(c.cyan("providers"), "List registered providers", ["id · surfaces"]),
        row(
          `${c.cyan("providers models")} ${c.dim("[<id>]")}`,
          "List models, optionally one provider",
          ["alias: --list-models"],
        ),
        row(
          `${c.cyan("plugins")} ${c.dim("[list]")}`,
          "List installed plugins and effective on/off state",
          ["alias: --list-plugins / --plugins"],
        ),
        row(
          `${c.cyan("--list-flags")} ${c.dim("/")} ${c.cyan("--flags")}`,
          "Show beta feature flags",
        ),
        row(
          `${c.cyan("--list-spinners")} ${c.dim("/")} ${c.cyan("--spinners")}`,
          "Show available spinner presets",
        ),
        row(`${c.cyan("--sessions")} ${c.dim("[<query>]")}`, "List saved sessions", [
          "fuzzy filter on date/sid/cwd",
        ]),
        row(`${c.cyan("usage")} ${c.dim("[<period>]")}`, "Token-usage stats", [
          "today|last-day|last-month|ytd|year|all, interactive on a TTY",
        ]),
        row(
          `${c.cyan("-r")}, ${c.cyan("--resume")} ${c.dim("<sid|last>")}`,
          "Resume a saved session",
          ["`sessions resume <sid>`"],
        ),
        row(
          `${c.cyan("--resume-same-sid")} ${c.dim("<sid|last>")}`,
          "Resume in place, keeping the same session id",
          ["no fork, appends to the existing log", "`resume-same <sid>`"],
        ),
        row(`${c.cyan("--dump")} ${c.dim("<sid|last>")}`, "Dump a full session history to stdout"),
        row(`${c.cyan("--dump-format")} ${c.dim("<md|xml>")}`, "Output format for --dump", [
          "default: md",
        ]),
        row(`${c.cyan("-h")}, ${c.cyan("--help")}`, "Show this help"),
      ],
    },
    {
      title: c.bold("Env"),
      rows: [
        row(c.cyan("DEBUG=1"), "Verbose request/response logging to stderr"),
        row(c.cyan("MINIMAL_AGENT_TRANSPORT"), "Transport: http2 or fetch", ["default: http2"]),
        row(
          c.cyan("MINIMAL_AGENT_ALLOW_FETCH_FALLBACK=1"),
          "Allow fetch fallback after HTTP/2 failure",
        ),
        row(
          c.cyan("MINIMAL_AGENT_NET_DBG=1"),
          "Mirror raw HTTP req/res to ~/.minimal-agent/net-dbg/",
        ),
        row(c.cyan("CLAUDE_CODE_EXTRA_METADATA"), "JSON object merged into metadata.user_id"),
        row(c.cyan("MINIMAL_AGENT_SPINNER"), "Spinner preset id", ["same values as --spinner"]),
        row(c.cyan("MINIMAL_AGENT_EFFORT"), "Reasoning effort", [
          "low | medium | high | xhigh | max",
        ]),
        row(c.cyan("MINIMAL_AGENT_FAST=1"), "Opt into fast-mode dispatch", [
          "fast-capable models only",
        ]),
        row(c.cyan("MINIMAL_AGENT_THINKING_DISPLAY"), "Force thinking display", [
          "summarized | omitted",
        ]),
        row(c.cyan("MINIMAL_AGENT_FORMATTER_ARGS"), "Extra args for the formatter", [
          'shell-style, e.g. "--table-fit"',
        ]),
        row(c.cyan("MINIMAL_AGENT_CONFIG"), "Override config path", [
          "default: ~/.minimal-agent/config.jsonc",
        ]),
        row(c.cyan("MINIMAL_AGENT_MODEL"), "Default model id", ["same as --model"]),
        row(c.cyan("MINIMAL_AGENT_PROVIDER"), "Default provider id", ["same as --provider"]),
        row(
          c.cyan("MINIMAL_AGENT_MEMORY_NAMESPACE"),
          "Namespace memory paths under namespaces/<ns>/",
          ["memory plugin"],
        ),
        row(c.cyan("MINIMAL_AGENT_THEME"), "UI theme", ["dark | light | high-contrast"]),
        row(c.cyan("MINIMAL_AGENT_NO_LIVE_AREA=1"), "Disable live-area REPL", [
          "fall back to legacy raw input",
        ]),
        row(c.cyan("MINIMAL_AGENT_HEADER"), "Force startup tree", [
          "0|1, default hidden in non-interactive",
        ]),
        row(c.cyan("MINIMAL_AGENT_MODE"), "Initial mode id", ['or "none" to disable']),
        row(c.cyan("MINIMAL_AGENT_CONTINUATION_PROMPT"), "Override continuation-prompt prefix", [
          'default: "  "',
        ]),
        row(
          c.cyan("MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1"),
          "Show spaces/tabs/newlines as faint glyphs",
        ),
        row(c.cyan("MINIMAL_AGENT_SKIP_QUOTA=1"), "Skip startup quota check"),
        row(c.cyan("MINIMAL_AGENT_NO_PLUGIN_SYNC=1"), "Skip the first-run extended-plugins clone"),
        row(
          c.cyan("MINIMAL_AGENT_DISABLE_PLUGINS"),
          "Comma-separated plugin ids to skip this run",
          ["same as --disable-plugin"],
        ),
        row(
          c.cyan("MINIMAL_AGENT_ENABLE_PLUGINS"),
          "Comma-separated plugin ids to force on this run",
          ["same as --enable-plugin"],
        ),
        row(c.cyan("MINIMAL_AGENT_PLUGINS_REPO"), "Git URL for the extended plugins repo", [
          "fork/mirror",
        ]),
        row(c.cyan("MINIMAL_AGENT_GITHUB_TOKEN"), "Token to clone a private plugins repo", [
          "else GITHUB_TOKEN / GH_TOKEN / gh",
        ]),
        row(c.cyan("MINIMAL_AGENT_NO_HISTORY=1"), "Disable prompt history", ["history plugin"]),
        row(c.cyan("MINIMAL_AGENT_FILE_LOCK_DISABLED=1"), "Disable cooperative file locking", [
          "file-lock plugin",
        ]),
        row(c.cyan("MINIMAL_AGENT_SUBAGENT_MODEL"), "Force a model for spawned workers", [
          "else inherit your model",
        ]),
        row(c.cyan("MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1"), "Let specialists pick a per-role model", [
          "default off",
        ]),
        row(c.cyan("NERD_FONT=1"), "Enable Nerd Font glyphs in TUI"),
      ],
    },
    {
      title: c.bold("Plugins"),
      note: c.dim("(enable/disable precedence: CLI → env → config → manifest)"),
      rows: [
        row(c.dim("List"), c.dim("minimal-agent plugins list")),
        row(c.dim("One-shot disable"), c.dim('minimal-agent --disable-plugin web-search -p "…"')),
        row(c.dim("Disable many"), c.dim("minimal-agent --disable-plugin web-search,memory")),
        row(c.dim("One-shot enable"), c.dim("minimal-agent --enable-plugin interleave-thinking")),
        row(c.dim("Persistent"), c.dim('{ "plugins": { "<id>": { "enabled": false } } }')),
        row(c.dim("Opt in"), c.dim('{ "plugins": { "<id>": { "enabled": true } } }'), [
          "for plugins shipped disabled",
        ]),
        row(c.dim("Built-in"), c.dim("ask-mode, config, diff-view, env-info, file-lock,")),
        row("", c.dim("history, memory, model-info, quota-status, schedule,")),
        row("", c.dim("session-info, sub-agents, tasks, usage, web-search")),
        row(c.dim("Disabled"), `interleave-thinking ${c.dim("(opt in to use, see Opt in above)")}`),
      ],
    },
    {
      title: c.bold("Docs"),
      rows: [
        row(c.dim("docs/CHANGELOG.md"), "Release notes, newest first"),
        row(c.dim("docs/tui/"), "Terminal renderer architecture (compositor, live area, editor)"),
        row(c.dim("docs/network/"), "HTTP transport, retry, and wire-capture notes"),
        row(c.dim("docs/sub-agents-prompt.md"), "How the sub-agents system prompt composes"),
        row(c.dim("docs/changes/"), "Per-change write-ups, dated"),
      ],
    },
  ]
}

function row(
  term: string,
  summary: string,
  notes: string[] = [],
): { term: string; summary: string } {
  return {
    term,
    summary: notes.length > 0 ? `${summary} ${c.dim(`(${notes.join(", ")})`)}` : summary,
  }
}
