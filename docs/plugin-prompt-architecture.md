# Plugin prompt architecture

This document explains how plugin prose becomes part of the system prompt, and
how the `--no-plugin-prompts` switch stops it. The model never learns the word
"plugin": each contribution arrives as a semantic section of the agent's own
instructions.

## End to end

```
+------------------------------------------+
|          plugin package on disk          |
+------------------------------------------+
                      v
+------------------------------------------+
|        discovery reads PROMPT.md         |    promptFragments run async
+------------------------------------------+    at load, text folded in
                      v
+------------------------------------------+
|        buildBlock builds sections        |<--- pluginPrompts suppression
+------------------------------------------+     drops TEXT only. The plugin
                      v                          still loads, tools stay.
+------------------------------------------+
|        getPromptBlocksAsync memo         |
+------------------------------------------+
                      v
+------------------------------------------+
|        wire system prompt blocks         |
+------------------------------------------+
```

## Load time

Each package under a plugin root gets its manifest parsed. Roots are tiered:
project, then user, then embedded. Two roots that resolve to the
same physical directory are collapsed by realpath, and the higher tier wins.

The prompt body is read once, verbatim:

- The path is `manifest.prompt ?? "./PROMPT.md"`, resolved against the package
  directory (`discoverAndParsePackages` in `src/plugins/loader/discovery.ts`).
- The file is read with `readFileSync` and stored as-is
  (`discoverAndParsePackages` in `src/plugins/loader/discovery.ts`). No templating, no `%%var%%`
  substitution. A placeholder in a plugin `PROMPT.md` stays literal.
- If `manifest.prompt` names a file that is missing, the loader logs a warning
  and the plugin stays silent in the prompt.

The plugin id `prompts` is reserved. A package with that id does not skip with
a log line like other manifest errors: `parseManifest` throws
`ReservedPluginIdError` (`parseManifest` in `src/plugins/manifest.ts`), and discovery rethrows
it (the `ReservedPluginIdError` rethrow in `discoverAndParsePackages`, `src/plugins/loader/discovery.ts`), so the load fails and the process
does not start. The reason is that the user config key `plugins.prompts`
belongs to this feature, and one name cannot mean two things.

## Compose and wire

`buildBlock` turns each accepted package into at most one section
(`PluginLoader.buildBlock` in `src/plugins/loader.ts`). The role and the section name are inferred from
the manifest shape, never from the plugin id:

| Manifest shape | Role | Name source |
| --- | --- | --- |
| declares a mode | `mode` | first mode id |
| exactly one tool | `tool` | that tool name |
| more than one tool | `tool` | slug of the leading H1 or display name |
| only an inline tag | `emit` | that tag |
| PROMPT.md and no fragments | `behavior` | slug of the leading H1 or display name |
| PROMPT.md and fragments | `context` | slug of the leading H1 or display name |

A single leading H1 is stripped, so the plugin does not inject a stray heading
into the prompt outline. Sections sort by role order, then by name, so the
composed block is byte-stable for a given plugin set. That matters because the
system prompt sits on a cache breakpoint.

`getPromptBlocksAsync` returns two slots
(`PluginLoader.getPromptBlocksAsync` in `src/plugins/loader.ts`):

- `afterInstructions`, a plain markdown join with no XML wrapper.
- `sessionContext`, the composed `<ma::sys::ROLE name="...">` sections.

The result is memoized for the loader lifetime
(the `asyncBlocksCache` field in `PluginLoader.getPromptBlocksAsync`, `src/plugins/loader.ts`). Later turns reuse the same bytes. Volatile
content is captured once, at load.

The adapter serves that memoized value synchronously to the agent
(`src/adapters/prompt-contributor-adapter.ts`), and the final wire order is:

1. the instructions block, cached with `scope: "global"`
2. `afterInstructions`, plain markdown
3. `sessionContext`, the wrapped plugin sections

See `buildAgentSystemBody` in `src/llm/system-prompt.ts` for the order.

## Fragments

A manifest can declare `promptFragments`. Each entry names a handler and a
`placement`:

- `sessionContext` (the default): the text is folded into that plugin's own
  section, below its `PROMPT.md` body.
- `afterInstructions`: the text joins the plain markdown slot, unwrapped.

Fragments start at load and run concurrently. Each has a `timeoutMs`, default
2000 ms (`DEFAULT_FRAGMENT_TIMEOUT_MS` in `src/plugins/loader/fragments.ts`). A fragment that exceeds its
timeout, throws, or returns an empty value contributes nothing, and the loader
logs a diagnostic. A slow probe must never block the first turn.

Fragments always run, even when their text is suppressed. A fragment can call
`registerDynamicTools` (the skills plugin does), so skipping the run would
silently remove tools from the model's list. Suppression drops text, not work.

## Suppression

`PluginLoader.load` takes an optional `pluginPrompts`
(`PluginLoaderOptions.pluginPrompts` in `src/plugins/loader.ts`). Its shape is:

```
{ all: boolean, suppress: ReadonlySet<string>, keep: ReadonlySet<string> }
```

The per-id decision runs in this order
(`isPluginPromptSuppressed` in `src/plugins/plugin-prompt-resolution.ts`):

```
                    plugin id

            is the id in keep?                    keep wins over suppress.
                        |                         suppress wins over all.
            -- yes --> KEEP TEXT                  all is the last gate.
      no                |
                        v
            is the id in suppress?

            -- yes --> DROP TEXT
      no                |
                        v
            is all true?

            -- yes --> DROP TEXT
      no                |
                        v
            KEEP TEXT
```

