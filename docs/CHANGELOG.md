---
project: "minimal-agent"
title: "Changelog"
type: changelog
status: living
created-at: "2026-05-01T00:00:00-0400"
updated-at: "2026-11-01T00:00:00-0400"
format: "Keep a Changelog (pragmatic, date-stamped)"
latest-unreleased:
  - id: "2026-11-01-resume-event-log-null"
    type: feat
    status: landed
    detail: "runtime.resumeSession takes eventLogPath: null to keep the event log in memory only (no <id>.events.jsonl sidecar). The CLI --resume uses it (S50, WP-17)"
  - id: "2026-11-01-manifest-split-headless"
    type: refactor
    status: landed
    detail: "BREAKING (S31): manifests get a headless block (tools, modes, events, hooks, promptFragments, commands, hostModes, setup, replayRenderers, turnAttachments) and a ui block. Core loads headless only and ignores ui. Legacy flat manifests load through src/plugins/manifest-legacy.ts with one notice for flat UI fields (deleted in S41). ManifestFile.tuis is now tools; ManifestFile.liveAreaSlots, LoadedPlugin.liveAreaSlots, and PluginLoader.getLiveAreaSlots are removed (the terminal host loads ui blocks); new PluginLoader.loadedPackages(). Core no longer sets TUI_PLUGIN_PROTOCOL or MINIMAL_AGENT_PALETTE; hosts pass PluginLoaderOptions.handlerEnv. New plugin-api names: ToolTrigger, ToolHandlerContext, ToolHandlerResult, ToolHandler, TerminalUiCapability, ManifestUiBlock, LiveAreaHandlerContext.tui"
  - id: "2026-11-01-plugin-diagnostics-injected"
    type: refactor
    status: landed
    detail: "S20: the 13 plugin-host diag sites use injected handles; the global diag inventory is empty. PluginLoaderOptions.diagnostics, PluginLoader.attachSessionDiagnostics(scope) and diagnostics(); openAgentCoreSession attaches the session scope, so loader diagnostics during a run reach the session log as ch:diag entries. New Session.diagnostics. parseManifest takes { warn }"
  - id: "2026-11-01-plugin-roots-from-host"
    type: refactor
    status: landed
    detail: "BREAKING (S40): core takes plugin roots as data. PluginLoaderOptions gets roots ({ embedded, user, home, project }, each dir holds package dirs) and loses projectDir and siblingDirs. resolveSiblingPluginRoots and resolveProviderPluginRoots are removed. bootProviderDiscovery takes { roots }. scanPluginCatalog/buildPluginCatalog take PluginRoots. bootHost takes pluginRoots, providerRoots, and pluginSync ({ targetDir, repoUrl }) and loses embeddedDir, projectDir, homeDir, siblingDirs, and skipPluginSync. bootstrapUserPlugins needs repoUrl; DEFAULT_PLUGINS_REPO is removed. New exports: PluginRoots, PluginRootTier, PLUGIN_ROOT_TIERS, providerRootsOf (./host-kit/plugin-loader)"
  - id: "2026-11-01-ui-callbacks-removed"
    type: refactor
    status: landed
    detail: "BREAKING (S36, S37): AgentCore.run and Session.run drop the UI callbacks onThinkingStart, onThinkingChunk, onThinkingStop, onTextStop, onNotice, drainQueuedUserText, onQueueInject, and beforeReflectionCheckpoint. TranscriptSink and AgentCoreConfig.transcriptSink are removed. New opt-in event kinds block_started and block_stopped. SendOptions onThinkingStart/onThinkingStop/onTextStop become onBlockEdge"
  - id: "2026-11-01-print-mode-moved-to-cli"
    type: refactor
    status: landed
    detail: "BREAKING: the ./sdk/print-mode export is removed. The module picks an output mode from CLI flags, so it moved to minimal-agent-cli (src/print-mode.ts). The unused formatCacheLine helper is removed from src/cache/cache.ts"
  - id: "2026-11-01-host-boot"
    type: feat
    status: landed
    detail: "New public subpath ./host-kit/host-boot: bootHost() boots providers, plugins, tools, and auth in the CLI boot order, with no terminal I/O; listBootedModels() returns ModelRow[]; missing plugin node_modules is a diagnostic, not an install (docs/host-boot.md)"
  - id: "2026-11-01-cli-moved-core-is-a-library"
    type: refactor
    status: landed
    detail: "The CLI moved to minimal-agent-cli; core is a library. Core has no bin, no entry point, and no terminal host code"
  - id: "2026-10-31-host-mode-review-fixes"
    type: fix
    status: landed
    detail: "Host mode: getEffort reads the live core, HostSession.run applies turn.willStart, a second signal or the grace period ends the process, --host-mode <id> is not a prompt; setModel accepts [1m] ids; preflight adoption of an unknown id keeps the model and emits a new public TurnNotice variant, model_adopt_failed (./sdk/turn-notice), severity warn"
  - id: "2026-10-31-model-effort-switching"
    type: feat
    status: landed
    detail: "AgentCore.setModel/setEffort/getEffort validate against the model registry (same-provider only); the preflight adoptModelId auto-adoption shares the same checked path and emits a new public TurnNotice variant, model_adopted (./sdk/turn-notice), severity info, on every automatic model change"
  - id: "2026-10-31-engine-writes-closure"
    type: feat
    status: landed
    detail: "No direct writes in engine code (S25), config imports no CLI or UI code (S26), public closure ratchet (S32)"
  - id: "2026-10-31-one-loop-unbounded-run"
    type: feat
    status: landed
    detail: "decideNext stop table, unbounded retry with smart recovery, error classes as data; no round or retry caps"
  - id: "2026-10-31-migration-manifest-timer-inventory"
    type: feat
    status: landed
    detail: "Migration manifest (S7) and core timer inventory (S43) ratchets; dead UI seams removed; docs match the tree"
  - id: "2026-10-31-bun-test-whole-suite"
    type: fix
    status: landed
    detail: "bun test runs the whole suite; a preload makes process.exit throw in tests"
  - id: "2026-10-31-agentcore-one-loop"
    type: refactor
    status: landed
    detail: "Legacy Agent class and bridge loop deleted; AgentCore is the one loop"
  - id: "2026-10-31-core-public-package"
    type: feat
    status: landed
    detail: "Package renamed to @minimal-agent/core with an exports map; plugin-api folded in, no workspace dependency"
  - id: "2026-10-14-prompt-writing-style-audit"
    type: chore
    status: landed
    detail: "Writing-style cleanup of model-facing prose plus prompt-audit rules"
  - id: "2026-10-04-builtin-tool-input-aliases"
    type: fix
    status: landed
    detail: "Read/Write/Edit accept path alias, validate required fields before IO"
  - id: "2026-10-01-compact-provider-preamble-retry-cap"
    type: fix
    status: landed
  - id: "2026-09-15-curl-pipe-installer"
    type: feat
    status: landed
  - id: "2026-09-10-compact-multi-mode"
    type: feat
    status: landed
  - id: "2026-09-02-write-contents-alias"
    type: fix
    status: landed
  - id: "2026-08-31-auth-credential-details"
    type: feat
    status: landed
  - id: "2026-08-21-paste-stacked-ghost-frames"
    type: fix
    status: landed
    commits: ["ff34290"]
  - id: "2026-08-18-http2-stream-aborted-retry"
    type: fix
    status: landed
  - id: "2026-08-18-glob-pattern-alias"
    type: fix
    status: landed
  - id: "2026-08-17-effort-flag-does-not-swallow-fast"
    type: fix
    status: landed
  - id: "2026-08-09-raw-mode-mdstream-fence-paint"
    type: fix
    status: landed
    commits: ["7cf4357"]
  - id: "2026-08-05-husky-commitlint-ci"
    type: chore
    status: landed
    detail: "Husky + Commitlint + CI commitlint job; Actions checkout/upload-artifact v7"
  - id: "2026-08-05-tool-output-mega-line-caps"
    type: fix
    status: landed
  - id: "2026-08-01-resume-credential-pin-provider-scope"
    type: fix
    status: landed
  - id: "2026-07-30-openai-chat-thinking-stop-before-text"
    type: fix
    status: landed
  - id: "2026-07-12-never-give-up-terminal-less-thinking-idle"
    type: fix
    status: shipped
    commits: ["15c295c", "cbcf119", "dc020a2"]
    research: "private/retry-fix/PROGRESS.md"
