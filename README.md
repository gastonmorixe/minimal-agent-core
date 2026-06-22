<p>
   <h1 align="center">
      <img  height="200" alt="minimal-agent" src="https://github.com/user-attachments/assets/b3b96374-88d2-4a92-9a13-d21ebe127732" /> <br> minimal-agent <br> <br>
   </h1>
</p>


[![CI](https://github.com/gastonmorixe/minimal-agent-dev-private/actions/workflows/ci.yml/badge.svg)](https://github.com/gastonmorixe/minimal-agent-dev-private/actions/workflows/ci.yml)
[![License: CopyRight](https://img.shields.io/badge/License-CopyRight-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20iOS%20%7C%20tvOS-lightgrey)

`minimal-agent` is a tiny, beautiful, composable agent harness. 

It is built for people who want to see the wire shape, tool loop, terminal renderer, session logs, plugins, auth refresh, and prompt caching without unpacking a bundled CLI. It runs as a usable terminal agent, but the point is clarity: each moving part has a file you can read, a test you can run, and a debug path you can inspect.

## What it is

`minimal-agent` does four things:

- **Runs a real local agent:** Interactive REPL, one-shot prompts, stdin input, tool calls, streamed output, and resume.
- **Matches current Claude Code traffic:** OAuth headers, beta flags, metadata, thinking blocks, prompt cache markers, SSE parsing, and tool result pairing are kept close to captured Claude Code behavior.
- **Keeps the terminal sharp:** Live input, status rows, formatter support, diff display, spinner presets, quit modal, hidden-character display, and mdstream output are all tested as terminal code, not string guesses.
- **Makes internals inspectable:** Network captures, session JSONL, plugin manifests, config parsing, tool definitions, and command routing live in small files.

## Requirements

- [Bun](https://bun.com) 1.1+. That's the only hard dependency. The agent runs
  the TypeScript source directly, so there is no build step and no compiled
  release to install.
- `git`, if you want the first-run bootstrap to fetch the extended plugins.
- macOS or Linux. Credentials live in a plain `~/.minimal-agent/auth.jsonc`
  (mode 0600), not the system keychain, so the same login works on a server,
  a container, or your laptop.
- Optional: `mdstream` for Markdown rendering. The agent auto-downloads it on
  first run.
- Optional: `BRAVE_API_KEY` for the WebSearch plugin.

## Install & run

There is no install step in the usual sense. You need Bun and the source; Bun
does the rest at first run (auth, Markdown renderer, plugins). Pick one:

### Run from a clone (works today)

```sh
git clone https://github.com/gastonmorixe/minimal-agent.git
cd minimal-agent
./minimal-agent           # first run walks you through sign-in + setup
```

### Run straight from GitHub with bunx (no clone)

The package declares a `bin`, so once the repo is reachable you can run it
without cloning. Bun fetches the source, runs the TypeScript, done:

```sh
bunx github:gastonmorixe/minimal-agent
```

This works as-is when the repo is **public**. While the repo is **private**,
`bunx github:` can't authenticate (it hits GitHub's tarball API anonymously),
so use a token-authenticated install instead:

```sh
# one-off, with a GitHub token that can read the repo
bun add -g "git+https://x-access-token:$(gh auth token)@github.com/gastonmorixe/minimal-agent.git"
minimal-agent
```

`bun add -g` honors the token embedded in the git URL. The bare
`bunx <git-url>` form is not supported by Bun.

### First run

On a clean machine the first interactive launch shows a short setup card and
then, in order:

1. **Signs you in.** OAuth against your Anthropic (Claude) account via the
   manual-paste PKCE flow. Credentials are written to
   `~/.minimal-agent/auth.jsonc`.
2. **Fetches `mdstream`** (the Markdown renderer) into `~/.minimal-agent/bin/`.
3. **Fetches the extended plugins** (`Fetch`, `Skill`, slash-menu, …) into
   `~/.minimal-agent/plugins/`.

Every step is best-effort and degrades cleanly: no network, no `git`, or a
declined sign-in just means fewer features, never a crash. After the first run
none of this repeats.

### Dev entry point

```sh
bun install                 # dev deps only (biome, oxlint, typecheck)
bun run src/index.ts        # raw entry point
./minimal-agent --help
```

Run a prompt without entering the REPL:

```sh
./minimal-agent "explain this repo in five bullets"
./minimal-agent --prompt "list the files touched in the last commit"
echo "summarize stdin" | ./minimal-agent -
```

Use Bun directly when you want the raw dev entry point:

```sh
bun run src/index.ts
bun run src/index.ts --model claude-sonnet-4-6
bun run src/index.ts --debug
```

## Daily commands

```sh
bun run check
bun run typecheck
bun run lint
bun run format
bun test
```

`bun run check` is the full local gate. It runs typecheck, lint, format check, docs check, and tests.

## CLI surface

Core commands:

- **Interactive:** `./minimal-agent`
- **One-shot prompt:** `./minimal-agent "prompt text"`
- **Explicit prompt:** `./minimal-agent --prompt "prompt text"`
- **stdin prompt:** `echo "prompt" | ./minimal-agent -`
- **Resume:** `./minimal-agent --resume <sid>`
- **Resume latest:** `./minimal-agent --resume last`
- **List sessions:** `./minimal-agent --sessions`
- **Dump session:** `./minimal-agent --dump <sid|last>`
- **List models:** `./minimal-agent --list-models`
- **List beta flags:** `./minimal-agent --list-flags`
- **List spinners:** `./minimal-agent --list-spinners`

Useful flags:

- **Model:** `--model <id>` (alias `-m`, requires `--provider <id>`)
- **Effort:** `--effort <low|medium|high|xhigh|max>` (alias `-e`)
- **Fast mode:** `--fast` (alias `-F`)
- **Thinking display:** `--thinking-display summarized`
- **Formatter:** `--formatter mdstream`
- **Spinner:** `--spinner <preset>`
- **Debug logging:** `--debug`
- **Hidden characters:** `--show-hidden-chars`
- **Skip quota check:** `--skip-quota`

### Models

Pick a model with `--model <id>` plus `--provider <id>` (or set
`MINIMAL_AGENT_MODEL` / `MINIMAL_AGENT_PROVIDER`, or `model` / `provider` in
config). The default is `claude-sonnet-4-6`. `--list-models` prints the full
live catalog, including the `[1m]` 1M-context aliases and older tiers
(`claude-opus-4-6`, `claude-sonnet-4-5`). `claude-fable-5` is the current
flagship (Mythos-class, launched 2026-06-09).

| Model | `--model` id | Context | Max output | Effort levels | Fast | Price /MTok (in / out) |
| --- | --- | --- | --- | --- | --- | --- |
| Fable 5 | `claude-fable-5` | 1M | 128K | low · medium · high · xhigh · max | no³ | $10 / $50 |
| Opus 4.8 | `claude-opus-4-8` | 1M | 128K | low · medium · high · xhigh · max | yes | $5 / $25 (fast $10 / $50) |
| Opus 4.7 | `claude-opus-4-7` | 1M | 128K | low · medium · high · xhigh · max | yes¹ | $5 / $25 |
| Sonnet 4.6 | `claude-sonnet-4-6` | 1M | 64K | low · medium · high | no | $3 / $15 |
| Haiku 4.5 | `claude-haiku-4-5` | 200K | 64K | none² | no | $1 / $5 |

- **Effort** (`--effort` / `-e`): `low | medium | high | xhigh | max`. Opus 4.7/4.8
  accept `xhigh`; Sonnet 4.6 tops out at `high`; Haiku ignores effort. Default is
  `high` for Opus, `medium` for Sonnet.
- **Fast mode** (`--fast` / `-F`, or `MINIMAL_AGENT_FAST=1`): sends `speed:"fast"`
  for roughly 2.5× throughput. It is capability-gated: only the Opus tier honors
  it, and on Fable/Sonnet/Haiku the flag is dropped with a diagnostic warning.
  For Opus 4.8 fast mode bills at ~2× ($10 / $50). ¹Opus 4.7 fast uses the older
  6× rate ($30 / $150), so `--fast` is meant for Opus 4.8. ²Haiku has no thinking
  or effort. ³Fable 5 ships a single flat rate with no fast tier.

## Config

User config lives at:

```txt
~/.minimal-agent/config.jsonc
```

Set `MINIMAL_AGENT_CONFIG` to point at another file.

Example:

```jsonc
{
  "model": "claude-sonnet-4-6",
  "provider": "anthropic",
  "effort": "high",
  "thinkingDisplay": "summarized",
  "spinner": "breathing-dot",
  "formatter": "mdstream",
  "autoAsk": true,
  "skipQuota": false,
  "plugins": {
    "web-search": {
      "enabled": true,
      "providers": ["brave"],
      "defaults": {
        "count": 5,
        "safesearch": "moderate",
        "country": "ALL",
        "lang": "en"
      },
      "brave": {
        "apiKeyEnv": "BRAVE_API_KEY"
      }
    }
  }
}
```

Precedence is:

```txt
CLI flag > env var > config file > built-in default
```

Disable a plugin with its manifest id:

```jsonc
{
  "plugins": {
    "web-search": {
      "enabled": false
    }
  }
}
```

## Environment

Common environment variables:

- **`DEBUG=1`:** Print request and response debug output.
- **`VERBOSE=1`:** Avoid truncating debug output.
- **`MINIMAL_AGENT_CONFIG`:** Use a custom config file.
- **`MINIMAL_AGENT_TRANSPORT`:** Select `http2` or `fetch`.
- **`MINIMAL_AGENT_LEGACY_TRANSPORT=1`:** Route every request through the legacy Anthropic client instead of the canonical provider transport (rollback escape hatch for the transport flip; wins over `MINIMAL_AGENT_CANONICAL_TRANSPORT`).
- **`MINIMAL_AGENT_ALLOW_FETCH_FALLBACK=1`:** Permit fetch fallback after HTTP/2 failure.
- **`MINIMAL_AGENT_NET_DBG=1`:** Mirror raw HTTP traffic to `.net-dbg/`.
- **`MINIMAL_AGENT_SPINNER`:** Select the spinner preset.
- **`MINIMAL_AGENT_MODEL`:** Select the model (same as `--model`).
- **`MINIMAL_AGENT_PROVIDER`:** Select the provider (same as `--provider`).
- **`MINIMAL_AGENT_EFFORT`:** Set reasoning effort (`low`…`max`).
- **`MINIMAL_AGENT_FAST=1`:** Opt into fast-mode dispatch (Opus 4.8).
- **`MINIMAL_AGENT_THINKING_DISPLAY`:** Set `summarized` or `omitted`.
- **`MINIMAL_AGENT_NO_LIVE_AREA=1`:** Use the legacy raw input path.
- **`MINIMAL_AGENT_AUTO_ASK=0`:** Disable automatic ASK mode detection.
- **`MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1`:** Show spaces, tabs, and newlines in the editor.
- **`MINIMAL_AGENT_SKIP_QUOTA=1`:** Skip startup quota check.
- **`MINIMAL_AGENT_NO_PLUGIN_SYNC=1`:** Skip the first-run plugin clone.
- **`MINIMAL_AGENT_PLUGINS_REPO`:** Git URL for the extended plugins repo (fork/mirror).
- **`MINIMAL_AGENT_GITHUB_TOKEN`:** Token for cloning a private plugins repo (falls back to `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`).
- **`MINIMAL_AGENT_DISABLE_CRON=1`:** Disable the schedule plugin (heartbeat inert, cron tools refuse).
- **`MINIMAL_AGENT_CRON_DIR`:** Relocate the schedule store (default `~/.minimal-agent/sessions`).
- **`CLAUDE_CODE_EXTRA_METADATA`:** JSON object merged into `metadata.user_id`.

## Built-in tools

The model sees a small Claude Code-like tool set:

- **`Bash`:** Run shell commands. The working directory persists across calls.
- **`Read`:** Read files with line numbers.
- **`Write`:** Create or overwrite files.
- **`Edit`:** Replace exact strings and render diffs.
- **`Glob`:** Match files by pattern.
- **`Grep`:** Search content with ripgrep.

The omission is intentional. The core agent ships no sub-agent tool, skill runner, or deferred tool loader. Those are larger surfaces than the loop itself needs. Where one earns its place (delegation), it lands as a *plugin* the core knows nothing about: the `sub-agents` plugin adds `SpawnAgent` and friends on top of generic seams, and the agent loop never learns the word "sub-agent". See `plugins/sub-agents/` and `docs/changes/2026-05-30-sub-agents.md`.

## Plugins

Plugins are discovered from four roots, closest-to-user wins on a package-id
collision:

```txt
<cwd>/.agents/plugins/      project-local (highest precedence)
~/.agents/plugins/          your hand-curated home plugins
~/.minimal-agent/plugins/   extended first-party plugins (auto-cloned on first run)
<install>/plugins/          embedded built-ins (lowest precedence)
```

The embedded built-ins ship inside the agent. The extended first-party plugins
(`Fetch`, `Skill`, slash-menu, agent-writing-style) live in a separate repo,
[`minimal-agent-plugins`][map], and are cloned once into
`~/.minimal-agent/plugins/` on the first interactive run. The clone is one-shot:
once that directory has plugins it is never auto-pulled, so you stay in control.
Update them yourself with `git -C ~/.minimal-agent/plugins pull`.

[map]: https://github.com/gastonmorixe/minimal-agent-plugins

Controls:

- **Disable the bootstrap:** `MINIMAL_AGENT_NO_PLUGIN_SYNC=1` (or
  `"pluginSync": false` in config).
- **Point at a fork / mirror:** `MINIMAL_AGENT_PLUGINS_REPO=<git-url>` (or
  `"pluginsRepo"` in config).
- **Private plugins repo:** the bootstrap authenticates with the first token it
  finds: `MINIMAL_AGENT_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then `GH_TOKEN`,
  then `gh auth token`. The token is passed to `git` through an inline
  credential helper, so it never lands in `ps`, the clone URL, or the cloned
  `.git/config`.

Each plugin has a manifest, optional prompt text, and optional handlers.

Current plugins:

- **Ask Mode:** Adds a read-only `ASK` mode. Edit and Write are blocked at dispatch time.
- **Diff Viewer:** Adds `ShowDiff` and inline diff rendering.
- **Env Info:** Adds a startup environment snapshot to the system prompt.
- **Interleave Thinking:** Captures and hides tagged interleaved thinking spans from visible output.
- **Memory:** Saves and reloads cross-session memory from `~/.minimal-agent`.
- **Web Search:** Adds `WebSearch` with a provider chain. Brave is the shipped provider.
- **Sub-agents:** Delegation. Spawn background `minimal-agent` workers (`SpawnAgent`), watch them in a live fleet widget, and fold their distilled results back. A 1s supervisor reaps exits and reports between turns. Disable with `MINIMAL_AGENT_DISABLE_SUBAGENTS=1`.
- **Schedule:** Run prompts on a schedule. Adds the `CronCreate`/`CronList`/`CronDelete` tools (the model schedules from natural language like "remind me at 3pm" or "every 5 minutes check the deploy") plus the `/loop` and `/schedule` commands. A 1-second heartbeat injects each due task's prompt *between* turns. Tasks live at `~/.minimal-agent/sessions/<sid>.cron.json` and restore (unexpired) on `--resume`. Disable with `MINIMAL_AGENT_DISABLE_CRON=1`. See `docs/changes/2026-05-30-schedule-plugin.md`.
- **Slash Menu:** Autocomplete overlay for slash commands. Type a bare `/<fragment>` and matching commands (from any plugin's manifest `commands[]`) appear in the editor footer; `↑/↓` select, `Tab`/`Enter` complete, `Esc` closes. Pure discoverability over the host command registry.

Run WebSearch directly while debugging provider config:

```sh
bun run plugins/web-search/cli.ts "typescript 6 release notes" --limit 5
bun run plugins/web-search/cli.ts "EU AI act" --type news --format json
```

## Sessions

Every session is stored as append-only JSONL in:

```txt
~/.minimal-agent/sessions/
```

The session id is the same id sent in `x-claude-code-session-id`, printed at startup, and used for local files. Resume does not replay half-written turns. It folds saved records back into `messages[]`, repairs orphan tool pairs, warns on system or tool drift, then shows previous conversation in scrollback before accepting new input.

Assistant turns are persisted as the full `ContentBlock[]` array, including thinking blocks with their cryptographic signatures. Restore is lossless: on resume those thinking blocks ride back into history unchanged, so the `redact-thinking-2026-02-12` beta keeps verifying across reloads. See `AssistantRecord` in `src/session-store.ts` for the schema-level note. The inline `<ma::emit::interleave-thinking>` tag is NOT persisted (it is dropped by the plugin scanner before it ever reaches a text block); only native API thinking blocks are saved.

Commands:

```sh
./minimal-agent --sessions
./minimal-agent --resume last
./minimal-agent --dump last --dump-format md
./minimal-agent --dump last --dump-format xml
```

More detail: `docs/internal/session-restore.md`.

## Debugging the wire

Use `--debug` when you want readable request and response summaries:

```sh
./minimal-agent --debug "what model are you"
```

Use network debug capture when you want raw request and response files:

```sh
MINIMAL_AGENT_NET_DBG=1 ./minimal-agent
```

Captures are written under `.net-dbg/`. They are meant for diffing against captured Claude Code traffic.

Prompt cache behavior is documented in `docs/internal/caching.md`. The short version: tools, system blocks, and the rolling conversation tail are arranged so Anthropic's prefix cache can pay off across turns in one process.

## Project map

Start here:

- **`src/index.ts`:** CLI, startup, config, plugin loading, session wiring, and REPL launch.
- **`src/agent.ts`:** Agent loop, message history, tool execution, cache markers, and streamed assistant turns.
- **`src/client.ts`:** Messages API request body, SSE parsing, thinking blocks, usage, and retry behavior.
- **`src/auth.ts`:** Keychain credential read, OAuth refresh, and account metadata.
- **`src/headers.ts`:** User-Agent, beta flags, system prompt, and Anthropic headers.
- **`src/tools.ts`:** Core tool schemas and local executors.
- **`src/network/`:** HTTP/2 transport, fetch transport, fallback, observers, and test transport.
- **`src/plugins/`:** Plugin scanner, loader, manifest types, stream handling, events, and hooks.
- **`src/ui/`:** Live terminal compositor, input overlays, modal UI, and terminal capability handling.
- **`src/session-store.ts`:** JSONL writer and session index.
- **`src/session-restore.ts`:** Session folding and repair.
- **`src/session-replay.ts`:** Resume header and scrollback replay.
- **`plugins/`:** Bundled plugin manifests, prompts, handlers, and tests.
- **`docs/internal/`:** Notes for the parts that are easiest to break by guessing.

## Design rules

The repo works best when changes stay small and observable:

- **Zero runtime dependencies.** `package.json` ships an empty `dependencies` block and stays that way. The agent runs on Bun's standard library and the TypeScript source alone, no npm packages pulled at runtime. The only entries are `devDependencies`: the toolchain (Bun, Biome, oxlint, typedoc, TypeScript) that lint, format, type-check, and test the source. Nothing it installs ends up in the running agent. New features add a file you can read, not a transitive dependency tree you can't. Optional external binaries (`mdstream` for Markdown, `git` for plugin bootstrap) are fetched on demand and degrade gracefully when absent, they are not package dependencies.
- Preserve the wire shape unless you have a capture or test proving the change.
- Keep terminal rendering behavior under tests. ANSI output bugs are visual bugs.
- Treat formatter lifecycle and rendered output as separate checks.
- Keep plugin opt-out paths keyed by manifest id.
- Keep session writes at turn boundaries. Do not write partial token streams as durable history.
- Prefer process-level smoke tests when changing startup, transport, auth, plugins, or terminal paths.

## Docs worth reading

- `docs/CHANGELOG.md` : release notes, newest first.
- `docs/tui/` : terminal renderer architecture, the compositor, live area, and editor controller, one file per layer.
- `docs/network/README.md` : HTTP transport, retry, and wire-capture notes.
- `docs/sub-agents-prompt.md` : how the sub-agents system prompt composes.
- `docs/changes/` : per-change write-ups, dated, the design rationale behind each landed change.

## Status

This is a research tool and a daily-use terminal agent. It is not trying to be a full clone of Claude Code. The value is the smaller surface: enough behavior to run real agentic turns, enough tests to change it without guessing, and enough debug output to explain what happened when the server or terminal says no.