So: keep wins over suppress, and suppress wins over all. A plugin whose text is
dropped still loads, still advertises its tools, and still receives dispatches.
Two call sites apply the check:

- `buildBlock` skips a suppressed id, so its `PROMPT.md` body and its
  `sessionContext` fragment text never reach the model
  (the `isPluginPromptSuppressed` check in `PluginLoader.buildBlock`, `src/plugins/loader.ts`).
- `getPromptBlocksAsync` filters resolved `afterInstructions` fragments by
  plugin id before joining (the `joinAfterInstructions` call in
  `PluginLoader.getPromptBlocksAsync`, `src/plugins/loader.ts`).

Both slots can therefore be `null`, and an empty slot produces no block on the
wire. There is no blanket null: suppression is per id.

The exported default, `NO_PLUGIN_PROMPT_SUPPRESSION`, is a frozen object over
Proxy-backed read-only sets. The proxies throw on `add`, `delete` and `clear`,
because `Object.freeze` does not stop those mutators.

## Precedence

```
  +----------------------------------------------------+
  | tier 3   cli flags    --no-plugin-prompts          | <- highest wins
  +----------------------------------------------------+
                             v
  +----------------------------------------------------+
  | tier 2   env var      MINIMAL_AGENT_PLUGIN_PROMPTS | <- overrides config
  +----------------------------------------------------+
                             v
  +----------------------------------------------------+
  | tier 1   config key   plugins.prompts              | <- overrides default
  +----------------------------------------------------+
                             v
  +----------------------------------------------------+
  | tier 0   default      nothing suppressed           |
  +----------------------------------------------------+

Per plugin id: keep beats suppress beats all.
Lists merge across tiers. A higher tier that names
an id removes it from the other side.
```

Resolution is pure and lives in
`src/plugins/plugin-prompt-resolution.ts` (`resolvePluginPromptSuppression`). It returns the suppression plus
a list of warnings. The CLI boot (`main.ts`) calls it through
`resolvePluginPromptsForBoot` (`minimal-agent-cli/src/cli/plugin-prompts-resolution.ts`),
which reads the config and the env, and passes a warning sink, so a bad env
value reaches the user as a diagnostic. `resolvePluginPromptsForCli` (same file)
is the pure form that the tests drive.

Notes on the tiers:

- Env grammar is `0` or `false` for off, `1` or `true` for on. Any other
  value warns and falls through to config.
- Config accepts a boolean, or an object with only `all`, `keep` and
  `suppress`. An object that carries an `enabled` key is a plugin enable
  block, not this setting, and is ignored here.
- The four CLI flags have unambiguous arity on purpose. The CLI takes a bare
  positional prompt, so an optional-value flag would swallow the prompt text.

## Surfaces

| Surface | Form | Notes |
| --- | --- | --- |
| CLI, all off | `--no-plugin-prompts` | boolean, no value |
| CLI, all on | `--plugin-prompts` | boolean, beats the env var and the config global |
| CLI, per id off | `--no-plugin-prompts-for <ids>` | repeatable, comma list accepted |
| CLI, per id on | `--plugin-prompts-for <ids>` | repeatable, wins over `--no-plugin-prompts` for that id |
| Env | `MINIMAL_AGENT_PLUGIN_PROMPTS` | `0` or `false` off, `1` or `true` on |
| Config | `plugins.prompts` | boolean, or `{ all, keep, suppress }` |
| SDK | `pluginPrompts` on `PluginLoader.load` | a resolved `PluginPromptSuppression` |
| SDK | `pluginPrompts` on `bootHost` | an already-resolved value wins outright (`bootHost` in `src/adapters/host-boot.ts`) |

The host boot resolves from config and env
(the `resolvePluginPromptSuppression` call in `bootHost`, `src/adapters/host-boot.ts`), so a web session or an embedding host gets
the setting from the config file with no argv.

`loadPluginPromptsConfig` reads the key
(`src/config/config.ts`) and is lenient: a missing file, bad JSON or a
wrong type returns `undefined` and never throws.

## Core public surface

The module is published as
`@minimal-agent/core/host/plugin-prompt-resolution` through
`src/host-public/plugin-prompt-resolution.ts` and the `package.json` export
map.

Core keeps TWO extra maps in sync with that export map. Both must move in the
same change:

- `src/plugins/loader/host-core-modules.ts` is generated. Regenerate it with
  `bun run gen:host-core-modules`. `bun run gen:host-core-modules --check`
  fails when it is stale, and so does a test in `host-core-resolver.test.ts`.
- `src/architecture/public-exports.json` is the frozen public list.
  `public-api.test.ts` fails when it disagrees with `package.json`.

A new export that skips either map turns the build red.

## Known gaps

- The CLI pins core by commit. Until core is pushed and the CLI pin is raised,
  a standalone CLI checkout cannot resolve the new subpath. Only the monorepo
  workspace override hides this.
- An unknown key inside `plugins.prompts` is dropped without a diagnostic, so a
  typo silently turns the setting off.
- A reserved plugin id shows as "invalid" rather than "reserved" in the plugin
  help listing.
- Suppression cannot be changed mid session. The blocks are memoized and sit on
  a cache breakpoint, so a restart is required.
- There is no per-plugin opt out for an individual `PROMPT.md` beyond the id
  lists above, and no way to keep tool descriptions while dropping tool prose.
  Tool `description` and `input_schema` are schema, and this switch never
  touches them.
