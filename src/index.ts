#!/usr/bin/env bun
// DO NOT disable max-lines !!!
// It's here for a reason: so I force you to decouple and split files into
// better and smaller chunks. - Gaston

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

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { Agent, c, runRepl } from "./agent/agent.ts"
import { resolveAgentName } from "./agent/agent-name.ts"
import { publishAgentHomeEnv, resolveAgentHome, resolveSessionsDir } from "./agent/agent-paths.ts"
import {
  combineTurnDrains,
  instantiateTurnAttachments,
  parseReplaySidecarTasks,
} from "./agent/turn-attachments.ts"
import { defaultBinDir } from "./binaries/store.ts"
import { diag } from "./bus/diagnostic-bus.ts"
import { setGlobalEventBus } from "./bus/global-bus.ts"
import { extractPromptFromArgs } from "./cli/extract-prompt.ts"
import { resolveInitialModeId } from "./cli/non-interactive-defaults.ts"
import { loadModeUserOverrides, loadPluginEnabledOverrides } from "./config/config.ts"
import { resolveSessionTarget } from "./host/commands/session-index.ts"
import {
  buildResumeHeader,
  replayToScrollback,
  toolDisplaysFromRecords,
  userTimestampsFromRecords,
} from "./host/session-replay.ts"
import { attachStartupDiagnosticSinks } from "./host/startup/diagnostic-sinks.ts"
import { prepareEntrypointArgs } from "./host/startup/entry-args.ts"
import { readEmbeddedPackageVersion } from "./host/startup/help.ts"
import { resolveStartupProviderState, startProviderWarmups } from "./host/startup/provider-boot.ts"
import { bootProviderDiscovery } from "./host/startup/provider-discovery-boot.ts"
import {
  modelHidesReasoning,
  providerWantsQuotaProbe,
  signInStepLabel,
} from "./host/startup/provider-presentation.ts"
import { runNonInteractivePrompt } from "./host/startup/run-non-interactive.ts"
import { runStartupSubcommand } from "./host/startup/run-subcommand.ts"
import { bootSessionStores } from "./host/startup/session-store-boot.ts"
import { computeStartupHashes } from "./host/startup/startup-hashes.ts"
import {
  printStartupConfigRows,
  printTerminalViewportRow,
  publishResolvedRequestEnv,
  validateStartupEffort,
} from "./host/startup/startup-rows.ts"
import { isColdStart, maybeShowFirstRunWelcome } from "./host/ui/chrome/first-run.ts"
import { buildReadyBanner } from "./host/ui/chrome/ready-banner.ts"
import { resolveFormatter } from "./host/ui/formatter/auto.ts"
import type { Spinner } from "./host/ui/spinner/index.ts"
import { getSpinnerPreset, type NamedSpinnerPreset } from "./host/ui/spinner/named-presets.ts"
import { startStartupProgressSpinner } from "./host/ui/startup/progress-spinner.ts"
import {
  closeStartupTree,
  closeStartupTreeWithTools,
  printStartupHeader,
  printStartupRow,
  startStartupRowSpinner,
} from "./host/ui/startup/tree.ts"
import type { StatusSpinnerTheme } from "./host/ui/status/line-renderer.ts"
import { buildModelInfoSnapshot, buildSubagentModelRecommendations } from "./llm/model-info.ts"
import { primeProviderSessionInfo, resolveProviderSessionInfo } from "./llm/provider-session.ts"
import { lastAdvertisedModeFromHistory, ModeManager } from "./modes/modes.ts"
import { defaultNetworkClient } from "./network/index.ts"
import { createAgentContext } from "./plugins/agent-context.ts"
import { bootstrapUserPlugins } from "./plugins/auto-plugins.ts"
import { resolveSiblingPluginRoots } from "./plugins/loader/helpers.ts"
import { PluginLoader } from "./plugins/loader.ts"
import {
  collectFlagValues,
  resolvePluginEnabledOverrides,
} from "./plugins/plugin-enable-resolution.ts"
import { resolveEffectivePlatform } from "./plugins/plugin-platform-resolution.ts"
import { formatQuotaWindows } from "./quota/quota-summary.ts"
import { parseSchemaFile } from "./sdk/output-schema.ts"
import { getSessionId } from "./session/session-id.ts"
import { loadSession } from "./session/session-restore.ts"
import { ToolTimeTracker } from "./tools/tool-time.ts"
import { TOOL_DEFINITIONS } from "./tools/tools.ts"

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
//
// All the side-effecting entry-point argument setup (smart-dash rejection,
// `--help` dispatch, env flag propagation, config load, command planning,
// startup-tree visibility, and early session-id seeding) lives in
// `host/startup/entry-args.ts`. It leans on the pure `cli/*` parsers and keeps
// this file a thin composition root. See that module for the precedence rules.