related:
  - "docs/changes/"
  - "private/retry-fix/PROGRESS.md"
---

# Changelog

All notable changes to this project are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project follows a pragmatic, date-stamped release rhythm. Longer
write-ups live under [`docs/changes/`](changes/); research handoffs under
`private/*/PROGRESS.md` when present.

## [Unreleased]

### Added

- 2026-11-01: `./host-kit/host-boot` (WP-09c). `BootedHost.toolExecutorFor(modelId,
  options?)` makes one tool executor for each session and its model. The model
  id sets the media (vision) context of the tools, and each executor has its
  own feedback tracker. `host.toolExecutor` stays: it is the executor for
  `defaultModelId`. New `HostBootOptions.statusPort` sends the `running_tool`
  status of each tool call to the host. `ToolExecutorForOptions.statusPort`
  replaces it for one executor. `resolveAuth(modelId, providerId?)` takes an
  optional provider id. With it, the boot uses the entry of that provider
  (`findModelForProvider`), not the last provider that registered the id.

- 2026-11-01: `runtime.resumeSession` takes `eventLogPath: null`
  (`ResumeSessionOptions`, S50). With `null`, the resumed session keeps
  its event log in memory only and writes no `<id>.events.jsonl` sidecar.
  The default does not change. The CLI `--resume` uses this, because the
  CLI writes no event sidecar for a new session either.
- 2026-11-01: new event kinds `block_started` and `block_stopped`
  (`./sdk/events`, S36). Each one has `itemType` (`text` or `thinking`)
  and `id`, the per-turn streaming id of the block's deltas. They are
  opt-in like the deltas: a run that sets `emitDeltas` emits them, and
  `Session.run` sets it by default. The json and stream-json routes do not
  pass them, so their output does not change. Hosts with an exhaustive
  `switch` over `AgentEvent` must add the two cases.
- 2026-10-31: hook subscriptions take a new `failClosed` flag
  (`ManifestHookSubscription.failClosed`, `ListenOpts.failClosed`). It
  marks a `chain` hook as an approval gate. When that hook throws,
  rejects, or times out, the chain halts and the action is denied (for
  `tool.willInvoke`: a tool error, the turn continues). Unflagged hooks
  keep the fail-open behavior. `LifecyclePortAdapter` also denies when the
  emit itself fails and a `failClosed` listener is on the channel.
- 2026-10-31: new public `TurnNotice` variant `model_adopt_failed`
  (`./sdk/turn-notice`), severity `warn`. A provider preflight can name a
  model id (`adoptModelId`) that the registry does not know. The core now
  first asks the provider plugin to register the id
  (`registerAdHocModel`). When the id is still unknown, the core keeps the
  current model and effort, emits this notice, and the turn goes on.
  Before, the turn failed. Hosts with an exhaustive `switch` over
  `TurnNotice` must add the new case.
- 2026-10-31: with `--output-format stream-json`, a failure after argv
  parse still ends stdout with machine-readable lines: an `error` line,
  then a `run_finished` line with outcome `failed`. This covers a failed
  session open, a failed `--resume`, a `turn.willStart` halt (code
  `turn.blocked`), and any other fatal error. When the model is known and
  no `session_started` line is on stdout yet, that line comes first. An
  abort gives only `run_finished` with outcome `aborted`. Argv and flag
  errors still go to stderr only. The stderr text, the exit codes, and the
  json and text routes do not change.

- 2026-10-31: `--output-format stream-json` has a new first line,
  `session_started`. Its keys, in order: `type`, `streamVersion` (1),
  `sessionId`, `resumedFrom`, `model`, `provider`, `effort`, `cwd`,
  `version`, `outputFormat`, then the `seq` (0) and `ts` envelope keys.
  Every key is always present: `resumedFrom`, `provider`, `effort`, and
  `version` are `null` when unknown. `resumedFrom` is the source session id
  of a forked `--resume`. Then `sessionId` is the new forked id. It is
  `null` for a fresh run and for `--resume-same-sid`. The CLI writes
  it before it opens the session, so it is on stdout even when the open
  fails. Event lines then start at `seq` 1. It is not an `AgentEvent` kind.
  `src/sdk/events.ts` exports its type as `SessionStartedLine`. Breaking
  for stream-json readers: a reader that expects line 1 to be
  `turn_started` must skip it. `--output-format json` does not change.

- 2026-10-31: `--output-format stream-json` lines gain `sessionId`, `seq`,
  and `ts` keys, after the event keys. `sessionId` is the CLI session id.
  `seq` counts stdout lines from 0, with no gaps. `ts` is epoch
  milliseconds (UTC). `src/sdk/events.ts` exports `serializeStreamJsonLine`,
  `StreamJsonEnvelope`, and `StreamJsonLine`. `--output-format json` does
  not change.

- 2026-10-31: `item_started` carries `input` on a `tool_use` item. It is
  the exact input the model sent. It is a copy, so a sink that changes it
  does not change the history. It has no size cap: a large Write or Edit
  payload appears in full. A persisted runtime session writes every event
  kind to `<sid>.events.jsonl`, so that file now stores each tool input
  three times per call: in the assistant record, in `tool_call`, and in
  `item_started`. Follow-up idea, not done: the core copies the input even
  when no sink takes `item_started` (`agent-core.ts` builds item events
  before the emit filter). A lazy build like `wantsToolOutput`
  (`event-filter.ts`) would skip that copy.

- 2026-10-31: `--output-format stream-json` ends with a `run_finished` line.
  `src/sdk/events.ts` exports `STREAM_JSON_EVENT_KINDS`: the legacy nine
  kinds plus `run_finished`. The line has the run outcome (`completed`,
  `failed`, `aborted`, `waiting`). It is on stdout before the process exits.
  Breaking for stream-json readers: the output has one more line at the end.
  A script that reads the last line as `turn_completed` or `error` must now
  skip `run_finished`. `--output-format json` does not change. It stays on
  `LEGACY_EVENT_KINDS`.

- 2026-10-31: No direct process writes in engine code (S25).
  `src/architecture/no-direct-writes.test.ts` fails on `console.*`,
  `process.stdout.write`, `process.stderr.write`, or `Bun.stdout` /
  `Bun.stderr` in any engine file. The 18 writes in 9 files became
  diagnostics: the `--debug` request dump (`transport.request-dump`), the
  DEBUG login trace (`auth.login`), the config parse error, and the
  preflight adapter failure are Debug severity; the cache anomaly, the
  net-dbg logger failure, the unknown `MINIMAL_AGENT_HTTP3` value, the
  unknown rewind target, and the deprecated `systemPromptAppend` mode
  field are warnings. The scan reuses the SDK boundary scanner's AST pass.

- 2026-10-31: Public closure ratchet (S32).
  `src/architecture/public-closure.test.ts` walks every edge from each
  `exports` entry and checks that no reached file is CLI-side, uses stdio,
  or holds an ANSI escape literal beyond a shrink-only baseline. Today the
  closure has 133 files and 5 baseline entries: four exported plugin-api
  TUI helpers (S33) and `src/input/input-capture-stack.ts` through the
  reflection Esc skip (S30).

- 2026-10-31: One loop with the v2 stop table (S15). `AgentCore.run` asks
  the pure `decideNext` (`src/sdk/stop-policy.ts`) what to do after each
  attempt: 13 rows in a fixed order, outcomes `completed`, `truncated`,
  `failed`, `aborted`, `waiting`. The turn result carries the `outcome`.
  `src/architecture/loop-inventory.test.ts` allows exactly one module that
  sends, runs tools, and repeats.

- 2026-10-31: Unbounded run with smart recovery (S16). Transient errors
  retry forever with exponential backoff, full jitter, and a 60 s ceiling;
  `Retry-After` wins. Each wait emits a `status` event (`retrying`,
  `waiting_for_quota`) and one `api.retry` diagnostic. Recoverable errors
  run one action first (refresh the credential, compact, or wait for the
  quota reset). A permanent error pauses the run: `error` with
  `recoverable: false`, then `status` `waiting_for_host`, and outcome
  `waiting`; the next run resumes the same session. The loop owns the
  retry: the default transport is now `canonicalAttemptFn` (one attempt),
  and `canonicalSendFn` keeps a retry for side calls. The clock is
  injectable (`AgentCoreConfig.retry`).

