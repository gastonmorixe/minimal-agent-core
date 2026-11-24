<p>
   <h1 align="center">
      <img  height="200" alt="minimal-agent" src="docs/minimal-agent-logo-character.png" /> <br> minimal-agent-core <br> <br>
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
and the plugin contract, auth, and prompt caching. It has no executable, and
it holds no model-facing text: plugins own every prompt and tool description.

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
and plugin code imports core only through the public subpaths. Fitness tests in
`src/architecture/` enforce that boundary on every run of the gate.

The shared contract lives in a leaf folder, `plugin-api/`, which imports
nothing from `src/`. That is why a plugin can compile in its own repo.

## Public exports

The `exports` map in [`package.json`](package.json) is the public contract.
A host imports only those subpaths. The groups are:

| Subpath | Audience |
| --- | --- |
| `@minimal-agent/core` | The SDK runtime entry (`src/sdk/runtime.ts`). |
| `@minimal-agent/core/errors` | Typed errors, `invariant()`, and the error renderer registry. |
| `@minimal-agent/core/sdk/*` | SDK ports and types: events, lifecycle, ports, `AgentCore`, turn notices, messages, provider and transport types. |
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

The plugins, cli and web repos each pin one core commit this way. In the
monorepo, do not edit those pins by hand: `bun run pins:core` moves all of
them (see "Work in the monorepo").

## Requirements

