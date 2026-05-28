# minimal-agent

`minimal-agent` is a tiny, beautiful, composable agent harness. 

It is built for people who want to see the wire shape, tool loop, terminal renderer, session logs, plugins, auth refresh, and prompt caching without unpacking a bundled CLI. It runs as a usable terminal agent, but the point is clarity: each moving part has a file you can read, a test you can run, and a debug path you can inspect.

## What it is

`minimal-agent` does four things:

- **Runs a real local agent:** Interactive REPL, one-shot prompts, stdin input, tool calls, streamed output, and resume.
- **Matches current Claude Code traffic:** OAuth headers, beta flags, metadata, thinking blocks, prompt cache markers, SSE parsing, and tool result pairing are kept close to captured Claude Code behavior.
- **Keeps the terminal sharp:** Live input, status rows, formatter support, diff display, spinner presets, quit modal, hidden-character display, and mdstream output are all tested as terminal code, not string guesses.
- **Makes internals inspectable:** Network captures, session JSONL, plugin manifests, config parsing, tool definitions, and command routing live in small files.

## Requirements

- Bun.
- macOS if you want first-party Claude Code OAuth reuse through Keychain.
- A working Claude Code login. Run the official `claude` CLI and sign in first.
- Optional: `mdstream` for Markdown rendering. The agent can resolve it automatically when configured as the formatter.
- Optional: `BRAVE_API_KEY` for the WebSearch plugin.

## Quick start

```sh
bun install
./minimal-agent --help
./minimal-agent
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

- **Model:** `--model <id>`
- **Effort:** `--effort <level>`
- **Thinking display:** `--thinking-display summarized`
- **Formatter:** `--formatter mdstream`
- **Spinner:** `--spinner <preset>`
- **Debug logging:** `--debug`
- **Hidden characters:** `--show-hidden-chars`
- **Skip quota check:** `--skip-quota`

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
- **`MINIMAL_AGENT_ALLOW_FETCH_FALLBACK=1`:** Permit fetch fallback after HTTP/2 failure.
- **`MINIMAL_AGENT_NET_DBG=1`:** Mirror raw HTTP traffic to `.net-dbg/`.
- **`MINIMAL_AGENT_SPINNER`:** Select the spinner preset.
- **`MINIMAL_AGENT_EFFORT`:** Set reasoning effort.
- **`MINIMAL_AGENT_THINKING_DISPLAY`:** Set `summarized` or `omitted`.
- **`MINIMAL_AGENT_NO_LIVE_AREA=1`:** Use the legacy raw input path.
- **`MINIMAL_AGENT_AUTO_ASK=0`:** Disable automatic ASK mode detection.
- **`MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1`:** Show spaces, tabs, and newlines in the editor.
- **`MINIMAL_AGENT_SKIP_QUOTA=1`:** Skip startup quota check.
- **`CLAUDE_CODE_EXTRA_METADATA`:** JSON object merged into `metadata.user_id`.

## Built-in tools

The model sees a small Claude Code-like tool set:

- **`Bash`:** Run shell commands. The working directory persists across calls.
- **`Read`:** Read files with line numbers.
- **`Write`:** Create or overwrite files.
- **`Edit`:** Replace exact strings and render diffs.
- **`Glob`:** Match files by pattern.
- **`Grep`:** Search content with ripgrep.

The omission is intentional. There is no sub-agent tool, skill runner, or deferred tool loader in the core agent. Those are larger surfaces than this repo needs for its main job: make the agent loop plain.

## Plugins

Plugins live under `plugins/`. Each plugin has a manifest, optional prompt text, and optional handlers.

Current plugins:

- **Ask Mode:** Adds a read-only `ASK` mode. Edit and Write are blocked at dispatch time.
- **Diff Viewer:** Adds `ShowDiff` and inline diff rendering.
- **Env Info:** Adds a startup environment snapshot to the system prompt.
- **Interleave Thinking:** Captures and hides tagged interleaved thinking spans from visible output.
- **Memory:** Saves and reloads cross-session memory from `~/.minimal-agent`.
- **Web Search:** Adds `WebSearch` with a provider chain. Brave is the shipped provider.

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

Assistant turns are persisted as the full `ContentBlock[]` array, including thinking blocks with their cryptographic signatures. Restore is lossless: on resume those thinking blocks ride back into history unchanged, so the `redact-thinking-2026-02-12` beta keeps verifying across reloads. See `AssistantRecord` in `src/session-store.ts` for the schema-level note. The inline `<ma::plugin::interleave-thinking>` tag is NOT persisted (it is dropped by the plugin scanner before it ever reaches a text block); only native API thinking blocks are saved.

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

- Preserve the wire shape unless you have a capture or test proving the change.
- Keep terminal rendering behavior under tests. ANSI output bugs are visual bugs.
- Treat formatter lifecycle and rendered output as separate checks.
- Keep plugin opt-out paths keyed by manifest id.
- Keep session writes at turn boundaries. Do not write partial token streams as durable history.
- Prefer process-level smoke tests when changing startup, transport, auth, plugins, or terminal paths.

## Docs worth reading

- `docs/internal/caching.md`
- `docs/internal/session-restore.md`
- `docs/internal/oauth-token-refresh.md`
- `docs/internal/plugin-prompt-block-structure.md`
- `docs/internal/repl-prompt-response-separator.md`
- `docs/internal/repl-text-transcript-separators.md`
- `docs/internal/input/multiline-prompt-fixes.md`
- `docs/CHANGELOG.md`

## Status

This is a research tool and a daily-use terminal agent. It is not trying to be a full clone of Claude Code. The value is the smaller surface: enough behavior to run real agentic turns, enough tests to change it without guessing, and enough debug output to explain what happened when the server or terminal says no.