- 2026-10-31: Error classes as data (S49). `plugin-api/llm/errors` exports
  `ErrorClass` (`transient`, `recoverable`, `permanent`), `RecoveryAction`,
  `parseRetryAfterMs`, and `tagUpstreamError`. `classifyUpstreamError`
  returns the class, and `ProviderError` carries it. The loop decides from
  the class, never from provider strings.

- 2026-10-31: `src/architecture/migration-manifest.json` lists every file in
  the areas that leave or change in the core/CLI split (`src/host`, `src/ui`,
  `src/input`, `src/terminal`, `src/cli`, `src/modes`, `src/plugins/host`,
  `src/e2e`, the entry point, the abort bus, the stderr log sink, and
  safe-stdout). Each row says `core-engine`, `cli`, or `delete` and gives a
  target path. CLI rows list the core files they import.
  `migration-manifest.test.ts` fails on a file with no row, a row for a
  missing file, or stale imports.

- 2026-10-31: Core timer inventory. `src/architecture/timer-inventory.ts`
  lists every non-test core file that calls `setTimeout` or `setInterval`,
  with its call count, owner (`core` or `cli`), and reason. 26 files today:
  the HTTP/2 transport and the stream watchdog, plus 24 others.
  `timer-inventory.test.ts` is a ratchet: counts only go down.

- 2026-10-31: The package is `@minimal-agent/core` and has an `exports` map,
  the public contract for hosts and plugins. It exports `./sdk/events`,
  `./sdk/lifecycle`, `./sdk/ports`, `./sdk/agent-core`, and every former
  plugin-api subpath as `./plugin-api/*`. `plugin-api/` is now a folder inside
  the core package, not a `workspace:*` package, so `dependencies` is empty
  and a git install of core resolves. Core imports plugin-api through the
  same self-reference consumers use. `src/architecture/public-api.test.ts`
  freezes the export list. The plugin-api leaf scan now also flags a
  self-import of any core subpath outside plugin-api.

- 2026-09-15 (this session): `scripts/install.sh` one-liner installer. Clones
  (or reuses) source, links `minimal-agent` and `ma` onto
  `~/.minimal-agent/bin` plus `~/.local/bin`, never runs `bun install`.
  `bunx github:...` is documented as a dead end (`workspace:*` plus
  toolchain). Coverage in `src/e2e/install-sh.test.ts`. The `minimal-agent`
  wrapper now resolves PATH symlinks to the checkout.

- 2026-09-10 (this session): feat: multi-mode compact. `/compact` takes
  `[mode] [tail=N] [focus="..."]`. Modes are `remote|tail|local|fork`.
  Defaults are mode `local` and tail `6`. Manual compact blocks. Auto compact
  on context exceed tries remote first, else local. Local summaries use a
  fixed 7-heading template. README documents the syntax under Sessions.

- 2026-08-31 (this session): `AuthCredentialInfo` gains optional provider-owned
  `details` rows (`AuthCredentialDetail`: key/label/value). Host `auth-status`
  renders them verbatim after the built-in metadata lines so providers can
  surface display-safe identity/quota diagnostics without the host interpreting
  secret bags. Coverage in `auth-status.test.ts`.

### Changed

- 2026-11-01: breaking change on `./host-kit/modes`. `ModeManager`
  returns host-neutral style data, not SGR strings (rule 14).
  `resolved()`, `resolvedForId()`, and `statusStyle()` return the new
  `ModeStyle` / `ModeSurfaceStyle` types. A surface holds `fg` and `bg`
  as a `ModeColor` (`token`, `hex`, `ansi256`) or `null`, plus `bold` and
  `dim`. A token is a palette name (`blue`, `pink`, ...) or a semantic
  token (`accent`, `accent-soft`, `brand`, `danger`, `muted`). The host
  maps tokens to its output. The CLI maps them to SGR in its
  `terminal-kit/mode-style.ts`. The third constructor argument is now
  `theme?: ThemeKey` (it was `env?: StyleEnv`). `promptPrefix()` and
  `promptPrefixForId()` are removed from `ModeManager`, and
  `ModeProviderAdapter.promptPrefix()` is removed. The host builds the
  prompt prefix. `ModeProvider.promptPrefix` is deprecated. New exports:
  `resolveModeStyleTokens`, `styleFromLegacyColor`, `detectModeTheme`,
  `MODE_COLOR_NAMES`, `MODE_SEMANTIC_TOKENS`. The manifest `style` and
  `color` fields do not change. The internal bridge
  `src/internal/terminal-render/mode-style.ts` is deleted.
- 2026-10-31: Config and logging import no CLI or UI code (S26). The env
  and config key names for system-prompt overrides are core config data
  (`src/config/system-prompt-override-keys.ts`); the CLI flag names stay in
  `src/cli/system-prompt-override-flags.ts`. `SubmittedAtStyle` and
  `normalizeSubmittedAtStyle` moved from `src/ui/` into `src/config/config.ts`.
  The net-dbg logger reads neither env nor config: the network client
  resolves the level once and passes it to `createNetDebugObserver({ enabled })`.

- 2026-10-31: `--debug` (`DEBUG=1`) output is Debug-severity diagnostics, not
  stderr text. It lands in the session log file, and on stderr with
  `MINIMAL_AGENT_LOG_STDERR=1`. `MINIMAL_AGENT_PREFLIGHT_DEBUG` is gone: a
  preflight adapter failure is always a Debug diagnostic.

- 2026-10-31: `AgentCore` is the one agent loop. The legacy `Agent` class
  (`src/agent/agent.ts`), its re-exports, and the unused legacy-to-canonical
  bridge loop in `adapter-legacy.ts` are deleted. Engine tests build
  `AgentCore` through the production factory with `buildTestCore`
  (`src/test-utils/test-core.ts`).

- 2026-10-31: Docs and metadata match the tree. The package description
  says "agent engine", not "terminal agent harness". The provider standards
  use `ma-llm-<name>-plugin` paths in the plugins repo. The provider
  decoupling doc reports current ratchet counts (I2 and I3 baselines empty)
  and records the plugin move (Wave G) as done. README and AGENTS.md drop the
  removed legacy transport env var and the old in-core provider plugin layout.

### Removed

- 2026-11-01: BREAKING (S37). The UI callbacks are removed from
  `AgentCore.run` and `Session.run`. Use events and ports instead:
  - `onThinkingChunk`: the `thinking_delta` event.
  - `onThinkingStart`, `onThinkingStop`, `onTextStop`: the new
    `block_started` and `block_stopped` events.
  - `onNotice`: the `notice` event. The core no longer writes a plain
    notice line to a transcript. A text host prints
    `formatTurnNoticePlain(event.notice)` itself.
  - `drainQueuedUserText`, `onQueueInject`: the `inputQueue` host port
    (`take`, `injected`), given when the session or core is built. The
    loop also emits a `user_message` event with `queued: true`.
  - `beforeReflectionCheckpoint`: the `reflectionGate` host port.
  `TranscriptSink`, `TranscriptLine`, and `AgentCoreConfig.transcriptSink`
  are removed. `RuntimeCoreDeps.transcriptSink` is removed. The per-run
  `askUser` option stays. On `SendOptions`, `onThinkingStart`,
  `onThinkingStop`, and `onTextStop` are replaced by one
  `onBlockEdge(edge)` hook that `AgentCore` sets itself. A host value for
  it is dropped. The internal `truncationNotice` prompt helper is renamed
  `truncatedOutputNotice`.
- 2026-11-01: The CLI moved to minimal-agent-cli. Core is a library. S34
  Phase 4 deleted the terminal host from core: `src/index.ts`, the
  `minimal-agent` wrapper, `package.json#bin`, the `start` script, and the
  `src/host`, `src/cli`, `src/ui`, `src/input`, `src/terminal`, and
  `src/e2e` folders. It also deleted the abort bus, the stderr log sink,
  safe-stdout, three of the four `src/internal/terminal-render` bridge
  files, `src/test-utils/fake-terminal.ts`, and `src/session/draft-store.ts`
  (no importer in core or the CLI). The migration manifest and its scan and
  test are gone too: nothing leaves core now. The core-to-host import
  ratchet is now 0 with no exception. The direct-write ratchet has no allow
  list, and the timer inventory has no `cli` entries.