- [Bun](https://bun.com) 1.4.4 or newer. Core runs TypeScript source
  directly, so there is no build step.
- `git`. `bun install` reads a private git dependency
  (`@minimal-agent/config`), so it needs SSH access to GitHub. A host can
  also ask core to clone the plugins repo on a first run.
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
check (format and import sort), docs check (TypeDoc), the architecture tests
(`bun run test:arch`), and the test suite. It stops at the first failure.

A test preload (`src/test-utils/guard-process-exit.ts`) makes `process.exit`
throw inside tests, so no test can end the run early. Tests that need the
sibling `../minimal-agent-plugins` checkout skip cleanly without it.

This repository is a Bun workspace (`tools/docs`). Shared toolchain versions
are declared once under `workspaces.catalog` and referenced as `"catalog:"`
from root `devDependencies`. `tools/docs` keeps its own TypeScript 6 pin for
TypeDoc.

The CI of this repo checks only the commit messages. It cannot install the
private `@minimal-agent/config` dependency. The full gate runs in the
monorepo CI, on the commit that the monorepo records for core.

## Work in the monorepo

This repo is a git submodule of
[gastonmorixe/minimal-agent](https://github.com/gastonmorixe/minimal-agent)
(the monorepo). Do the daily work there, not in a clone of this repo alone.
Its [README](https://github.com/gastonmorixe/minimal-agent#readme) has the
full workflow. The parts that matter for core:

- **Install once, at the monorepo root.** `bun install` there links this
  folder into plugins, cli and web. An edit in core is live in all three at
  once, with no commit and no pin to move. `bun install` in this folder is
  the same root install.
- **Run `bun run hooks` once after a clone**, at the monorepo root. It sets
  up the commit message hook. `bun install` does that too, but not when
  lifecycle scripts are off on your machine.
- **Make a branch before you commit.** The monorepo checks out each
  submodule at one recorded commit, on no branch (a "detached HEAD"). Run
  `git switch -c <name>` first. A commit on no branch is hard to find again.
- **Land core first, then move the pins.** Push the commit to core `main`.
  Then, at the monorepo root, run `bun run pins:core --dry-run` and
  `bun run check`. The last step depends on where you are:
  - The monorepo and plugins, cli and web are all on `main`, level with
    `origin/main`: run `bun run pins:core --commit --push`. It moves the core
    pin in plugins, cli and web, and records the new commits in the monorepo.
  - A worktree, or a fresh clone (its submodules are on no branch): that
    command stops. Run `bun run pins:core <core sha>` and follow "A change in
    core" in the monorepo README.
- **After a dependency change, run `bun run pins:lock`** at the monorepo
  root. The root install does not update the `bun.lock` of this repo.
  `pins:lock` does. Commit that file here.
- **`bun run pins`** at the monorepo root shows the state of every pin and
  the next command to run.

In a clone of this repo alone, `bun install` and `bun run check` work. The
tests that need the plugins checkout skip.

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
- **`FilesStats`:** Report the status of files that the session tracks.
- **`Mode`:** Report the active operating mode and its tool permissions.

Core holds the code and the input schema of each tool. The descriptions that
the model reads are in `ma-core-tools-plugin`, in the plugins repo.

The core ships no sub-agent tool, skill runner, or deferred tool loader. Where
one is necessary (delegation), it is a *plugin* the core knows nothing about.
See `ma-sub-agents-plugin` in the sibling repo and
`docs/changes/2026-05-30-sub-agents.md`.

## Plugins

Everything beyond the loop is a plugin: providers, modes, extra tools, and UI
overlays. Core ships no bundled plugin and knows no default plugin location.
The host computes the plugin roots and passes them in (`PluginRoots`, by
tier). On a package-id collision, project wins, then user, then embedded.
The CLI uses these roots:

```txt
<cwd>/.agents/minimal-agent/plugins/   project: project-local (highest precedence)
~/.minimal-agent/plugins/              user: first-party plugins (cloned once from minimal-agent-plugins, only when there is no checkout)
../minimal-agent-plugins/              embedded: the dev checkout next to the CLI repo
```

A compiled CLI binary also carries every first-party plugin inside it, below
all three roots.

Plugins import core as `@minimal-agent/core/*`. The loader serves every
public subpath from the host's own copy, so one copy of core loads per
process, also inside a `bun build --compile` binary (see `AGENTS.md`).

Each plugin has a manifest, optional prompt text, and optional handlers. A
manifest `hostModes[]` entry lets a plugin take over the whole process after
boot (a plugin host mode). The host-to-plugin types are in
`@minimal-agent/core/host-kit/host-mode`. Hook channels and the decision
contract are in [`docs/hooks.md`](docs/hooks.md).

### First-party plugins (sibling repo)

The plugins repo holds about 60 packages. Its
[README](https://github.com/gastonmorixe/minimal-agent-plugins#readme) lists
all of them. `minimal-agent plugins list` shows the plugins that a run finds,
and which are on.
The kinds:

- **Provider plugins** (`ma-llm-*`, the table above). Each one registers its
  models on the shared registry and translates canonical requests to its wire
  format.
- **Text owners** (`ma-base-prompt-plugin`, `ma-core-tools-plugin`,
  `ma-turn-recovery-plugin`). They hold the system prompt, the tool
  descriptions, and the recovery text that the model reads. They are
  required plugins: a run cannot disable them. `ma-host-text-plugin` holds
  the text of core errors that the user reads.
- **Tools.** Background jobs, web fetch and search, sub-agents, tasks,
  memory, skills, session history, schedule, intercom, and more.
- **Modes and prompt parts.** The read-only ASK mode, `AGENTS.md` loading,
  the environment snapshot, the agent identity.
- **Terminal extras.** `/config`, `/usage`, the slash menu, prompt history,
  the quota footer, diff colors.
- **Host modes.** `ma-acp-plugin` runs the agent as an Agent Client Protocol
  server.

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

Prompt cache behavior is documented in `src/agent/cache.ts` and
`src/cache/cache-ttl.ts`. Tools, system blocks, and the rolling conversation tail
are arranged so a provider prefix cache can pay off across turns.

## Project map

- **`src/sdk/agent-core.ts`:** `AgentCore`, the one agent loop: message history, tool rounds, cache markers, and streamed assistant turns.
- **`src/sdk/`:** SDK ports, events, the stop policy, and the neutral wire-event mapper (`wire-events.ts`).
- **`src/llm/`:** The provider-agnostic core: canonical request and event types, the capability schema, the model registry, the provider port, and the orchestrator.
- **`src/network/`:** HTTP/2 and HTTP/3 transports, fetch transport, fallback, observers, and the test transport.
- **`src/plugins/`:** Plugin scanner, loader, manifest types, capability host, stream handling, events, and hooks.
- **`src/host-public/`:** The public entry files of the `errors`, `host/*`, `host-kit/*` and `testing/*` subpaths. Most of them re-export one internal module.
- **`src/session/`:** The JSONL session store, the session index, and session restore.
- **`src/architecture/`:** Fitness tests and ratchets: provider-clean core, core never imports plugins, plugins never import core `src/` by a relative path, the plugin-api leaf rule, no prompt text in core, and the public package contract.
- **`plugin-api/`:** The leaf contract folder, exported as `@minimal-agent/core/plugin-api/*`.
- **`docs/`:** Architecture and contributor docs.

## Design rules

- **Zero runtime dependencies.** `package.json` ships an empty `dependencies` block and keeps it empty. Core runs on Bun's standard library and its own TypeScript source. The only `devDependencies` are the toolchain. External binaries are optional: `mdstream` is fetched on demand, `git` is used when it is there, and core degrades cleanly without them.
- **Keep the core provider-agnostic.** Provider names, model ids, and wire details live in a provider plugin, never in `src/`.
- **Capabilities are data, not branching.** Ask a `Capabilities` record what a model supports. Never match a model id in control flow.
- **No model-facing text in core.** Every prompt, tool description and synthetic message is a markdown file in a plugin. Core asks a plugin for the text by kind and holds no copy. `src/architecture/no-prompt-text.test.ts` fails when prompt text comes back into `src/` or `plugin-api/`.
- **No terminal I/O in the engine.** Engine code reports through ports and the diagnostic bus. The host does all rendering.
- **Keep session writes at turn boundaries.** Do not write partial token streams as durable history.

## Docs worth reading

- `AGENTS.md`: orientation for work in this repo.
- `docs/CHANGELOG.md`: release notes, newest first.
- `docs/hooks.md`: hook channels and the decision contract.
- `docs/provider-plugin-standards.md`: how to write a provider plugin.
- `docs/host-boot.md`: `bootHost()`, the boot of a host that has no terminal.
- `docs/plugin-prompt-architecture.md`: how plugin text becomes part of the system prompt.
- `docs/network/README.md`: HTTP transport, retry, and wire-capture notes.
- `docs/sub-agents-prompt.md`: how the sub-agents system prompt composes.
- `docs/changes/`: design rationale for the current architecture.
- Terminal renderer docs are in the CLI repo, under `docs/tui/`.

## Related repositories

- Monorepo (records which commits of the five repos go together): [minimal-agent](https://github.com/gastonmorixe/minimal-agent)
- Terminal client and `minimal-agent` bin: [minimal-agent-cli](https://github.com/gastonmorixe/minimal-agent-cli)
- First-party plugins: [minimal-agent-plugins](https://github.com/gastonmorixe/minimal-agent-plugins)
- Web host: [minimal-agent-web](https://github.com/gastonmorixe/minimal-agent-web)
- Shared Biome, oxlint and TypeScript config: [minimal-agent-config](https://github.com/gastonmorixe/minimal-agent-config)

## Releases

Each push to `main`, and each pull request to `main` from a branch of this
repo, makes a nightly pre-release, tagged `v<version>-nightly.<UTC stamp>`. A
pushed `v<version>` tag that equals the `package.json` version makes a stable
release. Both attach a source tarball and its SHA-256 file.
The release workflow does not run the gate. Consumers do not use these
releases today: they pin a commit SHA.

## License

Copyright (c) 2025–2026 Gaston Morixe. All rights reserved.

This software is proprietary and confidential. No license is granted to use,
copy, modify, merge, publish, distribute, sublicense, or sell copies of the
software except as expressly authorized in writing by the copyright holder.
See [LICENSE](./LICENSE).
