<p>
   <h1 align="center">
      <img  height="200" alt="minimal-agent" src="https://github.com/user-attachments/assets/b3b96374-88d2-4a92-9a13-d21ebe127732" /> <br> minimal-agent-core <br> <br>
   </h1>
</p>


[![CI](https://github.com/gastonmorixe/minimal-agent-core/actions/workflows/ci.yml/badge.svg)](https://github.com/gastonmorixe/minimal-agent-core/actions/workflows/ci.yml)
[![Release](https://github.com/gastonmorixe/minimal-agent-core/actions/workflows/release.yml/badge.svg)](https://github.com/gastonmorixe/minimal-agent-core/actions/workflows/release.yml)
[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-red.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey)

`minimal-agent` is a tiny, beautiful, composable agent.

This repo is the **engine** of the minimal-agent family. It is a library
package, `@minimal-agent/core`. It owns the agent loop (`AgentCore`), the
canonical model and provider contracts, session records, the plugin loader
and the plugin contract, auth, and prompt caching. It has no executable.

The terminal client (the `minimal-agent` bin, the REPL, the TUI, argument
parsing, and `--host-mode`) lives in
[gastonmorixe/minimal-agent-cli](https://github.com/gastonmorixe/minimal-agent-cli).
To run the agent, use that repo.

## What core is

- **The engine.** One conversation per session: tool calls, streamed output,
  resume, and headless run primitives. The loop is `AgentCore`
  (`src/sdk/agent-core.ts`).
- **A neutral model layer.** The agent loop depends on canonical
  request and event types, never on a vendor wire format. Each backend is a
  separate provider plugin that translates canonical types to its own
  protocol.
- **The plugin contract.** `plugin-api/` holds the shared types and pure
  utilities that core and plugins both use. Plugins import it as
  `@minimal-agent/core/plugin-api/*`.
- **Host ports.** A host (the CLI, a web host, or a plugin host mode) gives
  core its I/O through ports. Engine code never writes to the terminal.

## Architecture in one breath

The core (`src/`) is provider-agnostic. It defines neutral seams: a model
registry, a capability schema, canonical request and event types, transport
selection, and a plugin loader. Providers, tools, and UI extras are
**plugins** that fill those seams. The core never imports a concrete plugin,
and a plugin never reaches into core internals. Fitness tests in
`src/architecture/` enforce that boundary on every run of the gate.

The shared contract lives in a leaf folder, `plugin-api/`, which imports
nothing from `src/`. That is why a plugin can compile in its own repo.

## Public exports

The `exports` map in [`package.json`](package.json) is the public contract.
A host imports only those subpaths. The groups are:

| Subpath | Audience |
| --- | --- |
| `@minimal-agent/core` | The SDK runtime entry (`src/sdk/runtime.ts`). |
| `@minimal-agent/core/sdk/*` | SDK ports and types: events, lifecycle, ports, `AgentCore`, turn notices, print mode. |
| `@minimal-agent/core/host/*` | Host services: auth, config, model registry, sessions, network, logs. |
| `@minimal-agent/core/host-kit/*` | Host wiring: `buildAgentCore`, adapters, plugin loader, modes, hooks, stores, and the host-mode contract. |
| `@minimal-agent/core/plugin-api/*` | The plugin contract. |
| `@minimal-agent/core/testing/*` | Test helpers for hosts (`test-core`, `provider-fixture`). |

`src/architecture/public-api.test.ts` freezes this list. The API docs come
from TypeDoc (`typedoc.json`). `bun run docs:check` validates them.

## Use core in a host

Core installs from git. Pin a full commit SHA or a release tag, never a
branch:

```jsonc
{
  "dependencies": {
    "@minimal-agent/core": "git+ssh://git@github.com/gastonmorixe/minimal-agent-core.git#<sha>"
  }
}
```

Keep the `git+ssh` form. Bun turns `git+https://github.com/...` into a
tarball download that ignores git credentials. Core resolves through the
same subpaths for every host, so only one copy of core loads per process.

## Requirements

- [Bun](https://bun.com) 1.4.2 or newer. Core runs TypeScript source
  directly, so there is no build step.
- `git`, for the first-run clone of the extended plugins.
- macOS or Linux.

## Build and test

```sh
bun install       # toolchain only (biome, oxlint, typedoc, TypeScript)
bun run check     # the full local gate
bun test          # the test suite only
bun run typecheck
bun run lint
bun run format
```

`bun run check` runs, in order: typecheck, lint (oxlint), format check, Biome
check (format and import sort), docs check (TypeDoc), and the test suite. It
stops at the first failure.

A test preload (`src/test-utils/guard-process-exit.ts`) makes `process.exit`
throw inside tests, so no test can end the run early. Tests that need the
sibling `../minimal-agent-plugins` checkout skip cleanly without it.

This repository is a Bun workspace (`tools/docs`). Shared toolchain versions
are declared once under `workspaces.catalog` and referenced as `"catalog:"`
from root `devDependencies`. `tools/docs` keeps its own TypeScript 6 pin for
TypeDoc.

## Models and providers

A model lives in a provider plugin, not in the core. Provider plugins live in
the sibling [`minimal-agent-plugins`][map] repo:

| Provider id | Plugin | Talks | Wire format |
| --- | --- | --- | --- |
| `anthropic` | `ma-llm-anthropic-plugin` | Messages API | native |
| `openai` | `ma-llm-openai-plugin` | Chat Completions + Responses | native |
| `ollama` | `ma-llm-ollama-plugin` | Ollama Cloud open-weight models | native NDJSON |
| `openrouter` | `ma-llm-openrouter-plugin` | OpenRouter gateway | OpenAI-compatible |
| `wafer` | `ma-llm-wafer-plugin` | Wafer Serverless gateway | OpenAI-compatible |
| `opencode-go` | `ma-llm-opencode-go-plugin` | OpenCode Go gateway | OpenAI + Messages |
| `opencode-zen` | `ma-llm-opencode-zen-plugin` | OpenCode Zen gateway | OpenAI-compatible |
| `grok` | `ma-llm-grok-plugin` | xAI Grok | OpenAI-compatible |
| `huggingface` | `ma-llm-huggingface-plugin` | HuggingFace Inference Providers gateway | OpenAI-compatible |
| `meta` | `ma-llm-meta-plugin` | Meta Model API | OpenAI-compatible |
| `clinepass` | `ma-llm-clinepass-plugin` | ClinePass | OpenAI-compatible |
| `cursor` | `ma-llm-cursor-plugin` | Cursor agent service | native (connect + proto) |
| `generic-endpoint` | `ma-llm-generic-endpoint-plugin` | any registered wire surface | runtime-configured |

Adding a backend is a directory in the plugins repo, not a core change. A
provider that speaks the OpenAI Chat protocol uses the shared OpenAI Chat wire
layer from the plugin contract. A provider with its own protocol implements
the adapter port directly. See
[`docs/provider-plugin-standards.md`](docs/provider-plugin-standards.md) and
[`docs/2026-07-09-generic-endpoint-and-surface-codecs.md`](docs/2026-07-09-generic-endpoint-and-surface-codecs.md).

**Capabilities are data, not branching.** Code asks "does this model support
thinking / fast mode / 1M context?" by reading a `Capabilities` record, never
by matching a model id.

## Built-in tools

The core ships a small tool set:

- **`Bash`:** Run shell commands. The working directory persists across calls.
- **`Read`:** Read files with line numbers.
- **`Write`:** Create or overwrite files.
- **`Edit`:** Replace exact strings and render diffs.
- **`Glob`:** Match files by pattern.
- **`Grep`:** Search content with ripgrep.

The core ships no sub-agent tool, skill runner, or deferred tool loader. Where
one is necessary (delegation), it is a *plugin* the core knows nothing about.
See `ma-sub-agents-plugin` in the sibling repo and
`docs/changes/2026-05-30-sub-agents.md`.

## Plugins

Everything beyond the loop is a plugin: providers, modes, extra tools, and UI
overlays. Core ships no bundled plugin. The core plugin loader scans these
roots. On a package-id collision, the root closest to the user wins:

```txt
<cwd>/.agents/plugins/      project-local (highest precedence)
~/.agents/plugins/          your hand-curated home plugins
~/.minimal-agent/plugins/   first-party plugins (cloned once from minimal-agent-plugins)
../minimal-agent-plugins/   the sibling repo, found next to the source tree at dev time
```

Each plugin has a manifest, optional prompt text, and optional handlers. A
manifest `hostModes[]` entry lets a plugin take over the whole process after
boot (a plugin host mode). The host-to-plugin types are in
`@minimal-agent/core/host-kit/host-mode`. Hook channels and the decision
contract are in [`docs/hooks.md`](docs/hooks.md).

### First-party plugins (sibling repo)

- **Provider plugins** (`ma-llm-anthropic-plugin`, `ma-llm-openai-plugin`, `ma-llm-ollama-plugin`, `ma-llm-openrouter-plugin`, `ma-llm-wafer-plugin`, `ma-llm-opencode-go-plugin`, and more; see the table above): each registers its models on the shared registry and exposes an adapter that translates canonical requests to its wire format.
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

[map]: https://github.com/gastonmorixe/minimal-agent-plugins

## Sessions

Core stores every session as append-only JSONL under
`~/.minimal-agent/sessions/`. Resume folds saved records back into
`messages[]`, repairs orphan tool pairs, and warns on system or tool drift.
It does not replay half-written turns.

Assistant turns are stored as the full `ContentBlock[]` array, with thinking
blocks and their signatures. Restore is lossless, so signature verification
works across reloads. See `AssistantRecord` in
`src/session/session-store.ts` and `src/session/session-restore.ts`.

Prompt cache behavior is documented in `src/cache/cache.ts` and
`src/agent/cache.ts`. Tools, system blocks, and the rolling conversation tail
are arranged so a provider prefix cache can pay off across turns.

## Project map

- **`src/sdk/agent-core.ts`:** `AgentCore`, the one agent loop: message history, tool rounds, cache markers, and streamed assistant turns.
- **`src/sdk/`:** SDK ports, events, the stop policy, and the neutral wire-event mapper (`wire-events.ts`).
- **`src/llm/`:** The provider-agnostic core: canonical request and event types, the capability schema, the model registry, the provider port, and the orchestrator.
- **`src/network/`:** HTTP/2 transport, fetch transport, fallback, observers, and the test transport.
- **`src/plugins/`:** Plugin scanner, loader, manifest types, capability host, stream handling, events, and hooks.
- **`src/host-public/`:** Host contract types, such as the host-mode contract.
- **`src/session/`:** The JSONL session store, the session index, and session restore.
- **`src/architecture/`:** Fitness tests and ratchets: provider-clean core, core never imports plugins, plugins never import core, the plugin-api leaf rule, and the public package contract.
- **`plugin-api/`:** The leaf contract folder, exported as `@minimal-agent/core/plugin-api/*`.
- **`docs/`:** Architecture and contributor docs.

## Design rules

- **Zero runtime dependencies.** `package.json` ships an empty `dependencies` block and keeps it empty. Core runs on Bun's standard library and its own TypeScript source. The only `devDependencies` are the toolchain. Optional external binaries (`mdstream`, `git`) are fetched on demand and degrade cleanly when absent.
- **Keep the core provider-agnostic.** Provider names, model ids, and wire details live in a provider plugin, never in `src/`.
- **Capabilities are data, not branching.** Ask a `Capabilities` record what a model supports. Never match a model id in control flow.
- **Prompts live in markdown, not string literals.** Every model-facing prompt is a `.md`/`.tmpl.md` file loaded through `src/prompts/prompts.ts`.
- **No terminal I/O in the engine.** Engine code reports through ports and the diagnostic bus. The host does all rendering.
- **Keep session writes at turn boundaries.** Do not write partial token streams as durable history.

## Docs worth reading

- `AGENTS.md`: orientation for work in this repo.
- `docs/CHANGELOG.md`: release notes, newest first.
- `docs/hooks.md`: hook channels and the decision contract.
- `docs/provider-plugin-standards.md`: how to write a provider plugin.
- `docs/network/README.md`: HTTP transport, retry, and wire-capture notes.
- `docs/sub-agents-prompt.md`: how the sub-agents system prompt composes.
- `docs/changes/`: design rationale for the current architecture.
- Terminal renderer docs are in the CLI repo, under `docs/tui/`.

## Related repositories

- Terminal client and `minimal-agent` bin: [minimal-agent-cli](https://github.com/gastonmorixe/minimal-agent-cli)
- First-party plugins: [minimal-agent-plugins](https://github.com/gastonmorixe/minimal-agent-plugins)
- Monorepo (core, plugins, and CLI pins): [minimal-agent](https://github.com/gastonmorixe/minimal-agent)

## License

Copyright (c) 2025–2026 Gaston Morixe. All rights reserved.

This software is proprietary and confidential. No license is granted to use,
copy, modify, merge, publish, distribute, sublicense, or sell copies of the
software except as expressly authorized in writing by the copyright holder.
See [LICENSE](./LICENSE).