- 2026-10-31: Round and retry caps. `maxToolRounds`, the tools-disabled
  wrap-up turn, the `tool_rounds_capped` notice, and the emergency-cap
  prompts are gone. The compact summary no longer stops after 3 transport
  retries. The deprecated terminal-less retry sentinels are deleted. The
  two D20 continuation guards stay; they end a turn `truncated`, not the
  run. `simple-send.ts` is gone (`AgentCore.send` sends one attempt itself),
  and the dead `terminalMetrics` port is removed.

- 2026-10-31: Dead UI seams and helpers: `src/sdk/ansi.ts` (no importers),
  the `TranscriptFormatter` and `ToolTranscriptParts` port types (no
  implementer), and `markErrorAsDiagEmitted` / `isErrorDiagEmitted` (never
  set, so the two REPL checks that read them were always false). Output does
  not change.

- 2026-10-14: Model-facing prose follows the writing-style rules. Prompts,
  tool descriptions, truncation notices, compact notes, and loader/error
  strings drop semicolons, em/en dashes, unicode arrows and ellipses, and
  filler words. The compact prompt drops shout-case. `truncationNotice` now
  reads `..., N/M lines, cut at byte ...` (comma, not semicolon). No behavior
  change. `src/prompts/prompt-audit.test.ts` now enforces no semicolons, no
  emoji, no sycophancy or signposting phrases, and no `---` before a heading.
  It masks code fences, inline code, and URLs first. Work by Edward
  (`7ec3d118`).

### Fixed

- 2026-11-01: net-dbg `warnLoggerErrorOnce` latched once for each process. So
  only the first session that had a logger failure got the warning. The latch
  is now per diagnostics handle. Each session handle gets one warning (WP-09c).

- 2026-10-31: host mode (`--host-mode <id>`) review fixes.
  `HostRuntime.getEffort` reads the live session after `setModel` resets
  the effort (before, it showed the stale boot value).
  `HostSession.run` applies the `turn.willStart` chain like the one-shot
  run. A halting hook stops the turn with the `turn.blocked` error.
  A second `SIGINT`/`SIGTERM`, or no end 5 s after the first, now ends
  the process, so a stuck entry cannot block shutdown. The `<id>` after
  `--host-mode`, and every later arg, is no longer read as a prompt.
- 2026-10-31: `AgentCore.setModel` accepts an id with a `[1m]` / `[2m]`
  suffix. It looks up the base id and stores the raw id. Before, it threw
  "unknown model", also on a re-select of the current `[1m]` model.
- 2026-10-31: stream-json exits through `process.exitCode`, so a slow pipe
  reader keeps the last lines. On a paused or failed run, the event-stream
  route called `process.exit(1)` right after the last line. With a slow
  reader, Bun dropped the queued tail, including `run_finished`: measured
  5 of 5 runs at 1 MB and at 4 MB, 0 of 5 at 70 KB. The route now sets the
  exit code and returns, and the process ends by itself with code 1. The
  json route uses the same path. The text route does not change.
  `main().catch` in `src/index.ts` still calls `process.exit(1)` after
  writing the failure lines. Those lines are small, but large output
  written before such a failure keeps the same risk. A follow-up covers it.

- 2026-10-31: a non-interactive `--resume` no longer prints the human
  resume header and history replay to stdout. The old check matched only
  the literal `--prompt` flag, so a positional prompt or `-` (stdin) still
  printed them before the first JSON line of a stream-json run. The check
  now reads the parsed prompt source, the same value that picks the REPL
  path. The interactive resume does not change.

- 2026-10-31: `bun test` runs the whole suite. `EditorController` quit paths
  called `process.exit(0)`, which ended `bun test` early with exit 0, so CI
  reported green on a partial run. Quit paths now call an injectable
  `exitFn`, and `bunfig.toml` preloads `src/test-utils/guard-process-exit.ts`,
  which makes a direct `process.exit` throw inside tests.

- 2026-10-04: Built-in tools accept Cursor-shaped `path` (Read/Write/Edit) and
  still reject missing or mistyped required fields before filesystem, locks,
  mode, or hooks run. Canonical `file_path` / `content` win over aliases.
  Invalid canonical values do not fall through. Write still keeps the
  `contents` alias and Glob still keeps `glob_pattern` / `target_directory`.
  Plugin and custom tools are not remapped. File-lock wiring moved to
  `src/tools/file-lock.ts` so `tools.ts` stays under the line cap. Coverage in
  `src/tools/tool-input.test.ts`. Work by George (`3c3002a8`).

- 2026-10-01: `/compact` no longer hangs on Anthropic OAuth (plan) auth.
  Found by Janice (`9f031663`), fixed by Debra (`d339b433`).
  - Root cause: local and remote compaction sent a bare summary system prompt.
    Plan auth needs the provider's billing and Claude Code identity preamble,
    so Anthropic answered a fake `rate_limit_error` 429. Compact retried tagged
    transport errors forever, so `/compact` hung on the slow backoff curve.
  - Fix: build the compact `system` through the active provider plugin's
    `resolveSystemPrompt`, the same path live turns use. Cap tagged transport
    retries in the local summary at 3, then fall back to the stub checkpoint.
  - Coverage in `src/agent/run-compact.test.ts`.

- 2026-09-15 (this session): system-prompt resolution is scoped to the
  selected provider. Bare model ids claimed by several providers (e.g.
  `claude-opus-5` by anthropic and opencode-zen) used the global
  last-write-wins entry, so the wrong plugin hook ran and the Anthropic
  billing preamble never shipped. OAuth then got a bare 429. Fix threads
  `providerId` through `resolveSystemPromptForModel` (agent, agent-core,
  startup hashes) with global fallback. Coverage in `system-prompt.test.ts`.

- 2026-09-02 (this session): Write accepts Cursor-shaped alias `contents` for
  `content` and rejects a missing or non-string body with a field error instead
  of `Bun.write(...): expects a Blob-y thing to write`. Empty `content` still
  creates an empty file. Replay diffs (`deriveWriteDisplay`) resolve through
  the same seam. Coverage in `write-input.test.ts`.

- 2026-08-21 (this session): Large multi-line pastes no longer stack ghost
  editor frames (`ASK ❯ ─── ^ N more lines` rows) into scrollback. Two
  defects compounded: the renderer wrapped content at `output.columns`
  while the compositor's erase walk-up re-measured at its own
  `effectiveColumns()` (which falls back to `$COLUMNS`), so PTY wrappers
  with broken WINSZ propagation (asciinema, script(1)) desynced erase
  geometry and each repaint committed the previous frame; and every stdin
  chunk of a paste burst painted a full frame synchronously. Fix: the
  controller pins its resolved cols on the compositor (`setDrawColumns`)
  as the single source of truth, and paste bursts coalesce to one trailing
  repaint. Regression coverage at unit level (FakeTerminal scrollback,
  env-fallback + cols-disagreement seams) and integration level (real
  `Bun.Terminal` PTY with disagreeing COLUMNS). Commit `ff34290`.

- 2026-08-18 (this session): Peer HTTP/2 `RST_STREAM` (`HTTP/2 stream aborted`)
  is tagged `network_error` and retried instead of stopping the turn. Cursor
  bidi keep-open streams hit Node's `aborted` event; that throw was untagged,
  so `withRetry` treated it as a bug. User `AbortError` still propagates.

- 2026-08-18 (this session): Glob accepts Cursor-shaped aliases (`glob_pattern`,
  `target_directory`) and rejects a missing or non-string pattern with a
  field error instead of `Glob.constructor: first argument is not a string`.

- 2026-08-17 (this session): `--effort --fast` no longer treats `"--fast"` as
  the effort level (`effort "--fast" is not supported`). `--effort` now
  requires `low|medium|high|xhigh`; a following flag errors with
  `Got "--fast"` and hints `--effort <level> --fast`. `--fast` stays an
  independent speed flag.

- 2026-08-13 (this session): Host-owned editor picker regression coverage now
  matches the Picker primitive's violet `▌` selection marker, keeping the new
  prompt/history overlay tests aligned with the shared queue-style rendering.

### Fix: Human-paced Escape gestures and queue-style pickers

---
id: "2026-08-10-escape-picker-interactions"
type: fix
status: landed
created-at: "2026-08-10T08:31:42-0400"
updated-at: "2026-08-10T08:31:42-0400"
---

Double Escape now permits a human-paced 500ms interval while preserving the
single-Escape abort route. Generic picker selections reuse the queue's dark
violet full-width bar, violet marker, and high-contrast text.