const entry = prepareEntrypointArgs({
  rawArgv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
})
const { args, userConfig, opts, commandPlan, showHeader: SHOW_HEADER, readFlagValue } = entry
const extractPrompt = entry.extractPrompt
const {
  model,
  provider,
  cliCredentialName,
  listModelsProvider,
  wantJsonOutput,
  outputSchemaPath,
  spinnerName,
  effort,
  effortSource,
  thinkingDisplay,
  speed,
  speedFast,
  serviceTier,
  cacheTtl,
  cacheTtlSource,
  formatterExplicitArg,
  formatterExtraArgs,
  resumeSameArg,
  effectiveResumeArg,
  sessionsQuery,
  usagePeriod,
  dumpArg,
  dumpFormatArg,
} = opts

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
  // Publish the resolved agent home into the environment BEFORE anything else,
  // so every plugin (and subprocess) inherits an authoritative, relocation-
  // correct base path (`MINIMAL_AGENT_HOME`) instead of hardcoding
  // `~/.minimal-agent`. This is the host→plugin "where is my storage" signal
  // (see `src/agent-paths.ts`). Idempotent and override-preserving.
  publishAgentHomeEnv()

  // Register provider plugins by discovery (plugins/llm-*) BEFORE any model
  // resolution (the bootstrap probe + footer + canonical run() all read the
  // registry). Replaces the old static builtin barrel: the entrypoint imports
  // no provider by name. Idempotent; a missing plugins dir yields no providers
  // rather than throwing.
  const srcDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))
  const providerEmbeddedDir = dirname(srcDir)
  // Wave G: provider plugins (provider.json) migrate to the sibling
  // ../minimal-agent-plugins repo alongside manifest plugins. Discover from
  // BOTH the embedded plugins dir and the sibling roots (same resolution the
  // TUI loader uses) so a migrated provider is still found. Embedded wins on
  // id collision during a mid-migration window.
  await bootProviderDiscovery(providerEmbeddedDir)

  // Dispatch one-shot subcommands (dump/sessions/usage/list-*/login/logout/
  // auth-status). Returns true when handled (we return); login/logout/
  // auth-status exit directly. `repoRoot` is computed HERE (this file lives at
  // src/ and can trust import.meta.dirname) and passed in, so the dispatcher
  // never derives fs roots from its own location.
  const handledSubcommand = await runStartupSubcommand({
    commandPlan,
    args,
    dumpArg,
    dumpFormatArg,
    sessionsQuery,
    usagePeriod,
    listModelsProvider,
    repoRoot: dirname(srcDir),
    readFlagValue,
  })
  if (handledSubcommand) return

  // Cold-start detection must happen BEFORE any subsystem creates
  // `~/.minimal-agent` (the file-log sink below does, on its first write).
  // Capture it here so the welcome card and the post-setup hint can both key
  // off a single honest "is this the very first run on this machine" signal.
  const coldStart = isColdStart()

  // First-run welcome card. Interactive cold starts only — a scripted
  // `--prompt` run stays silent. Frames the one-time auto-setup (sign-in,
  // mdstream, plugins) so the spinners that follow read as expected setup.
  // The steps listed mirror exactly what the boot flow does next.
  const firstRunInteractive = process.stdin.isTTY === true && process.stdout.isTTY === true
  if (coldStart && firstRunInteractive && SHOW_HEADER) {
    maybeShowFirstRunWelcome({
      isInteractive: true,
      steps: [
        // Provider-supplied label: names the default provider's displayName,
        // or a neutral "sign in to your account" when none is registered.
        { label: signInStepLabel() },
        { label: `fetch ${c.bold("mdstream")}, the Markdown renderer` },
        {
          label: `fetch the extended plugins ${c.dim("(Fetch, Skill, slash-menu, …)")}`,
        },
      ],
    })
  }

  printStartupHeader()
  printStartupRow("session", c.dim(getSessionId()))

  // Resolve the per-session agent name ONCE, here, and reuse the value
  // for both the startup `name` row below and the env publication further down
  // (the `agent-identity` plugin reads MINIMAL_AGENT_AGENT_NAME). On by
  // default (as if "auto"): every session gets a stable derived name unless
  // the user opts out with an OFF sentinel, in which case the resolver returns
  // undefined and no row is printed. See `src/agent-name.ts` for the
  // resolution priority + the cache rationale.
  const resolvedAgentName = resolveAgentName({
    sessionId: getSessionId(),
    configName: userConfig.agentName,
    envName: process.env.MINIMAL_AGENT_AGENT_NAME,
  })
  if (resolvedAgentName) printStartupRow("name", c.dim(resolvedAgentName))

  // Diagnostic bus: attach the file sink as early as possible so even
  // plugin-load warnings land in `~/.minimal-agent/logs/ma-session-<sid>.log`.
  // The TUI surface attaches later from `runReplLiveArea` (it needs the
  // editor / aggregator). The stderr mirror is opt-in.
  //
  // The scrollback sink is constructed here and kept on a process-scoped
  // variable so we can `startBuffering()` it BEFORE any startup-banner
  // row is drawn and `flushBuffer()` AFTER `closeStartupTree()` commits
  // the final `╰`. Without this two-phase wiring, a plugin-loader (or
  // auth / config) warning emitted mid-banner would tear through the
  // box mid-paint instead of landing cleanly below it with the proper
  // `⚠ warn ╰` chrome.
  // Wire the process-wide diagnostic sinks (file log, global audit log,
  // scrollback, opt-in stderr mirror). Returns the scrollback sink so we can
  // drive its two-phase buffer lifecycle (startBuffering armed inside when
  // SHOW_HEADER; flushBuffer below after closeStartupTree).
  const scrollbackSink = await attachStartupDiagnosticSinks({
    showHeader: SHOW_HEADER,
    env: process.env,
  })

  // Resolve model/provider/auth once, up front. Everything that is
  // provider-specific (startup probe, quota) keys off this so a session
  // started with an explicit provider/model pair never contacts the wrong host.
  // See `host/startup/provider-boot.ts` for the resolution + ad-hoc model
  // registration; it prints the `auth` startup row.
  const providerState = await resolveStartupProviderState({
    opts: { model, provider, cliCredentialName },
    userConfig,
    env: process.env,
  })
  const { selectedModel, selectedModelBase, selectedProviderId, credentialName, auth } =
    providerState

  // Fire-and-forget provider warm-ups (bootstrap overlay probe + session-info
  // prime) for the SELECTED provider only, so a gpt-5.5 session never contacts
  // api.anthropic.com just because the host holds an Anthropic OAuth session.
  // Both self-gate and swallow failures (local pricing stays authoritative).
  startProviderWarmups(providerState)

  // Resolve formatter: explicit --formatter, PATH, cached binary, or auto-download.
  let formatterCmd: string[] | undefined
  if (commandPlan.needsFormatter) {
    const formatterResolution = await resolveFormatter(formatterExplicitArg)
    if (formatterResolution.cmd) {
      formatterCmd = formatterResolution.cmd
      // Append user-supplied extra args (--formatter-args / env / config).
      // Applied here (after resolution) so they ride along regardless of
      // whether the formatter came from PATH, the cache, an auto-download,
      // or an explicit --formatter override.
      if (formatterExtraArgs.length > 0) {
        formatterCmd = [...formatterCmd, ...formatterExtraArgs]
      }
      const extraLabel =
        formatterExtraArgs.length > 0 ? ` ${c.dim(formatterExtraArgs.join(" "))}` : ""
      printStartupRow("formatter", `${c.dim(formatterResolution.label)}${extraLabel}`)
    } else {
      formatterCmd = undefined
      console.error(`  ${c.boldYellow("warn")} ${formatterResolution.warn}`)
    }
  } else {
    formatterCmd = undefined
  }

  // Print the model / service-tier / thinking / effort / cache-ttl banner
  // rows (pure presentation + provenance labels, in host/startup/startup-rows).
  printStartupConfigRows({
    selectedModel,
    speedFast,
    serviceTier,
    thinkingDisplay,
    effort,
    effortSource,
    cacheTtl,
    cacheTtlSource,
  })
  const hidesReasoning = modelHidesReasoning(selectedModel)
  // Fail fast if the resolved effort isn't among the model's declared levels.
  validateStartupEffort(hidesReasoning, selectedModelBase, effort)

  // Terminal viewport row (cols × rows) for the compositor / mdstream.
  printTerminalViewportRow(process.env, process.stdout)

  // Load Plugins from ~/.agents/plugins and <cwd>/plugins.
  // Core tool names must always win over plugin names.
  const coreToolNames = new Set(TOOL_DEFINITIONS.map((t) => t.name))
  const homeDir = process.env.HOME ? join(process.env.HOME, ".agents") : undefined
  // minimal-agent's own per-user plugins root. The first-run bootstrap
  // clones `minimal-agent-plugins` here, so this is where the extended
  // first-party plugins (Fetch, Skill, slash-menu, …) live on an installed
  // box. Sits above embedded built-ins but below the user's hand-curated
  // ~/.agents/plugins and <cwd>/.agents/plugins roots. See `userDir` in
  // PluginLoaderOptions for the precedence rationale.
  const userDir = resolveAgentHome()

  // First-run plugin bootstrap. On a freshly-installed box the extended
  // first-party plugins (Fetch, Skill, slash-menu, …) aren't present; clone
  // them ONCE into `<userDir>/plugins` so the loader (which scans that as the
  // `user` root) picks them up on THIS boot. Best-effort and fully gated:
  //   - skipped entirely in non-interactive runs (--prompt / `-` / piped):
  //     a one-shot scripted call shouldn't reach out to the network or grow
  //     the toolset under the user's feet.
  //   - opt-out via MINIMAL_AGENT_NO_PLUGIN_SYNC=1 or config `pluginSync:false`.
  //   - never throws; a private-repo / offline / no-git box degrades to the
  //     embedded plugins with a quiet startup row.
  if (userDir && SHOW_HEADER) {
    const pluginSyncEnabled =
      process.env.MINIMAL_AGENT_NO_PLUGIN_SYNC === "1" ? false : (userConfig.pluginSync ?? true)
    const pluginsRepo =
      process.env.MINIMAL_AGENT_PLUGINS_REPO?.trim() || userConfig.pluginsRepo || undefined
    const sync = await bootstrapUserPlugins({
      targetDir: join(userDir, "plugins"),
      enabled: pluginSyncEnabled,
      repoUrl: pluginsRepo,
      showSpinner: true,
      spinnerFactory: startStartupProgressSpinner,
    })
    // Only surface a startup row when something meaningful happened: a fresh
    // clone, or a failed/skipped attempt the operator may want to know about.
    // The common steady-state (`present`) and the opt-out (`disabled`) stay
    // silent so the tree doesn't gain a permanent noise row.
    if (sync.status === "cloned") {
      printStartupRow("plugins", `${c.dim("+")} ${c.dim(sync.label)}`)
    } else if (sync.status === "failed" || sync.status === "skipped") {
      // Quiet, non-fatal. Detail lands in the file log via the diagnostic bus
      // (the loader still runs with embedded plugins only).
      diag.notice("plugin-sync", sync.detail ?? sync.label)
    }
  }

  // Embedded plugins ship inside the agent's own checkout: `<repo>/plugins/`.
  // `import.meta.dirname` (Bun + Node 20+) of this file is `<repo>/src`, so
  // climb one level. This makes ask-mode/diff-view/env-info/memory work
  // regardless of the user's cwd, not just when cwd === <repo>.
  const thisFileDir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url))
  const embeddedDir = dirname(thisFileDir)

  // Dev-time sibling plugin repo. In production the `minimal-agent-plugins`
  // repo is git-cloned into `~/.minimal-agent/plugins` (the loader's userDir
  // root), so it loads with no special handling. When running from the
  // monorepo SOURCE, though, that sibling checkout lives next to this repo
  // at `<parent>/minimal-agent-plugins` and is NOT under any scanned root.
  // Compute it and hand it to the loader as a sibling dir (its plugin dirs
  // sit at the repo root, not under a `plugins/` subdir) so first-party
  // plugins load at dev time too. `MINIMAL_AGENT_PLUGIN_SIBLINGS`
  // (colon-separated absolute paths) overrides the default when set. Each
  // candidate is included only when it EXISTS and is a directory.
  const siblingDirs = resolveSiblingPluginRoots(embeddedDir)

  // Construct the single AgentContext shared across every plugin
  // dispatch path (tool handlers, prompt fragments, event subs, hook
  // subs, live-area slots, plus their subprocess counterparts). The
  // loader and the live-area scheduler both receive THIS object so
  // plugins see one consistent identity regardless of dispatch path.
  //
  // Source of each field:
  //   - sessionId : metadata.getSessionId() (cached UUIDv4)
  //   - pid       : process.pid (Bun process)
  //   - model     : selectedModel (resolved above by resolveModelId)
  //   - version   : <embeddedDir>/package.json#version, "0.0.0" if missing
  //
  // The object is frozen by createAgentContext, so it can be passed
  // around without defensive copies.
  const agentVersion = readEmbeddedPackageVersion(embeddedDir)
  const agentContext = createAgentContext({
    sessionId: getSessionId(),
    pid: process.pid,
    model: selectedModel,
    version: agentVersion,
  })

  // Mirror MINIMAL_AGENT_MODEL into process.env for legacy direct readers
  // (notably `plugins/quota-status/handler.ts`, which reads
  // `process.env.MINIMAL_AGENT_MODEL`, not `ctx.env`). The loader will
  // also emit MINIMAL_AGENT_* via `agentContextToEnv` into every dispatched
  // ctx.env, but those values are scoped to one handler call and don't
  // reach a `process.env`-only reader.
  process.env.MINIMAL_AGENT_MODEL = selectedModel
  process.env.MINIMAL_AGENT_PROVIDER = selectedProviderId
  process.env.MINIMAL_AGENT_SESSION_ID = agentContext.sessionId
  process.env.MINIMAL_AGENT_PID = String(agentContext.pid)
  process.env.MINIMAL_AGENT_VERSION = agentContext.version
  // Publish the opt-in per-session agent name (resolved once up front, beside
  // the startup `name` row) for the `agent-identity` plugin to read (the loader
  // spreads process.env into every prompt-fragment ctx.env). The name is frozen
  // for the session: it lands in the system prompt, so changing it mid-run would
  // bust the conversation's prompt cache. Off by default (resolver returned
  // undefined → we clear the env so the plugin emits nothing and the system
  // prompt is byte-identical to today's).
  if (resolvedAgentName) {
    process.env.MINIMAL_AGENT_AGENT_NAME = resolvedAgentName
  } else {
    delete process.env.MINIMAL_AGENT_AGENT_NAME
  }
  // Advertise the managed-binary directory (`~/.minimal-agent/bin`) to every
  // plugin, every session. The host OWNS this dir and provisions binaries into
  // it (see `binaries/store.ts`); plugins must NOT scan the filesystem or
  // hard-code a home path of their own, because the home dir differs per
  // install and the agent is the single party that knows where it put things.
  // The loader already spreads `process.env` into every dispatched `ctx.env`,
  // so setting it here makes `MINIMAL_AGENT_BIN_DIR` reach module handlers and
  // any subprocess they spawn. Set UNCONDITIONALLY (not gated on header /
  // provisioning): a previously-installed binary must still resolve on a
  // scripted `--prompt` run where the provisioning phase is skipped.
  process.env.MINIMAL_AGENT_BIN_DIR = defaultBinDir()
  // Publish the RESOLVED effort + fast-mode state into process.env as the
  // authoritative output the quota-status footer / session-info read.
  publishResolvedRequestEnv(hidesReasoning, effort, speedFast)
  // Effective platform for plugin/tool `platforms` whitelist gating:
  // --platform > MINIMAL_AGENT_PLATFORM > detected (process.platform).
  // `all` (or `any`/`*`) bypasses gating for the session.
  const platformIdx = args.indexOf("--platform")
  const resolvedPlatform = resolveEffectivePlatform({
    cli: platformIdx !== -1 ? args[platformIdx + 1] : undefined,
    env: process.env.MINIMAL_AGENT_PLATFORM,
  })
  if (resolvedPlatform.invalid !== undefined) {
    diag.warn(
      "plugin-loader",
      `ignoring unrecognized platform override ${JSON.stringify(resolvedPlatform.invalid)}; ` +
        `using ${resolvedPlatform.platform} (${resolvedPlatform.source}). ` +
        `Valid: macos, linux, windows, all.`,
    )
  }
  const configPluginOverrides = loadPluginEnabledOverrides()
  const pluginOverrides = resolvePluginEnabledOverrides({
    config: configPluginOverrides,
    env: {
      disable: process.env.MINIMAL_AGENT_DISABLE_PLUGINS,
      enable: process.env.MINIMAL_AGENT_ENABLE_PLUGINS,
    },
    cli: {
      disable: collectFlagValues(args, "--disable-plugin"),
      enable: collectFlagValues(args, "--enable-plugin"),
    },
  })
  // Late-bound getter for the agent's LIVE model id. The loader loads before
  // the Agent is constructed, and the model can change mid-session (/model,
  // preflight switch) or differ on resume, so the ModelInfo tool must read the
  // current value, never the boot value. Rebound to `agent.getModel()` below.
  let getLiveModelId: () => string = () => selectedModel
  let getLiveProviderId: () => string | undefined = () => selectedProviderId
  const loader = await PluginLoader.load({
    embeddedDir,
    userDir,
    homeDir,
    projectDir: process.cwd(),
    // Dev-time sibling plugin repo (../minimal-agent-plugins). Empty in
    // production and when the sibling checkout is absent.
    ...(siblingDirs.length > 0 ? { siblingDirs } : {}),
    coreToolNames,
    // Single AgentContext shared with every plugin dispatch path.
    // Frozen value object; see createAgentContext + AgentContext docs.
    agent: agentContext,
    // Live current-model snapshot for the decoupled `ModelInfo` tool. Reads the
    // agent's CURRENT model (via the late-bound getter) + the shared registry,
    // so it stays correct across mid-session switches and resume.
    modelInfoProvider: () => buildModelInfoSnapshot(getLiveModelId(), getLiveProviderId()),
    // Active-provider sub-agent model recommendations (role → concrete model),
    // read live so a delegation plugin maps roles without importing a provider.
    recommendSubagentModels: () => buildSubagentModelRecommendations(getLiveModelId()),
    // Universal opt-out: `plugins.<id>.enabled === false` in config, env
    // (`MINIMAL_AGENT_DISABLE_PLUGINS`), or CLI (`--disable-plugin`).
    // The matching enable set overrides a manifest-level `enabled: false`
    // author opt-out (config, env, or `--enable-plugin`).
    disabledPluginIds: pluginOverrides.forceDisabled,
    enabledPluginIds: pluginOverrides.forceEnabled,
    // Effective platform for `platforms` whitelist gating (CLI/env/detected).
    effectivePlatform: resolvedPlatform.platform,
  })
  // Expose the loader's event bus to deep emit-points (notably
  // `client.ts`, which broadcasts `quota.headersReceived` after every
  // successful API response — see src/global-bus.ts for the rationale).
  setGlobalEventBus(loader.bus())
  // Per-turn attachment producers + content drains, contributed by
  // plugins through the loader's `turnAttachments` manifest seam (the
  // memory plugin's short-term snapshot + save-echo collector, the
  // tasks snapshot, the sub-agents fleet digest, …). Core consumes ONLY
  // the registry — it neither knows nor imports the producers'
  // identities (the I2 invariant). A disabled/absent plugin simply
  // contributes nothing: the agent then runs without that attachment
  // (graceful degradation, pinned in `src/agent/turn-attachments.test.ts`).
  const turnAttachmentSeam = await instantiateTurnAttachments(
    { sessionId: getSessionId(), bus: loader.bus() },
    (m) => diag.notice("turn-attachments", m),
  )
  const saveEcho = combineTurnDrains(turnAttachmentSeam.drains)
  // Resolve async prompt fragments BEFORE querying getExtraTools().
  // The skills plugin's fragment calls registerDynamicTools() to
  // push skill-declared tools (like police_911) into the loader's
  // tool index.  If we query too early those tools are missing from
  // the startup banner, the tool hash, and the first turn's API
  // request.  getPromptBlockAsync() awaits all fragment promises,
  // then memoizes; subsequent calls (sync and async) return cached.
  void (await loader.getPromptBlockAsync())
  const loadedTools = loader.getExtraTools()
  const loadedModes = loader.getModes()
  const hasPromptBlock = loader.getPromptBlock() !== null
  // Aggregate flag preserved for downstream system-prompt / tool-hash
  // construction (search this file for `hasPlugins`). Independently of
  // how we choose to render the startup tree, those callers want one
  // bool: "did anything plugin-shaped get loaded".
  const hasPlugins = loadedTools.length > 0 || hasPromptBlock || loadedModes.length > 0
  // Show what the plugin layer actually contributes — names of callable
  // tools rather than an aggregate `3 tool(s)`. The active mode (if any)
  // gets its own row below at the `printStartupRow("mode", …)` site, so
  // we don't duplicate it here. Modes that exist but aren't active are
  // intentionally not surfaced — discoverable via Shift+Tab.
  //
  // The tools row is deferred — it will be printed last, as the closer
  // row (with `╰` gutter), via `closeStartupTreeWithTools` right before
  // the REPL boots. Deferring avoids the fragile cursor-up rewrite math
  // that broke on terminal resize when the full tool inventory wrapped
  // across many continuation lines.
  //
  // Plugins that contribute only prompt fragments / live-area slots /
  // modes still get a quiet acknowledgement row here.
  if (loadedTools.length === 0 && (hasPromptBlock || loadedModes.length > 0)) {
    printStartupRow("plugins", c.dim("loaded"))
  }
  // Plugin setup phase: binary provisioning. Each plugin's optional `setup()`
  // declares the external binaries it needs (hardcoded url/sha256/version); the
  // host installs/updates any that are missing or outdated into the managed
  // `~/.minimal-agent/bin/`, with a startup-row spinner + a syslog audit trail
  // in `~/.minimal-agent/ma.log`. A plugin NEVER downloads or probes paths
  // itself. If a plugin marks a binary mandatory (`haltIfMissing`) and it can't
  // be provisioned, we stop here with the plugin's message rather than let the
  // user hit a broken tool at first call.
  //
  // Gated to header runs (interactive boots) for the same reason as the plugin
  // clone: a scripted `--prompt` / piped run shouldn't reach out to the network
  // or grow the install set under the user's feet. Opt out entirely with
  // MINIMAL_AGENT_NO_BINARY_SETUP=1.
  if (SHOW_HEADER && process.env.MINIMAL_AGENT_NO_BINARY_SETUP !== "1") {
    const { provisionPluginBinaries } = await import("./host/startup/provision-binaries.ts")
    await provisionPluginBinaries(loader)
  }

  // Resolve the initial mode. In non-interactive (--prompt/`-`/positional)
  // we default to ASK so one-shot runs are read-only by default; the user
  // opts out via `--mode none`, `MINIMAL_AGENT_MODE=none`, or
  // `config.mode = "none"`. See `resolveInitialModeId` for full precedence.
  const initialModeId =
    loadedModes.length > 0
      ? resolveInitialModeId(
          {
            args,
            env: { MODE: process.env.MINIMAL_AGENT_MODE },
            config: { mode: userConfig.mode },
          },
          loader.getDefaultModeId(),
        )
      : null
  // Per-mode user-config overlays for permissions. Snapshotted once at
  // startup; the user can edit `~/.minimal-agent/config.jsonc` and
  // restart to apply. (Hot-reload of permissions is future work.) The
  // overlay map is queried on demand inside `ModeManager.effectivePermissions`.
  const modeUserOverrides = loadedModes.length > 0 ? loadModeUserOverrides() : new Map()
  const modeManager =
    loadedModes.length > 0
      ? new ModeManager(
          loadedModes,
          initialModeId,
          undefined,
          undefined,
          (modeId) => modeUserOverrides.get(modeId) ?? null,
        )
      : null
  if (modeManager?.active()) {
    // Use the manifest's `label` (e.g. "ASK") rather than the lowercase
    // `id` so the startup row matches the prompt prefix the user sees a
    // moment later (`ASK ❯ `). Falls back to upper-cased id when label
    // isn't declared, mirroring `ModeManager.computePromptPrefix`.
    const m = modeManager.active()!
    const label = m.label ?? m.id.toUpperCase()
    printStartupRow("mode", c.bold(c.cyan(label)))
  }

  // Quota check — verify account has quota before starting conversation
  // with a cheap probe request.
  //
  // Skipped automatically when ANY loaded plugin contributes a live-area
  // slot with id `"quota"` — the slot will fetch the same data
  // asynchronously after REPL boot, so blocking the boot here would just
  // duplicate the work and re-introduce the latency we're trying to
  // eliminate. The user-facing benefit: the live area shows up
  // instantly; the quota row populates a moment later.
  const hasQuotaSlot = loader.getLiveAreaSlots().some((s) => s.definition.id === "quota")
  const shouldSkipQuota =
    !commandPlan.needsQuota ||
    // Only meaningful for a provider that declares a quota-probe seam. A
    // provider whose quota fills from chat traffic (or that has no quota
    // concept) declares none and skips the blocking boot probe. See
    // `providerWantsQuotaProbe` in src/startup/provider-presentation.ts.
    !providerWantsQuotaProbe(selectedProviderId) ||
    args.includes("--skip-quota") ||
    process.env.MINIMAL_AGENT_SKIP_QUOTA === "1" ||
    userConfig.skipQuota === true ||
    hasQuotaSlot

  if (!shouldSkipQuota) {
    const quotaSpinner = startStartupRowSpinner("quota", c.dim("checking..."))
    // Warm the selected provider's quota cache via its own session-prime seam
    // (the canonical, provider-neutral probe). Blocking-but-bounded: the prime
    // never throws and self-bounds its deadline, so a slow/unreachable provider
    // degrades to an empty banner segment rather than stalling boot. The old
    // path issued a provider-specific quota POST here and hard-exited on a bad
    // token; that boot-time, single-provider gate is intentionally gone — auth
    // failures now surface on the first real turn with a proper error.
    await primeProviderSessionInfo(selectedModel, {
      providerId: selectedProviderId,
    })
    // Banner quota summary: provider-NEUTRAL path. The prime above populated the
    // quota cache; the provider plugin's session-info seam parses its own header
    // shapes into neutral QuotaWindows, and core renders those (header-name
    // knowledge stays out of core).
    let quotaSegment = ""
    try {
      const info = await resolveProviderSessionInfo(selectedModel, {
        providerId: selectedProviderId,
      })
      quotaSegment = formatQuotaWindows(info.quota?.windows ?? [], {
        leadSpaces: 2,
        showOverage: process.env.MINIMAL_AGENT_QUOTA_OVERAGE === "1",
        overage: info.quota?.overage,
      })
    } catch {
      // No provider session seam (or cold cache): skip the segment.
    }
    quotaSpinner.ok(`${c.boldGreen("ok")} ${c.boldGreen("✔")}${quotaSegment}`)
  }
  // Resolve --resume: load prior conversation if asked.
  // We resolve the sid, load the session, hash-check against current
  // system/tools, and prepare `initialMessages` to seed the new agent.
  let resumeSid: string | null = null
  let initialMessages: import("./llm/messages.ts").Message[] = []
  let resumeBanner: string | null = null
  // tool_use_id → epoch ms, derived from each AssistantRecord's `ts` field
  // for the tool_use blocks it contained. Threaded through replayToScrollback
  // so the time-hint suffix on replayed tool headers shows the historical
  // moment, not the time-of-replay. Stays empty when not resuming.
  let toolStartTimes: Map<string, number> | null = null
  // Per-message timestamp parallel to `initialMessages`, also derived from
  // the JSONL records. Used by replayToScrollback to stamp each
  // `<mode-change>` chip with `YYYY-MM-DD HH:MM` of the prompt that
  // shipped the toggle, instead of "(now)". Stays null when not resuming.
  let userTimestamps: (Date | null)[] | null = null
  // tool_use_id → live transcript presentation overrides (display /
  // displayHeader / displayFooter) for each tool result that carried
  // them at write time. Threaded through replayToScrollback so plugin-
  // driven renders (Edit's unified diff, Tasks' tree, etc.) survive
  // `--resume` instead of regressing to the model-facing `content`
  // text. Stays null for sessions written before the field landed and
  // for non-resume runs.
  let toolDisplays: Map<
    string,
    { display?: string; displayHeader?: string; displayFooter?: string }
  > | null = null
  // Trailing user message that was typed and submitted but never got an
  // assistant reply (aborted/crashed/killed before any tokens streamed).
  // `loadSession` extracts it from `messages` so the API never sees a
  // `[..., user, user]` sequence; we restore it into the editor on REPL
  // start so the user lands on a populated input and can hit Enter (or
  // edit / clear) instead of losing their draft to the void. See
  // `extractPendingDraft` in `./session-restore.ts`.
  let pendingDraft: string | null = null
  const resumeSameSid = resumeSameArg !== undefined
  if (effectiveResumeArg) {
    try {
      resumeSid = resolveSessionTarget(effectiveResumeArg, process.cwd())
      if (!resumeSid) {
        console.error(`  ${c.boldRed("error")} no saved sessions found to --resume last`)
        process.exit(1)
      }
      const loaded = loadSession(resumeSid)
      initialMessages = loaded.messages
      pendingDraft = loaded.pendingDraft
      // Build the tool_use_id → ts(ms) lookup for the replay time-hint.
      // We use AssistantRecord.ts because that's the moment the assistant
      // message containing the tool_use block arrived — i.e. the moment
      // the live REPL drew the `╭` header. This is approximate (the tool
      // executes shortly after) but accurate enough for the human-facing
      // "when did this happen" hint.
      toolStartTimes = new Map<string, number>()
      for (const r of loaded.records) {
        if (r.kind !== "assistant") continue
        const ms = Date.parse(r.ts)
        if (Number.isNaN(ms)) continue
        for (const blk of r.content) {
          if (blk.type === "tool_use") {
            toolStartTimes.set((blk as import("./llm/messages.ts").ToolUseBlock).id, ms)
          }
        }
      }
      // Per-message timestamps for the replay mode-change chip. Derived
      // from the same `records` walk that `foldRecords` uses, so the
      // resulting array is index-parallel to `initialMessages`. See
      // `userTimestampsFromRecords` in `src/session-replay.ts`.
      userTimestamps = userTimestampsFromRecords(loaded.records)
      // Live transcript presentation overrides (display / displayHeader
      // / displayFooter), keyed by tool_use_id. Threads the per-session
      // `<sid>.tasks.jsonl` sidecar (when present) so the Task deriver
      // can render historical task calls with full ANSI styling AND
      // per-call status snapshots, instead of falling back to the
      // structural content-split path. The sidecar load is best-effort:
      // a missing file just yields a `null` sidecar, which the deriver
      // handles by taking the structural path. Parsed via the
      // core-local `parseReplaySidecarTasks` (a structural mirror of
      // the tasks plugin's parser — the I2 invariant keeps the plugin
      // import out of core). See `toolDisplaysFromRecords` +
      // `deriveTaskDisplay` for the per-call cutoff semantics.
      const sidecarPath = join(resolveSessionsDir(), `${resumeSid}.tasks.jsonl`)
      let sidecarTasks: import("./host/session-replay-derivers.ts").ReplaySidecarTask[] | null =
        null
      try {
        if (existsSync(sidecarPath)) {
          const text = readFileSync(sidecarPath, "utf8")
          sidecarTasks = parseReplaySidecarTasks(text)
        }
      } catch {
        // Best-effort: a malformed sidecar is just treated as missing.
        sidecarTasks = null
      }
      toolDisplays = toolDisplaysFromRecords(loaded.records, { sidecarTasks })
      const turns = initialMessages.length
      const droppedNote =
        loaded.dropped.length > 0
          ? ` ${c.dim(`(dropped ${loaded.dropped.length} corrupt line(s))`)}`
          : ""
      const repairNote = loaded.repaired ? ` ${c.dim("(repaired trailing turn)")}` : ""
      // Surface draft restoration in the startup tree so the user sees a
      // single-source-of-truth explanation for the prefilled editor.
      // The hint line printed after replay (see below) gives the
      // editor-adjacent context, but a user scanning the startup banner
      // alone should still understand why their input is non-empty.
      const draftNote = pendingDraft !== null ? ` ${c.dim("(unsent draft restored)")}` : ""
      resumeBanner = `resume ${c.cyan(resumeSid)} ${c.dim(`(${turns} message(s))`)}${repairNote}${droppedNote}${draftNote}`
      printStartupRow("resume", resumeBanner)
      // Rehydrate ModeManager's lastAdvertisedModeId from the persisted
      // history so the first consume after resume does NOT re-emit a
      // redundant `from="default" to="<id>"` attachment for a mode the
      // model already saw in its conversation. The active mode in this
      // process is still set by the normal precedence (CLI > env >
      // config > plugin-default); only the "what the model knows"
      // bookkeeping is rehydrated here.
      if (modeManager) {
        const lastTo = lastAdvertisedModeFromHistory(initialMessages)
        modeManager.primeLastAdvertised(lastTo)
      }
      // Hash drift: compute below once we have system+tools.
    } catch (err) {
      console.error(
        `  ${c.boldRed("error")} could not resume session ${effectiveResumeArg}: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    }
  }
  if (loadedTools.length > 0) {
    closeStartupTreeWithTools(loadedTools)
  } else {
    closeStartupTree()
  }

  // Flush any diagnostics that fired during the banner draw. The
  // scrollback sink was put into buffering mode right after construction
  // (above) precisely so a plugin-loader / auth / config warning
  // emitted mid-banner can't tear through the `╭ │ │ ╰` box mid-paint.
  // After this call any further `diag.warn(...)` lands directly in
  // scrollback via the sink's writer, which is what we want for the
  // interactive session.
  scrollbackSink?.flushBuffer()

  // Compute systemHash + toolsHash for the session-store meta record (and
  // for resume drift detection). These mirror what agent.run() would compute
  // internally — the meta record is written at session OPEN, before any run()
  // call. See `host/startup/startup-hashes.ts` for the recipe (it must track
  // the Agent class field defaults).
  const { systemHash, toolsHash } = await computeStartupHashes({
    loader: hasPlugins ? loader : null,
    modeManager,
    selectedModelBase,
    auth,
    cacheTtl,
  })

  // Session store + blob store + resume warnings + attach/detach
  // lifecycle markers. Lives in `src/startup/session-store-boot.ts`;
  // see that module for the fork-on-resume + best-effort semantics.
  const sid = getSessionId()
  const { store, blobStore } = await bootSessionStores({
    sid,
    resumeSid,
    resumeSameSid,
    selectedModel,
    providerId: selectedProviderId,
    systemHash,
    toolsHash,
  })

  // Shared time-hint tracker. One instance threads through both
  // session-replay (for the historical tool headers when --resume hydrates
  // from JSONL) AND the live Agent (for new tool headers in this session).
  // The tracker carries day-state across calls so the date prefix only
  // re-emits on calendar rollover — including the rollover from the last
  // replayed tool to the first live tool.
  const toolTimeTracker = new ToolTimeTracker()

  // --output-schema FILE (Phase 4): read + parse the JSON Schema so the agent
  // can constrain its final structured answer. parseSchemaFile folds a
  // malformed-JSON / non-object file into a thrown error we surface cleanly
  // and exit 1 (a script passing a broken schema should fail loudly, not
  // silently run unconstrained).
  let outputSchema: object | undefined
  if (outputSchemaPath !== undefined) {
    try {
      const raw = readFileSync(outputSchemaPath, "utf8")
      outputSchema = parseSchemaFile(raw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`--output-schema: ${msg}\n`)
      process.exit(1)
    }
  }

  const agent = new Agent({
    auth,
    model: selectedModel,
    providerId: selectedProviderId,
    ...(credentialName ? { credentialName } : {}),
    effort,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    speed,
    serviceTier,
    thinkingDisplay,
    cacheTtl,
    loader: hasPlugins ? loader : null,
    modeManager,
    saveEcho,
    // All plugin-contributed producers ride the generic array, in
    // registry order (memory's short-term snapshot, tasks snapshot,
    // sub-agents fleet digest, …) — same model-visible attachment order
    // as the old named wiring. The named `shortTermSnapshot` /
    // `tasksAttachment` params stay unset: core no longer knows those
    // producers' identities.
    turnAttachments: turnAttachmentSeam.producers,
    store,
    blobStore,
    initialMessages,
    toolTimeTracker,
  })
  // Point the ModelInfo provider at the agent's live model from here on.
  getLiveModelId = () => agent.getModel()

  // Ready banner : emitted ONCE here so it lands in scrollback right
  // under the startup header, BEFORE any resume replay. Previously the
  // banner was emitted from inside `runRepl` / `runReplLiveArea`, which
  // on resume placed it BELOW the replayed content (visible jump:
  // header > replay > hint, instead of header > hint > replay).
  //
  // Skipped for non-interactive modes (`--prompt`, `-`, bare positional)
  // where there's no REPL prompt to introduce. `extractPromptFromArgs`
  // is pure (no stdin read) so calling it here is cheap; the later
  // `extractPrompt()` call still runs to drive the actual non-interactive
  // branch.
  const promptSource = extractPromptFromArgs(args)
  const willEnterRepl = promptSource.kind === "none"
  if (willEnterRepl) {
    const stdoutCols = (process.stdout as { columns?: number }).columns ?? 80
    process.stdout.write(buildReadyBanner(modeManager, stdoutCols))
  }

  // Replay prior conversation to scrollback when resuming. We write
  // straight to stdout BEFORE the live-area compositor mounts, so the
  // history lands in normal terminal scrollback and the pinned editor
  // appears underneath it. For non-interactive (`--prompt`) mode we skip
  // the replay — the user just wants the next reply, not the history.
  //
  // `formatterCmd` is passed through so assistant text/thinking blocks
  // render through mdstream (or whatever formatter the user configured),
  // matching the live REPL's markdown rendering. Without this, replayed
  // markdown shows up as raw `**bold**` / `# heading` source text.
  //
  // We also enter this block when `pendingDraft` is set but the
  // conversation history is empty (a session that was aborted before any
  // assistant turn ever completed). In that case there's nothing to
  // replay but we still want the resume header + draft hint to paint, so
  // the user sees a coherent "you're resuming session X, here's your
  // unsent prompt" story instead of an unexplained populated editor.
  const isInteractiveResume = resumeSid && !args.includes("--prompt")
  const shouldEmitResumeBlock =
    isInteractiveResume && (initialMessages.length > 0 || pendingDraft !== null)
  if (shouldEmitResumeBlock) {
    const stdoutSink = { write: (s: string) => process.stdout.write(s) }
    stdoutSink.write(
      buildResumeHeader({
        sid: resumeSid as string,
        turns: initialMessages.length,
        model: selectedModel,
      }),
    )
    if (initialMessages.length > 0) {
      // Build the tool presentation map (icon + color) for replay. Mirror
      // the live agent's `toolPresentation` construction in
      // `src/agent.ts`: built-ins come from `TOOL_DEFINITIONS`, plugin
      // tools come from `PluginLoader.getExtraTools`, and aliases inherit
      // their canonical's presentation. Without this map the replayed
      // `╭` header drops the icon (`» Bash`, `✦ Edit`, `✔ Task`) and
      // falls back to the bare bold tool name in orange.
      const toolPresentation = new Map<
        string,
        { icon?: string; color?: string; headerKey?: string }
      >()
      for (const t of TOOL_DEFINITIONS) {
        if (t.icon || t.color) toolPresentation.set(t.name, { icon: t.icon, color: t.color })
      }
      if (loader) {
        for (const t of loader.getExtraTools()) {
          if (t.icon || t.color || t.headerKey)
            toolPresentation.set(t.name, {
              icon: t.icon,
              color: t.color,
              headerKey: t.headerKey,
            })
        }
        for (const [alias, canonical] of loader.getToolAliases()) {
          const pres = toolPresentation.get(canonical)
          if (pres && !toolPresentation.has(alias)) toolPresentation.set(alias, pres)
        }
      }
      await replayToScrollback(initialMessages, stdoutSink, {
        modeManager,
        formatterCmd,
        toolTimeTracker,
        toolStartTimes,
        userTimestamps: userTimestamps ?? undefined,
        toolDisplays,
        toolPresentation,
        scrollbackSubmittedAt: userConfig.scrollback?.submittedAt,
      })
      stdoutSink.write("\n")
    }
    if (pendingDraft !== null) {
      // One-line dim hint directly above where the live editor will
      // mount. The draft text itself is NOT painted here, the editor's
      // own prefilled buffer is the visual proof. Keeping this compact
      // avoids a heavy strikethrough echo for multi-KB drafts (the
      // motivating session in #7548d4b2 had a 4222-char draft).
      stdoutSink.write(
        `  ${c.dim("──")} ${c.dim("unsent draft restored to input · press Enter to send, or edit")} ${c.dim("──")}\n\n`,
      )
    }
  }

  // Non-interactive mode: send prompt, print response, exit. The output
  // routing (formatter, --json / human / --output-schema, plugin stream,
  // schema gate) lives in `host/startup/run-non-interactive.ts`.
  const prompt = await extractPrompt()
  if (prompt) {
    await runNonInteractivePrompt({
      agent,
      prompt,
      formatterCmd,
      showHeader: SHOW_HEADER,
      wantJsonOutput,
      outputSchema,
      loader: hasPlugins ? loader : null,
      cwd: process.cwd(),
    })
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
    // Full interactive TTY stack (capability probes, compositor,
    // interceptor, editor, resize fan-out, Auto-ASK) lives in
    // `src/startup/live-repl.ts`. `runRepl` is passed in as a value to
    // keep that module import-cycle-free with `../agent.ts`.
    const { runLiveAreaRepl } = await import("./host/startup/live-repl.ts")
    await runLiveAreaRepl({
      agent,
      repl: runRepl,
      formatterCmd,
      auth,
      spinner,
      args,
      userConfig,
      modeManager,
      hasPlugins,
      loader,
      pendingDraft,
    })
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
