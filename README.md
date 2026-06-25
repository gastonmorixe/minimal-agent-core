<p>
   <h1 align="center">
      <img  height="200" alt="minimal-agent" src="https://github.com/user-attachments/assets/b3b96374-88d2-4a92-9a13-d21ebe127732" /> <br> minimal-agent <br> <br>
   </h1>
</p>


[![CI](https://github.com/gastonmorixe/minimal-agent-dev-private/actions/workflows/ci.yml/badge.svg)](https://github.com/gastonmorixe/minimal-agent-dev-private/actions/workflows/ci.yml)
[![Release](https://github.com/gastonmorixe/minimal-agent-dev-private/actions/workflows/release.yml/badge.svg)](https://github.com/gastonmorixe/minimal-agent-dev-private/actions/workflows/release.yml)
[![License: CopyRight](https://img.shields.io/badge/License-CopyRight-blue.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey)

`minimal-agent` is a tiny, beautiful, composable agent harness.

It is built for people who want to see the wire shape, tool loop, terminal renderer, session logs, plugins, auth, and prompt caching without unpacking a bundled CLI. It runs as a usable terminal agent, but the point is clarity: every moving part has a file you can read, a test you can run, and a debug path you can inspect.

## What it is

`minimal-agent` does four things:

- **Runs a real local agent.** Interactive REPL, one-shot prompts, stdin input, tool calls, streamed output, and resume.
- **Talks to any model through a neutral core.** The agent loop, REPL, and renderers depend on canonical request/event types, never a vendor's wire format. Each backend is a separate provider plugin that translates canonical types to its own protocol.
- **Keeps the terminal sharp.** Live input, status rows, formatter support, diff display, spinner presets, quit modal, hidden-character display, and Markdown output are all tested as terminal code, not string guesses.
- **Makes internals inspectable.** Network captures, session JSONL, plugin manifests, config parsing, tool definitions, and command routing live in small files.

## Architecture in one breath

The core (`src/`) is provider-agnostic. It defines neutral seams: a model registry, a capability schema, canonical request/event types, transport selection, and a plugin loader. Providers, tools, and UI extras are **plugins** that fill those seams. The core never imports a concrete plugin, and a plugin never reaches into core internals. Three fitness tests enforce that boundary on every CI run, so the layering can't quietly rot.

The shared contract both sides depend on lives in a leaf package, `@minimal-agent/plugin-api`, which imports nothing from either tree. That is what lets a plugin compile and make sense in its own repo.

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
- Optional: a `BRAVE_API_KEY` (or any provider key) for the plugins that need one.

## Install & run

There is no build step. The agent runs straight from the TypeScript source on
Bun, so "installing" is getting the source tree onto your machine and running
`bun install`. Pick one:

### From a release tarball

Every push to `dev-private` / `main` and every PR produces a timestamped
pre-release tarball on the [Releases page][releases]. Stable releases are cut
from `v*` tags. Each release ships a source tarball and its SHA-256 checksum.

[releases]: https://github.com/gastonmorixe/minimal-agent-dev-private/releases

```sh
# download minimal-agent-<label>.tar.gz + its .sha256 from the release assets
sha256sum -c minimal-agent-<label>.tar.gz.sha256   # verify before extracting
tar -xzf minimal-agent-<label>.tar.gz
cd minimal-agent
bun install
./minimal-agent           # first run walks you through sign-in + setup
```

### From a clone (latest, unreleased)

```sh
git clone https://github.com/gastonmorixe/minimal-agent-dev-private.git
cd minimal-agent-dev-private
bun install
./minimal-agent
```

### On a private fork

While the repo is private, anonymous git access fails. Use a token-authenticated
clone instead:

```sh
git clone "https://x-access-token:$(gh auth token)@github.com/gastonmorixe/minimal-agent-dev-private.git"
cd minimal-agent-dev-private
bun install
./minimal-agent
```

### First run

On a clean machine the first interactive launch shows a short setup card and
then, in order:

1. **Signs you in.** OAuth via the manual-paste PKCE flow against the provider
   you chose. Credentials are written to `~/.minimal-agent/auth.jsonc`.
2. **Fetches `mdstream`** (the Markdown renderer) into `~/.minimal-agent/bin/`.
3. **Fetches the extended plugins** into `~/.minimal-agent/plugins/`.

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
bun run src/index.ts --model <id> --provider <id>
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

`bun run check` is the full local gate. It runs, in order: typecheck, lint
(oxlint), format check, the architecture fitness tests, docs check, and the test
suite. It stops at the first failure.

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

- **Model:** `--model <id>` (alias `-m`, paired with `--provider <id>`)
- **Provider:** `--provider <id>`
- **Effort:** `--effort <low|medium|high|xhigh|max>` (alias `-e`)
- **Fast mode:** `--fast` (alias `-F`)
- **Thinking display:** `--thinking-display summarized`
- **Formatter:** `--formatter mdstream`
- **Spinner:** `--spinner <preset>`
- **Debug logging:** `--debug`
- **Hidden characters:** `--show-hidden-chars`
- **Skip quota check:** `--skip-quota`

## Models & providers

A model lives in a provider plugin, not in the core. Pick one with `--model <id>`
plus `--provider <id>` (or set `MINIMAL_AGENT_MODEL` / `MINIMAL_AGENT_PROVIDER`,
or `model` / `provider` in config). The server is the source of truth, so the CLI
does not validate `--model` against the registry: forward-compatible ids pass
straight through.

Run `./minimal-agent --list-models` for the live catalog, capabilities, context
windows, and pricing of every registered model across every loaded provider.

Provider plugins that ship in this repo:

| Provider id | Plugin | Talks | Wire format |
| --- | --- | --- | --- |
| `anthropic` | `plugins/llm-anthropic` | Messages API | native |
| `openai` | `plugins/llm-openai` | Chat Completions + Responses | native |
| `ollama` | `plugins/llm-ollama` | Ollama Cloud open-weight models | native NDJSON |
| `openrouter` | `plugins/llm-openrouter` | OpenRouter gateway | OpenAI-compatible |
| `wafer` | `plugins/llm-wafer` | Wafer Serverless gateway | OpenAI-compatible |
| `opencode` | `plugins/llm-opencode` | OpenCode gateway | OpenAI + Messages |

Adding a backend is a directory, not a core change. A provider that speaks the
OpenAI Chat protocol reuses `llm-openai`'s wire layer and lands in ~50 lines; one
with its own protocol implements the adapter port directly. See
[`docs/provider-plugin-standards.md`](docs/provider-plugin-standards.md).

**Capabilities are data, not branching.** Code asks "does this model support
thinking / fast mode / 1M context?" by reading a `Capabilities` record, never by
matching a model id. Effort levels, fast mode, and thinking are all
capability-gated, and a flag a model doesn't support is dropped with a diagnostic
rather than sent to be rejected.

## Config

User config lives at:

```txt
~/.minimal-agent/config.jsonc
```

Set `MINIMAL_AGENT_CONFIG` to point at another file. Edit it interactively with
the `/config` command.

Example:

```jsonc
{
  "model": "<model-id>",
  "provider": "<provider-id>",
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

Disable a plugin with its manifest id in config:

```jsonc
{
  "plugins": {
    "web-search": {
      "enabled": false
    }
  }
}
```

For a single run, use CLI flags (same precedence as other options: CLI > env > config):

```bash
minimal-agent --disable-plugin web-search,memory -p "review this"
minimal-agent --enable-plugin interleave-thinking
minimal-agent plugins list    # discover installed plugin ids
```

Environment mirrors:

- **`MINIMAL_AGENT_DISABLE_PLUGINS`:** Comma-separated ids to skip (same as `--disable-plugin`).
- **`MINIMAL_AGENT_ENABLE_PLUGINS`:** Comma-separated ids to force on (same as `--enable-plugin`).

## Environment

Common environment variables:

- **`DEBUG=1`:** Print request and response debug output.
- **`VERBOSE=1`:** Avoid truncating debug output.
- **`MINIMAL_AGENT_CONFIG`:** Use a custom config file.
- **`MINIMAL_AGENT_TRANSPORT`:** Select `http2` or `fetch`.
- **`MINIMAL_AGENT_LEGACY_TRANSPORT=1`:** Route requests through the legacy client instead of the canonical provider transport (rollback escape hatch for the transport flip; wins over `MINIMAL_AGENT_CANONICAL_TRANSPORT`).
- **`MINIMAL_AGENT_ALLOW_FETCH_FALLBACK=1`:** Permit fetch fallback after an HTTP/2 failure.
- **`MINIMAL_AGENT_NET_DBG=1`:** Mirror raw HTTP traffic to `.net-dbg/`.
- **`MINIMAL_AGENT_SPINNER`:** Select the spinner preset.
- **`MINIMAL_AGENT_MODEL`:** Select the model (same as `--model`).
- **`MINIMAL_AGENT_PROVIDER`:** Select the provider (same as `--provider`).
- **`MINIMAL_AGENT_EFFORT`:** Set reasoning effort (`low`…`max`).
- **`MINIMAL_AGENT_FAST=1`:** Opt into fast-mode dispatch where the model supports it.
- **`MINIMAL_AGENT_THINKING_DISPLAY`:** Set `summarized` or `omitted`.
- **`MINIMAL_AGENT_NO_LIVE_AREA=1`:** Use the legacy raw input path.
- **`MINIMAL_AGENT_AUTO_ASK=0`:** Disable automatic ASK mode detection.
- **`MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1`:** Show spaces, tabs, and newlines in the editor.
- **`MINIMAL_AGENT_SKIP_QUOTA=1`:** Skip the startup quota check.
- **`MINIMAL_AGENT_NO_PLUGIN_SYNC=1`:** Skip the first-run plugin clone.
- **`MINIMAL_AGENT_PLUGINS_REPO`:** Git URL for the extended plugins repo (fork/mirror).
- **`MINIMAL_AGENT_GITHUB_TOKEN`:** Token for cloning a private plugins repo (falls back to `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`).
- **`MINIMAL_AGENT_DISABLE_CRON=1`:** Disable the schedule plugin (heartbeat inert, cron tools refuse).
- **`MINIMAL_AGENT_CRON_DIR`:** Relocate the schedule store (default `~/.minimal-agent/sessions`).

## Built-in tools

The core ships a small, focused tool set:

- **`Bash`:** Run shell commands. The working directory persists across calls.
- **`Read`:** Read files with line numbers.
- **`Write`:** Create or overwrite files.
- **`Edit`:** Replace exact strings and render diffs.
- **`Glob`:** Match files by pattern.
- **`Grep`:** Search content with ripgrep.

The omission is intentional. The core ships no sub-agent tool, skill runner, or
deferred tool loader: those are larger surfaces than the loop itself needs. Where
one earns its place (delegation), it lands as a *plugin* the core knows nothing
about. The `sub-agents` plugin adds `SpawnAgent` and friends on top of generic
seams, and the agent loop never learns the word "sub-agent". See
`plugins/sub-agents/` and `docs/changes/2026-05-30-sub-agents.md`.

## Plugins

Everything beyond the loop is a plugin: providers, modes, extra tools, and UI
overlays. Plugins are discovered from four roots, closest-to-user wins on a
package-id collision:

```txt
<cwd>/.agents/plugins/      project-local (highest precedence)
~/.agents/plugins/          your hand-curated home plugins
~/.minimal-agent/plugins/   extended first-party plugins (auto-cloned on first run)
<install>/plugins/          bundled built-ins (lowest precedence)
```

Each plugin has a manifest, optional prompt text, and optional handlers.

### Bundled plugins

- **Provider plugins** (`llm-anthropic`, `llm-openai`, `llm-ollama`, `llm-openrouter`, `llm-wafer`, `llm-opencode`): each registers its models on the shared registry and exposes an adapter that translates canonical requests to its wire format.
- **Ask Mode:** A read-only `ASK` mode. Edit and Write are refused at dispatch time and the model proposes diffs instead.
- **Config:** Interactive editor for `~/.minimal-agent/config.jsonc` via `/config`.
- **Diagnostics:** Automatic LSP / linter / formatter feedback after Edit/Write.
- **Diff View:** Renders unified diffs with ANSI colors and adds a `ShowDiff` tool.
- **Env Info:** A one-shot host environment snapshot folded into the system prompt.
- **File Lock:** Cooperative locking so concurrent agents in one worktree don't clobber each other.
- **History:** Persistent ↑/↓ recall for the prompt editor.
- **Interleave Thinking:** Captures tagged interleaved thinking spans and hides them from visible output.
- **Memory:** Cross-session memory plus a per-session short-term scratchpad.
- **Model Info:** A provider-agnostic `ModelInfo` tool so the model can read its own capabilities.
- **Quota Status:** Moves the rate-limit / quota readout into a sticky footer instead of the startup tree.
- **Schedule:** Run prompts on a schedule. Adds `ScheduleCronCreate`/`ScheduleCronList`/`ScheduleCronDelete` plus `/loop` and `/schedule`. A 1s heartbeat injects each due task *between* turns. See `docs/changes/2026-05-30-schedule-plugin.md`.
- **Session History:** A `SessionHistory` tool for paginated, filterable reads of recorded transcripts.
- **Session Info:** A `SessionInfo` tool for live runtime state (context fullness, quota, cost, uptime).
- **Sub-agents:** Delegation. Spawn background `minimal-agent` workers, steer them in a live fleet widget, and fold their distilled results back. A 1s supervisor reaps exits and reports between turns.
- **Tasks:** A per-session task list the user watches update in real time.
- **Usage:** A token-usage overlay via `/usage`.
- **Web Search:** Search the web through a provider chain. Brave is the shipped provider.

### Extended plugins (separate repo)

The heavier, opt-in plugins live in their own repo,
[`minimal-agent-plugins`][map], and are cloned once into
`~/.minimal-agent/plugins/` on the first interactive run. The clone is one-shot:
once that directory has plugins it is never auto-pulled, so you stay in control.
Update them yourself with `git -C ~/.minimal-agent/plugins pull`.

That repo currently ships, among others: `Fetch` (JS-rendering web fetch),
`Skill` ([Agent Skills][as] support), `Speak` (text-to-speech), background jobs,
a Chrome DevTools driver, a Mac control helper, inter-session intercom, and a
slash-command palette.

[map]: https://github.com/gastonmorixe/minimal-agent-plugins
[as]: https://agentskills.io

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

The session id is printed at startup and used for all local files (transcript,
network captures, scratch). Resume does not replay half-written turns. It folds
saved records back into `messages[]`, repairs orphan tool pairs, warns on system
or tool drift, then shows the previous conversation in scrollback before
accepting new input.

Assistant turns are persisted as the full `ContentBlock[]` array, including
thinking blocks with their cryptographic signatures. Restore is lossless: on
resume those thinking blocks ride back into history unchanged, so signature
verification keeps working across reloads. See `AssistantRecord` in
`src/session-store.ts` for the schema-level note.

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

Captures are written under `.net-dbg/`, one file per request and response, for
diffing against real traffic.

Prompt cache behavior is documented in `docs/internal/caching.md`. The short
version: tools, system blocks, and the rolling conversation tail are arranged so
a provider's prefix cache can pay off across turns in one process.

## Project map

Start here:

- **`src/index.ts`:** CLI, startup, config, plugin loading, provider discovery, session wiring, and REPL launch.
- **`src/agent.ts`:** Agent loop, message history, tool execution, cache markers, and streamed assistant turns.
- **`src/llm/`:** The provider-agnostic core: canonical request/event types, the capability schema, the model registry, the provider port, and the orchestrator.
- **`src/network/`:** HTTP/2 transport, fetch transport, fallback, observers, and the test transport.
- **`src/plugins/`:** Plugin scanner, loader, manifest types, capability host, stream handling, events, and hooks.
- **`src/ui/`:** Live terminal compositor, input overlays, modal UI, and terminal capability handling.
- **`src/session-store.ts`:** JSONL writer and session index.
- **`src/session-restore.ts`:** Session folding and repair.
- **`src/session-replay.ts`:** Resume header and scrollback replay.
- **`plugin-api/`:** The leaf contract package (`@minimal-agent/plugin-api`): shared types and pure utilities both core and plugins depend on.
- **`plugins/`:** Bundled provider, tool, mode, and UI plugins.
- **`docs/internal/`:** Notes for the parts that are easiest to break by guessing.

## Design rules

The repo works best when changes stay small and observable:

- **Zero runtime dependencies.** `package.json` ships an empty `dependencies` block and stays that way. The agent runs on Bun's standard library and the TypeScript source alone, with no npm packages pulled at runtime. The only entries are `devDependencies`: the toolchain (Bun types, Biome, oxlint, typedoc, TypeScript) that lints, formats, type-checks, and tests the source. New features add a file you can read, not a transitive dependency tree you can't. Optional external binaries (`mdstream`, `git`) are fetched on demand and degrade gracefully when absent.
- **Keep the core provider-agnostic.** Provider names, model ids, and wire details live in a provider plugin, never in `src/`. Three fitness tests enforce this and ratchet down only.
- **Capabilities are data, not branching.** Ask a `Capabilities` record what a model supports; never match a model id in control flow.
- **Prompts live in markdown, not string literals.** Every model-facing prompt is a `.md`/`.tmpl.md` file loaded through `src/prompts.ts`. Prose in markdown, control flow in TypeScript.
- **Keep terminal rendering under tests.** ANSI output bugs are visual bugs. Treat formatter lifecycle and rendered output as separate checks.
- **Keep session writes at turn boundaries.** Do not write partial token streams as durable history.
- **Prefer process-level smoke tests** when changing startup, transport, auth, plugins, or terminal paths.

## Docs worth reading

- `AGENTS.md` : orientation for working in this repo.
- `docs/CHANGELOG.md` : release notes, newest first.
- `docs/provider-plugin-standards.md` : how to write a provider plugin.
- `docs/tui/` : terminal renderer architecture, one file per layer.
- `docs/network/README.md` : HTTP transport, retry, and wire-capture notes.
- `docs/sub-agents-prompt.md` : how the sub-agents system prompt composes.
- `docs/changes/` : per-change write-ups, dated, the design rationale behind each landed change.

## Status

This is a research tool and a daily-use terminal agent. The value is the small
surface: enough behavior to run real agentic turns, enough tests to change it
without guessing, and enough debug output to explain what happened when the
server or terminal says no.