### Fix: mdstream fence bodies invisible on raw-mode TTYs

---
id: "2026-08-09-raw-mode-mdstream-fence-paint"
type: fix
status: landed
commits: ["7cf4357"]
created-at: "2026-08-09T17:01:24-0400"
updated-at: "2026-08-09T17:03:59-0400"
---

Raw-mode stdin clears `ONLCR`, so mdstream's bare `\n` left the cursor mid-row
after styled fence lines and painted the next border (or the next line) at the
wrong column: empty `── bash ──` boxes with the body seemingly missing.
`Compositor.writeStream` / `flushStream` now normalize LF → CRLF on TTY writes,
treat mdstream's `\r\x1b[K` erase as a redraw clear for `streamCol`, and the
REPL formatter sink keeps one structural trailing newline with the chunk body
(only extra blank separators stay held). Regression coverage in
`compositor-mdstream.test.ts` / `compositor.test.ts`. Observed on Judy
`699995c8` (net-dbg and transcript still had the filled fence).

### Feat: Session dump artifact paths

---
id: "2026-08-09-session-dump-artifact-paths"
type: feat
status: landed
created-at: "2026-08-09T20:34:40-0400"
updated-at: "2026-08-09T20:34:40-0400"
---

`--dump-paths` reports the computed transcript, session sidecar, blob, index, and
network-debug paths for a saved session without changing the default transcript
format. Path resolution follows `MINIMAL_AGENT_HOME` and reports artifact status.

### Feat: MA-394837 agent loop SDK refactor enabling wave

---
id: "2026-08-07-ma-394837-sdk-refactor-enabling-wave"
type: feat
status: landed
commits: ["9596da8", "0bf68cc"]
created-at: "2026-08-07T13:45:26-0400"
updated-at: "2026-08-07T13:45:26-0400"
---

Repointed production imports off the legacy `agent.ts` barrel onto SDK owners
(`runRepl`, ANSI `c`, tool-lifecycle payloads), extracted
`src/sdk/conversation-history.ts` and `src/sdk/tool-lifecycle.ts`, added the
TypeScript-7 AST `sdk-port-boundaries` scanner (genuine-Node child with
NODE=bun rejection; exported-but-explicitly-unstable `typescript/unstable/*`
exact-pinned to 7.0.2), and characterized `InteractiveSession` reflection /
transcript seams. Core README reframed as presentation-free SDK; the terminal
client is being moved to `minimal-agent-cli` (transitional entrypoint until
Program 3B cutover). Follow-ups before merge (file-tracking lane): recordedAt-vs-file-order
replay, same-ms mtimeNs detection.

### Chore: Husky, Commitlint, and CI Action bumps

---
id: "2026-08-05-husky-commitlint-ci"
type: chore
status: landed
created-at: "2026-08-05T11:30:00-0400"
updated-at: "2026-08-05T11:30:00-0400"
---

Conventional Commits enforced locally via Husky `commit-msg` → Commitlint
(`commitlint.config.js`, `prepare` → `husky`) and in GitHub Actions via a
`commitlint` job (`bun run commitlint:last` on push; PR range lint). The same
hook runs agent-gated `scripts/check-agent-coauthor.sh` when
`MINIMAL_AGENT_SESSION_ID` is set (humans unaffected). Workflows use
`actions/checkout@v7` and `actions/upload-artifact@v7`; install steps set
`HUSKY=0`.

### Fix: Tool output mega-line / TUI flood caps

---
id: "2026-08-05-tool-output-mega-line-caps"
type: fix
status: landed
created-at: "2026-08-05T11:00:00-0400"
updated-at: "2026-08-05T11:00:00-0400"
---

Hardens buffer, model, blob, and TUI layers against single mega-lines
(minified bundles). Bash/Grep drain 512 KiB, universal per-line clamp
8,192 chars, `_raw` blob 256 KB, TUI preview width 200, streamed tail
never word-wraps raw mega-lines. Read image/`blocks` paths untouched.

### Fix: Resume credential pin scoped to session provider

---
id: "2026-08-01-resume-credential-pin-provider-scope"
type: fix
status: landed
created-at: "2026-08-01T15:25:00-0400"
updated-at: "2026-08-01T15:35:00-0400"
---

`--resume` no longer applies `meta.credentialName` when the effective
provider differs from the session's `meta.provider`. Credential names are
per-provider store keys; a grok pin on a cursor override previously fataled
with "no credentials for provider cursor" even when cursor was logged in.
Mismatch skips the pin via `diag.warn("auth.resume-pin", …)` (buffered
through the scrollback sink so the startup tree does not tear) and uses
the new provider default. Legacy sessions without `meta.provider` still
reuse the pin. Covered by `resolve-credential-name.test.ts` (pin gate) and
`provider-boot.test.ts` (diag emit, no mid-banner `console.error`).


### Feat: Lifecycle policy seams + InteractiveSession on AgentCore

---
id: "2026-08-01-lifecycle-policy-seams"
type: feat
status: landed
created-at: "2026-08-01T12:00:00-0400"
updated-at: "2026-08-01T12:00:00-0400"
detail: "docs/hooks.md"
---

Typed `PolicyDecision` / `LifecyclePort` (DIP); host `LifecyclePortAdapter`
maps HookBus chain/async channels. Wired emits: `tool.willInvoke` (after mode
gate), `message.willSend`, `tool.didBatch`, compact, session/cwd/instructions,
`subagent.willSpawn`. Production REPL/`--prompt` uses Tier-2
`InteractiveSession` over `AgentCore`. Headless `turn.willStart` parity.
Docs: `docs/hooks.md`. Reference plugin: `ma-policy-ref-plugin` (disabled).

### Fix: OpenAI Chat thinking_stop before first text (orphaned response prefixes)

---
id: "2026-07-30-openai-chat-thinking-stop-before-text"
type: fix
status: landed
created-at: "2026-07-30T18:11:00-0400"
updated-at: "2026-07-30T18:11:00-0400"
---

DeepSeek Chat Completions transition chunks carry both the first visible token
and `reasoning_content: null` (e.g. `content:"Pre"`). The translator emitted
`text_delta` before `thinking_stop`, so the REPL's `onThinkingStop` blank-line
separator landed mid-word — orphaned bright prefixes (`Pre` / `Plug` / `All`)
in scrollback while JSONL stayed correct (session `a37f1f39`).

Fix: handle reasoning before text; close any open thinking block before
`text_start` / tool-call deltas (same order as Ollama). Canonical
`plugin-api/src/llm/openai-chat.ts`; plugins vendored copies synced.
Regression tests in `openai-chat.test.ts` + fixture order assert.


### Fix: Grok false mid-stream `stream_idle` from billing / shared request ids

---
id: "2026-07-24-stream-idle-billing-isolation"
type: fix
status: shipped
created-at: "2026-07-24T02:50:00-0400"
updated-at: "2026-07-24T02:55:00-0400"
commits: ["ff4a1ab", "7c91bc7", "bf35061"]
---

Grok OAuth turns often logged mid-stream `stream_idle` ~30s after headers when a
concurrent `GET /v1/billing` shared the LLM stream's request id and lifecycle
hooks — billing JSON ended pre-stream and armed the wrong idle clock. Separate
from real upstream silence (e.g. mid tool-arg pauses), which still trips at 30s.

Fix: request-local lifecycle at the NetworkClient body tap; `bindPrimaryStreamRequest`
gives unique wire ids and attaches activity/watchdog only to the primary stream
(SSE/NDJSON/connect+ at headers, or `llm-stream` policy tag); denylist billing /
OAuth / quota labels; single-fire stall diagnostics; Notice-level retry recovery
so TUI warn slots clear. Mid-stream idle stays 30s (thinking-open 5 min).


### Fix: explicit `protocol: "h2"` NetworkClient routing (Cursor Connect)

---
id: "2026-07-24-explicit-h2-network-routing"
type: fix
status: shipped
created-at: "2026-07-24T02:30:00-0400"
updated-at: "2026-07-24T02:35:00-0400"
---

`NetworkClient.request({ protocol: "h2" })` always selects a registered
`Http2Transport`, even when `MINIMAL_AGENT_TRANSPORT=fetch` makes fetch the
process-wide primary. Without an always-registered h2 map entry, explicit pins
silently fell through to fetch — unusable for Cursor AgentService/Run
Connect/protobuf streaming (Bun fetch is malformed on that stream; host
Http2Transport is node:http2).

Also: `close()` tears down every distinct configured transport (including the
always-on h2 pool); protocol pins and `allowFetchFallback: false` never
fallback to fetch; request `transportHint` reflects the transport that will
actually serve the call (net-dbg accuracy). Focused tests cover pin-under-fetch
and exactly-once multi-transport close.


### Fix: scrub embedded `data:*;base64` URIs in tool text (token waste)

---
id: "2026-07-23-embedded-payload-scrub"
type: fix
status: shipped
created-at: "2026-07-23T16:41:00-0400"
updated-at: "2026-07-23T16:55:00-0400"
---

Whole-body binary-guard does not catch base64 **inside** otherwise-valid UTF-8
(e.g. Fetch markdown with inlined `data:image/png;base64,…`). New pure scrub:

- `src/tools/embedded-payload-scrub.ts` — continuous data-URI base64 above 256
  chars → `<ma::agent::redacted-asset …/>` + `<ma::agent::context-sanitizer …/>`.
- `tool-round` runs scrub **before** transcript paint; pre-scrub body kept for
  blob recovery (`rawForBlob`). Skips `binary: true` and multimodal blocks.
- `session-dump` re-scrubs so `ma sessions dump` no longer prints megabase64.
- Loader max-lines: `pluginToolDefinitionFromTrigger` moved into
  `loader/helpers.ts` (binary opt-in inject stays).

### Fix: withhold binary tool results from model context (opt-in `binary`)

Tools that return PDF/image/zip-like bodies (Fetch `format: original`,
`cat foo.pdf` via Bash, …) no longer dump UTF-8 mojibake into the model.
Core adds a defense-in-depth guard in `tool-round` plus a schema injection
path for tools that declare `mayReturnBinary`:

- `src/tools/binary-guard.ts` — classify bytes/text, format
  `<ma::agent::binary-result …/>`, inject `binary?: boolean` into
  input schemas, base64 opt-in under a 48 KiB raw cap.
- Plugin-api `ManifestTrigger.tool.mayReturnBinary`; loader injects the
  opt-in arg via `getExtraTools()`.
- `tool-round` rewrites binary string content **before** transcript paint
  and **after** blob capture so the annotation carries a real path; media
  `blocks` (Read images) and user-message document uploads are untouched.

### Feat: editor buffer style spans + `turn.willStart` model rewrite seam

---
id: "2026-07-15-editor-buffer-styles-turn-will-start"
type: feat
status: in-progress
created-at: "2026-07-15T01:45:31-0400"
updated-at: "2026-07-15T01:45:31-0400"
---

Host support for live input highlights and dual-representation user text
(e.g. intercom `@`-mentions):

- **`editor.buffer.styles` channel** (`broadcast-sync`): plugins emit
  `{spans: [{start, end, style}]}` with code-point offsets into
  `buf.toString()` (`\n` counts as 1). Host calls
  `EditorController.setBufferStyles`. Empty spans clear.
- **`EditorRenderer`**: optional `styles` / `setStyles` paint SGR around
  matching ranges without shifting cursor or wrap math. Styles bake into
  submit `commitLines` so scrollback keeps the highlight.
- **`turn.willStart` chain** (payload `{text}`): REPL queue-drain emits
  before `agent.run(text)`. Listeners may rewrite model-facing text or
  `{halt: true}` veto. Scrollback still uses original `commitLines`.

First consumer: `ma-intercom-plugin` peer `@`-mentions.

### Fix: never-give-up terminal-less recovery + thinking-aware stream idle (Grok / OpenAI Responses)

---
id: "2026-07-12-never-give-up-terminal-less-thinking-idle"
type: fix
status: shipped
created-at: "2026-07-12T13:34:39-0400"
updated-at: "2026-07-12T16:40:00-0400"
incidents: ["523dba62", "113921b7"]
commits: ["15c295c", "cbcf119", "dc020a2"]
research: "private/retry-fix/PROGRESS.md"
agents: ["ba7cd4f2", "97596567", "ce0e0589", "842604fe", "f61fc420", "106c4c8c"]
---

Grok high-effort reasoning streams that paused more than ~30s mid-think were
idle-aborted by the provider-neutral watchdog, then mis-tagged as
`stream_closed_without_terminal` when the aborted body drained without a
terminal SSE event. The post-`15c295c` / `cbcf119` policy then took **one**
near-zero pre-effect transport retry and **`failTurn`**, hard-stopping the
agent with `OpenAI Responses stream closed without a terminal event
(truncated)` (session `113921b7`, ~33s elapsed, `saw-reasoning: true`,
`completedToolCalls: 0`). That violated the harness principle that multi-day
agentic runs must outlive transient transport EOF without a human re-prompt.

**Watchdog** (`src/llm/transport/watchdog.ts`):

- While a thinking/reasoning block is open, idle budget is **5 minutes**
  (`DEFAULT_THINKING_IDLE_TIMEOUT_MS`), not the ordinary 30s
  `streamIdleTimeoutMs`. After `thinking_stop`, the ordinary idle applies again.
- If the watchdog has already set an abort reason (`stream_idle` /
  `attempt_too_long`), it **throws that tagged error and does not yield** any
  further events — so a synthetic adapter `stream_closed_without_terminal` on
  quiet drain cannot replace a real idle classification. Idle stalls stay on
  the forever **fast** retry curve.

**Pre-effect terminal-less policy** (`attempt-progress.ts` + `retry.ts`):

- **No completed tools** (empty or mid-reasoning / mid-stream with no closed
  tool_use): retry **forever** with polite capped exponential backoff (max
  5 min). Empty closes use a short base; midstream (saw reasoning or text)
  uses a multi-second base with a **≥1s floor** so the first retry cannot
  collapse to `after 0.0s` thrash. Only the caller's AbortSignal (Esc) stops
  the loop — no `failTurn` budget.
- **≥1 completed tool**: still **never re-POST** the same request body
  (`continueTurn` / bridge salvage). That remains the side-effect safety
  boundary from `15c295c`.
- Partial-text salvage and one local agent continuation from `cbcf119` are
  unchanged (bridge returns `end_turn` with preserved text when `sawText`
  without throwing into `withRetry`).

Diag curves: `terminal-less-empty` and `terminal-less-midstream` (replacing
the old one-shot `terminal-less-bounded` + `api.retry-terminal-less-stop`
fail path for pre-effect closes).

**Commits:** `15c295c` (post-tool salvage), `cbcf119` (mid-text continuation),
`dc020a2` (this never-give-up + thinking-idle fix).
Research handoff: `private/retry-fix/PROGRESS.md`. Restart the running agent
process to pick up the binary.

### Feature: AGENTS.md auto-load (`agents-md` plugin + `--no-agents-md`)

First-party plugin `ma-agents-md-plugin` (extended plugins repo) now loads
[AGENTS.md](https://agents.md) into the system prompt at session start: global
from the resolved agent home (`MINIMAL_AGENT_HOME/AGENTS.md`), then project from
`<cwd>/AGENTS.md`. Injection uses the standard `promptFragments` path, so both
the legacy `Agent` loop and modern `AgentCore` (`PromptContributorAdapter`)
receive it. Core adds a convenience disable flag:

- `--no-agents-md` / `--no-agents` (aliases for `--disable-plugin agents-md`)
- `MINIMAL_AGENT_NO_AGENTS_MD=1`

Also documented in `--help`. Config: `plugins["agents-md"].enabled = false` or
per-source `global` / `project` / `maxBytes`.

### Feature: system-prompt overrides (`--system-*` flags, env, config)

Every model-facing part of the system prompt can now be replaced or omitted at
startup: the whole core prompt (`--system-prompt`), the neutral identity, the
base instructions, the loop-safety paragraph, the tool-output-conventions
paragraph, the session-context block (plugin prompts), and the provider preamble.
Each part has a `--system-<part>` (inline text), `--system-<part>-file` (path),
and `--no-system-<part>` (omit) form; an empty string also means omit. The same
parts are configurable via `systemPrompt.*` in `config.jsonc` (a `false`/`null`
value means omit, a string means replace, a `*File` key names a file) and via
`MINIMAL_AGENT_SYSTEM_*` env vars. Precedence is CLI > env > config > default.

The design is a single shared tri-state override model
(`src/llm/system-prompt-overrides.ts`: `default | replace | omit`) resolved once
at startup and threaded identically into the legacy `Agent`, the modern
`AgentCore`, and the resume-drift `computeStartupHashes` — applied in exactly one
place (`resolveSystemPromptForModel` + `buildInstructionsBlockText`), so both
runtimes and the hash stay byte-consistent. With no overrides, the output is
byte-identical to before (cache-key stable). Safety: the provider preamble is
server-validated on some plans (Anthropic OAuth), so replacing/omitting it is
refused unless `--unsafe-system-prompt-overrides` is passed; conflicting flags
and missing `--system-*-file` paths fail fast at startup with exit 2; and
`--system-prompt` replacing the whole body ignores the individual part overrides
(the provider preamble is unaffected). No model-facing prose is hardcoded in
TypeScript — only flag names, keys, and error strings.

### Feature: `--output-format {text,json,stream-json}` on the modern agent core

Non-interactive runs (`--prompt`, `-`, a bare positional) can now select an
output format explicitly. `text` (the default) is unchanged: human progress to
stderr, the final answer to stdout when piped. `json` and `stream-json` both
drive the port-injected `AgentCore` and emit its structured `AgentEvent` stream
as JSON Lines on stdout (`turn_started` → `item_started` → `item_completed` →
`turn_completed`, with `tool_result` carrying the `tool_result.id ===
item_started.id` join for tool turns). `json` is buffered; `stream-json` flushes
each event live and additionally emits token-level `text_delta` and
`thinking_delta` events as the model streams.

`--json` is now a documented alias for `--output-format json`. This changes its
wire output: it previously emitted a single synthetic final-answer line
(`item_completed` with id `"final"`); it now emits the full event stream, where
the answer is the real `item_completed` (itemType `text`) followed by
`turn_completed`. A consumer that read the last line for the answer should
instead take the `item_completed` text event (or the terminal `turn_completed`
for stop reason + usage). `--output-schema` enforcement is unchanged and stays
on the buffered validate-before-stdout path.

### Architecture: provider-decoupling ratchet + first cleanups

New fitness test (`src/architecture.provider-decoupling.test.ts`) enforces
the layering rule: provider-specific code (names, model ids, wire details)
lives in `plugins/<provider>/`, never `src/` core — comments may reference
providers, code may not. Violations must match a frozen, shrink-only
baseline, so new leaks fail CI immediately and cleanups must ratchet the
baseline down in the same commit. First cleanups shipped behind it:
Anthropic media limits moved behind the `ProviderAdapter.mediaLimits` hook
(core falls back to a neutral conservative floor), `--list-models` went
provider-neutral via the new `ProviderPlugin.listLiveModels` hook, the
beta-flag model gates unified into plugin-owned `beta-gates.ts` (both
transports now share one predicate — the drift class behind the fable-5
context-1m bug), and the tool-output redaction allowlist dropped its
vendor-specific header literal for a neutral session-id pattern.

### Feature: Claude Fable 5 in the model catalog

`claude-fable-5` (the public Mythos-class flagship launched 2026-06-09) is now
registered end-to-end: capabilities (Opus-4.8 twin, 1M context, 128K output,
adaptive thinking, effort up to `max`, no fast tier), flat $10 / $50 pricing,
`[1m]` alias, and the `context-1m-2025-08-07` beta on both transports. The
original symptom was a 429 on every OAuth request because the unregistered id
dropped the Claude Code preamble.

### Fix: fast-mode is capability-gated on the legacy transport

`speed:"fast"` (sticky `--fast` / `MINIMAL_AGENT_FAST=1`) used to reach the
wire for models with no fast tier (Fable 5, Sonnet, Haiku), which the server
rejects with 429 "Usage credits are required for fast mode". The legacy client
now consults the model registry's `speedFast` capability and drops both the
body field and the `fast-mode-2026-02-01` beta header (with a diagnostic
warning) when unsupported, matching the canonical transport. SessionInfo's
`fast` line now reflects the CLI flag too (the host mirrors the resolved state
into `MINIMAL_AGENT_FAST`) and cross-checks the capability so it never claims
a fast tier the model lacks.

### Build: scope the test gate to first-party source

`bun test` scanned from the repo root, so it descended into the gitignored,
vendored research clones under `private/` (a copy of `gemini-cli` and others)
that ship their own vitest suites and unresolvable dependencies. The gate
counted ~1300 of those as failures even though every first-party test passed.
New `bunfig.toml` sets `test.pathIgnorePatterns` to exclude `private/`,
`research/`, `work/`, `docs/internal/`, `.swarm/`, and `tmp/`, so the gate now
sees only `src/` and `plugins/` (4588 pass, 10 skip). `private/` is also added
explicitly to oxlint's `ignorePatterns`. No first-party code changed.

Also fixed a flaky assertion in `plugins/memory/cli.test.ts`: the `--limit`
test checked the raw list output with `not.toContain("e1")`, but bullet ids are
base36+hex, so `e1` could land inside a randomly generated id and fail the run
only under full-suite timing. The test now asserts on the body column.

### Feature: oversize images auto-fit instead of being rejected

A 4K screenshot used to bounce with a 400 (`image exceeds 5 MB`). Oversize
images are now downscaled and re-encoded to fit the wire budget before sending:
the long edge is capped at 1568px and a quality/scale ladder brings the encoded
bytes under the cap. New `src/media/transform.ts` (`fitImageToBudget`,
`canTransformImages`, `VISION_LONG_EDGE_PX`). `src/media/limits.ts` now measures
the base64-encoded size (`base64EncodedSize`), the real wire weight, for both
the per-item and per-request caps, and `src/media/resolve.ts` runs the fit pass
(`maybeFit`) and reports what it shrank.

### Feature: native clipboard paste (text and image) on Ctrl+V

`src/media/clipboard.ts` was rebuilt on Bun's native clipboard pipeline
(`Bun.Image.fromClipboard`, plus `clipboardText` / `clipboardImageSync` /
`hasClipboardImage`). The editor (`src/editor-controller.ts`) gained a Ctrl+V
handler that pulls system clipboard text, or a clipboard image routed through
the media interceptor into an `[Image #id]` token, even in terminals where
Cmd+V never reaches the process. When no handler is wired, Ctrl+V inserts no raw
control byte.

### Fix: macOS screenshot paths with Unicode spaces no longer shatter

Dropped or pasted screenshot paths like `Screenshot 2026-05-49.35␏PM.png` carry
a narrow no-break space (U+202F) or no-break space (U+00A0). The media
tokenizer and path detection (`src/media/detect.ts`, `ingest.ts`) now preserve
those code points instead of splitting on them. As a backstop, `src/tools.ts`
self-heals a path whose Unicode space was normalized to a plain space
(`resolveWhitespaceConfusablePath`): Read and Edit resolve the real file instead
of returning ENOENT, and Read notes that it resolved the path.

### Fix: connect-phase network failures retry instead of killing the turn

A failure before the first response byte (TCP connect timeout, ECONNRESET, DNS
EAI_AGAIN, HTTP/2 GOAWAY, "socket hang up") used to stop the agent. New
`src/network/transient-error.ts` classifies these as `network_error` and
`withRetry` (`src/llm/transport/retry.ts`) retries them on the fast curve. User
aborts (Ctrl-C) still propagate untouched. `src/client.ts` also now honors
`x-should-retry: false`, so a deterministic 400 (bad request, oversize image)
propagates at once instead of retry-storming.

### Feature: planning guidance in the system prompt

The `tasks` plugin injects a planning fragment (`prompts/planning.md`) that
tells the model to plan and work in phases with tasks and subtasks. It is
self-gated on `tools.userDefined`, so a model without tool support does not get
the guidance. New `plugins/tasks/handlers/planning_fragment.ts`, wired through a
`promptFragments` entry in the manifest.

### Feature: sub-agent result protocol via a tool, plus context-gated tools

A worker now finishes by calling `ReportResult({summary, artifacts?,
incomplete?})` as its final action. The handler (running in the worker process)
writes the result sentinel deterministically with an atomic temp-then-rename, so
the model never hand-rolls a path or JSON. The completion transport is layered,
best to worst: the `ReportResult` tool call, a manual sentinel write, a
distilled final message, then the `incomplete` floor, so a provider without tool
calling still works. When a worker reports findings but a contracted
`expectArtifacts` file is missing, the supervisor keeps the `incomplete` verdict
but salvages the summary onto the status, so `AgentResult` shows the findings
instead of forcing a transcript dive.

This rides a new general loader feature: a tool handler may export
`available(ctx)` to hide itself from the model's tool list for a turn (and drop
its system-prompt section when its whole tool surface is hidden). Dispatch is
not gated, a hidden tool's handler still runs if invoked, so availability
controls advertisement, not execution. `ReportResult` uses it to stay invisible
to the lead (which has no result path) while workers carry it. New
`plugins/sub-agents/lib/report.ts` + `handlers/report_result.ts`,
`available` plumbing in `src/plugins/loader.ts` and `types.ts`.

## 2026-06-04

### Fix: sub-agent workers inherit the lead's model (no silent downgrade)

Delegating to a built-in specialist silently ran the worker on a cheaper model:
`explorer` dropped to Haiku, `worker`/`planner`/`integrator` dropped to Sonnet,
even while the lead was on Opus. The model-precedence order in
`plugins/sub-agents/lib/service.ts` put the provider's per-role recommendation
(scout→Haiku, balanced→Sonnet, deep→Opus) AHEAD of the lead's own model, so the
"inherit the lead's model" path was dead for the specialists, which is most
spawns. The downgrade also made `incomplete · no deliverable` outcomes more
likely, since a weaker worker drowns on deep work.

Fix makes the role-recommendation rung opt-in. New `resolveAutoTier` reads
`MINIMAL_AGENT_SUBAGENT_AUTO_TIER`; `makeRecommendForRole` returns undefined
unless it is `1`, so workers now inherit the lead's model by default. Precedence
(default): per-spawn `model` → `MINIMAL_AGENT_SUBAGENT_MODEL` → lead's live model
→ omit `--model`. With `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1` the provider role
recommendation slots back in just below the env override. An explicit per-spawn
model and the env override always win.

Also corrected the model-facing docs that described the cheap default as
intended (`manifest.json` `model` param description, `PROMPT.md`, library/service
comments) and unwrapped the hard-wrapped worker result-protocol template to save
wire tokens. New tests in `runtime.test.ts` and `handler-deps.test.ts`.

## 2026-05-31

### Chore: clear the `bun run check` gate (lint, biome, refactor)

Drove the full gate back to green with zero warnings on the uncommitted feature
drop (sub-agents, schedule, config/usage/model-info plugins, prompt
markdownization, first-run onboarding, usage tracking).

- **oxlint** (1 error + 3 warnings → 0/0): removed an unnecessary template
  expression in `plugins/schedule/lib/box.ts`; replaced a spread-in-`map` with a
  conditional property assign in `PluginLoader.listCommandInfo`
  (`no-map-spread`); classified `src/plugins/loader.ts` into the existing
  `max-lines` override alongside the other large coordinator files.
- **agent.ts back under the line budget by extraction, not exemption.** The
  per-turn attachment / abort-marker / media-ingest / usage-persistence work
  pushed `src/agent.ts` from passing to 820 counted lines. Following the
  documented split pattern, moved `rollbackPendingTurn` and
  `repairOrphanedToolUse` into a new `src/agent/history-repair.ts` (pure
  functions; the `Agent` methods now delegate), with a focused
  `history-repair.test.ts`.
- **biome import-sort**: fixed the `import { abortBus, type AbortReason }`
  ordering in `src/agent/repl-live-area.ts`.
- Gate result: typecheck, lint (0/0), `format:check`, `biome:check`,
  `docs:check`, and `bun test` (4443 pass / 0 fail) all green.

### Fix: opus-4-8 tool-batch hallucination (gate interleaved-thinking off)

opus-4-8 under the `interleaved-thinking-2025-05-14` beta emitted huge parallel
tool batches whose interleaved thinking reasoned about same-turn tool results
that cannot exist yet (every tool in a turn runs after the turn ends), producing
a self-inflicted "results are stalling / batching" spiral and many duplicate
tool calls. Wire-proven against `.net-dbg` captures; absent on opus-4.7 under the
same beta, so it is a model-behavior change (4.7 -> 4.8), NOT the provider
refactor (the harness delivers every tool result correctly). Fix omits the
interleaved-thinking beta for opus-4-8 only (4.6/4.7 + sonnet keep it); escape
hatch `MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1` (see TODOS.md `T-7c3f02`).

### First-run onboarding: `bunx`-runnable, plugin auto-clone, welcome card

Makes the agent usable on a clean device with no manual install.

- **`bin` field** so it runs through `bunx github:gastonmorixe/minimal-agent`
  (public repos) or `bun add -g "git+https://x-access-token:<TOKEN>@github.com/…"`
  (private). Bun runs the TypeScript source directly: no build step.
- **First-run plugin bootstrap** clones the extended first-party plugins
  (`Fetch`, `Skill`, slash-menu, …) into `~/.minimal-agent/plugins` once. The
  loader gained a fourth root, `user`, with precedence
  `project > home > user > embedded`.
- **Token-aware + safe:** resolves `MINIMAL_AGENT_GITHUB_TOKEN` →
  `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`, injected via an inline git
  credential helper so the token never reaches argv, the clone URL, or the
  cloned `.git/config`. Best-effort: no git / offline / no token degrades to
  the embedded plugins, never crashes.
- **Welcome card** on a cold interactive start frames the one-time setup
  (sign in, fetch mdstream, fetch plugins).
- Controls: `MINIMAL_AGENT_NO_PLUGIN_SYNC=1`, `MINIMAL_AGENT_PLUGINS_REPO`,
  config `pluginSync` / `pluginsRepo`. Verified end-to-end in a clean
  `oven/bun:1.3-debian` container.


### Schedule plugin: TUI redesign + sub-minute intervals

- **New icons.** Replaced the `⏰` color-emoji (which ignored color) and the
  faint `◷` with monochrome, SGR-colorable glyphs: `⧗` (a point in time /
  one-shot) and `⟳` (a recurring loop). Tool-header icons now render bold so
  thin glyphs read at terminal size.
- **Colored boxed output.** `/loop` and `/schedule` confirmations, and the
  `Cron*` tool results, render in the same rounded `╭─ │ ╰─` box the host draws
  around tool calls (header glyph + cadence + timestamp, prompt in the body,
  id + expiry + cancel hint in the footer).
- **Width-aware live-bar footer.** Leads with the soonest task (`⧗` + short id +
  countdown), then lists the other task ids with a `+K` overflow marker;
  degrades to `⧗ next in 26s · N tasks`, then `⧗ N tasks`, then bare `⧗` as the
  terminal narrows. Glyph is gold normally, lime when the soonest task is due
  within a minute.
- **Sub-minute intervals fixed.** `/loop 10s` (and `CronCreate every:"10s"`) no
  longer round up to 1 minute. Cron is minute-granular, so sub-minute cadences
  now run on the dynamic pace with a new `CronEntry.intervalMs` that re-arms
  after each fire (floored at 1s). With the 1-second heartbeat a `10s` loop
  fires about every 10 seconds (a fire still waits for any in-flight turn).
- Model-facing tool-result `content` stays plain text; all color lives in the
  TUI-only surfaces.

## 2026-05-30

### Schedule plugin (`/loop`, `/schedule`, `Cron*` tools)

Run prompts on a schedule, ported from Claude Code's scheduled tasks.

- **Three tools** (`CronCreate`, `CronList`, `CronDelete`) the model drives from
  natural language ("remind me at 3pm", "every 5 minutes check the deploy").
- **Two commands** (`/loop`, `/schedule`) for direct user control.
- **1-second heartbeat** that injects due prompts between turns.
- Tasks persist at `~/.minimal-agent/sessions/<sid>.cron.json` and restore on
  `--resume` (unexpired tasks only).
- Disable with `MINIMAL_AGENT_DISABLE_CRON=1`.

See `docs/changes/2026-05-30-schedule-plugin.md`.

### Sub-agents plugin

Delegate work to background `minimal-agent` workers (`SpawnAgent` and friends),
watch them in a live fleet widget, and fold their distilled results back. Built
on generic seams; the core agent loop never learns the word "sub-agent". Disable
with `MINIMAL_AGENT_DISABLE_SUBAGENTS=1`.

See `docs/changes/2026-05-30-sub-agents.md`.

### Prompts as markdown

Plugin system-prompt fragments and tool descriptions move to markdown, composed
under role-typed `<ma::sys::*>` wrappers.

See `docs/changes/2026-05-30-prompts-as-markdown.md`.

### Tool routing + search directives

