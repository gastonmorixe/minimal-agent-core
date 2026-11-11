/**
 * Host-mode contract: a plugin-manifest `hostModes` entry hands the WHOLE
 * process to one plugin after full boot (auth, plugins/tools, modes,
 * stores), selected by `--host-mode <id>`. A plugin host mode is usually a
 * long-lived protocol server over stdio (for example, JSON-RPC), instead of
 * the one-shot `--prompt` / REPL agent run. Core names no protocol here.
 *
 * This lives in `src/host-public/` (exported as `./host-kit/host-mode`),
 * not `src/sdk/`: {@link HostSession.run}'s real event/result types come
 * from `src/runtime`/`src/session`, which the SDK port-boundary ratchet
 * (`src/architecture/sdk-port-boundaries.test.ts`) forbids any file under
 * `src/sdk` from reaching, even type-only. `src/host-public` is the
 * "narrower audience than `./host/*`" home the host-kit cluster already
 * uses for exactly this shape of file.
 *
 * Design history: `research/2026-10-31-hostmodes-contract-draft.md` in the
 * `minimal-agent` umbrella repo.
 *
 * Scope, Level 1:
 * - ONE host mode runs per process invocation (it owns stdin/stdout for the
 *   run's lifetime; a second `--host-mode` is a usage error, checked by the
 *   host before the entry is called).
 * - ONE session per process. {@link HostRuntime.openSession} may be called
 *   at most once; a second call throws. Many sessions in one process is
 *   a real architecture change (the host boot builds exactly one
 *   conversation from process-global state today) and is explicitly
 *   deferred past Level 1 — see the design doc's "Single-session boot"
 *   section. At Level 1, a plugin host mode runs one OS process per session.
 * - No per-session `cwd`: the first (only) session fixes the process cwd.
 *
 * The host guarantees, before calling the entry:
 * - Boot is complete (providers, auth, plugins and their hooks, tools,
 *   modes, stores).
 * - stdout is clean: nothing but the entry's own writes (through
 *   `ctx.stdout`) reaches the real stdout for the life of the mode. No
 *   startup banner, resume header, or stray `console.log`/
 *   `process.stdout.write` from elsewhere in the process gets through.
 * - The mode never opens the TUI, reads the TTY, starts the live area, or
 *   polls quota.
 *
 * The host never calls `process.exit` after installing the mode (it can
 * truncate buffered stdout on a fast exit with a slow reader). The entry's
 * resolved number is applied with `process.exitCode`, then the event loop
 * drains naturally. A rejected entry promise becomes exit code 1.
 *
 * @module host-public/host-mode
 */

import type { ModelInfoSnapshot, PluginLogger } from "@minimal-agent/core/plugin-api/types/plugin"

import type { TurnResult } from "../sdk/agent-core.ts"
import type { SessionEntry } from "../session/event-log.ts"

/** One registered model of the CURRENT provider, for {@link HostRuntime.listModels}. */
export interface HostModelView {
  readonly id: string
  /** Human label (`ModelEntry.displayName`). */
  readonly label: string
}

/** Options for {@link HostSession.run}. */
export interface HostRunOptions {
  readonly emitDeltas: true
  readonly signal: AbortSignal
  /**
   * A JSON Schema object (the same `object` type as the session-level
   * `outputSchema` in `AgentCoreConfig`). Applies to this run only: every
   * model request of the run sends it as `outputConfig.format`
   * (`json_schema`) in place of the session value. The session value comes
   * back after the run, also when the run fails or is aborted. Omit it to
   * keep the session value.
   */
  readonly outputSchema?: object
  /**
   * Sampling temperature for this run only. Every model request of the run
   * sends it, then the provider default comes back (also when the run fails
   * or is aborted). Omit it to keep the provider default.
   *
   * Range: core does not check it. The provider API does: 0..1 on
   * Anthropic, 0..2 on OpenAI (`plugin-api/src/llm/canonical-request.ts:47`).
   * The core-side check is the model capability only: a model whose
   * registry entry has `acceptsTemperature: false` gets no temperature
   * (the provider validators would reject it,
   * `plugin-api/src/llm/anthropic-request.ts:563-567`,
   * `plugin-api/src/llm/openai-chat.ts:435-437`). The run does not fail.
   * It reports the drop once as a `ch: "diag"` entry in the run's entry
   * stream: severity warn, `data.code` `"agent.temperature-ignored"`,
   * `data.data` `{ model, temperature }`.
   */
  readonly temperature?: number
  /**
   * Strict structured output for this run only (SPEC-ONESHOT R2). Default
   * false. No effect without a schema (run `outputSchema` or the session
   * value). Same life as `outputSchema`: set at run start, and the session
   * value comes back after the run, also when it fails or is aborted. A host
   * whose `Session.run` does not forward it arms it with
   * `AgentCore.setNextRunOutputStrict`.
   *
   * The canonical request gets `outputFormat.strict: true` plus a stable
   * `outputFormat.name` (schema `title`, else `"output"`, sanitized to
   * `[a-zA-Z0-9_-]`, max 64 chars). The provider plugin decides what goes
   * on the wire. When the model's registry entry has
   * `structuredOutputs: false`, the run reports it once as a `ch: "diag"`
   * entry: severity warn, `data.code` `"llm.strict-unsupported"`,
   * `data.data` `{ model }`. The run does not fail. A model with no
   * registry entry gets no warn.
   */
  readonly outputStrict?: boolean
}

/**
 * One host-mode session. Built from the same per-session pieces
 * the host's single-session boot uses for the human path
 * (`openAgentCoreSession`, the already-open session/blob/file-tracking
 * stores, `hostLifecycle.sessionStart`). Level 1: exactly one is opened per
 * process, and its `sessionId` is the process's own session id (the same
 * one the already-open session store uses) — never a fresh id the entry
 * invents, so a resume later lines up with the store on disk.
 */
export interface HostSession {
  readonly sessionId: string
  /**
   * Starts a turn immediately and streams every entry it produces until
   * the turn ends. Same shapes as `Session.run` (`src/runtime/session.ts`),
   * so the entry gets core's real event shapes (`AgentEvent` via
   * `SessionEntry`), not a neutral stand-in. `result` resolves with the
   * same `TurnResult` `AgentCore.run` itself returns; await the iterable
   * first (it throws on a run failure) before reading `result` for the
   * outcome.
   *
   * Before the first model request, the host applies the `turn.willStart`
   * chain, the same as the one-shot `--prompt` run. A hook can rewrite
   * `input`. When a hook halts, no model request is sent: the iterable
   * throws, and `result` rejects, with an Error whose `code` is
   * `"turn.blocked"`. The session stays usable for the next prompt.
   *
   * `options.outputSchema` (optional) asks for structured output for THIS
   * run only: see {@link HostRunOptions.outputSchema}.
   * `options.temperature` (optional) sets the sampling temperature for THIS
   * run only: see {@link HostRunOptions.temperature}.
   * `options.outputStrict` (optional) asks for strict structured output for
   * THIS run only: see {@link HostRunOptions.outputStrict}.
   *
   * @throws Error when the session is closed, or already running a turn.
   */
  run(
    input: string,
    options: HostRunOptions,
  ): AsyncIterable<SessionEntry> & { readonly result: Promise<TurnResult> }
  /**
   * Answers a pending `ask_user` preflight question. Only a session built
   * with `askUserFallback: "registry"` has pending asks. Returns `false`
   * when `askId` has no pending ask.
   * This is NOT the per-tool approval gate. That gate is a
   * `tool.willInvoke` chain hook the plugin registers itself, not
   * something the host wires here.
   */
  answer(askId: string, answer: string | null): boolean
  /** Ends the session. Calling `run` or `answer` again afterward throws. */
  close(): Promise<void>
}

/**
 * A client-supplied system prompt for {@link HostRuntime.openSession}.
 *
 * - `append`: the host adds `text` after the instructions block and before
 *   plugin session context (the `appendSystemPrompt` session dep). Empty or
 *   whitespace-only text adds nothing.
 * - `override`: the host replaces ONLY the base instructions section
 *   (`systemPromptOverrides.instructions = { kind: "replace", text }`). The
 *   identity, provider preamble, and plugin context stay. It is NOT a full
 *   prompt replace: a `full` replace skips the provider hook and drops
 *   provider-owned blocks (for example, the Anthropic plan-OAuth billing
 *   block, see `src/llm/system-prompt.ts`), which can break that auth.
 *   Other overrides already set for the process (CLI, env, config) stay.
 */
export interface HostSystemPromptOption {
  readonly mode: "append" | "override"
  readonly text: string
}

/** Options for {@link HostRuntime.openSession}. Every field is optional. */
export interface HostOpenSessionOptions {
  readonly systemPrompt?: HostSystemPromptOption
}

/**
 * The live, per-process pieces a host-mode entry needs beyond stdio: the
 * one session factory, and model/effort switching. Model and effort are
 * CONTEXT functions, not methods on {@link HostSession} — the entry never
 * imports the model registry, or `AgentCore`, directly; this is the one
 * seam both the human CLI path and a host mode call through, so there is
 * exactly one place that validates a switch.
 */
export interface HostRuntime {
  /**
   * Opens the one host-mode session for this process. `options` is
   * optional: a call with no argument opens the session with the boot
   * deps unchanged. See {@link HostSystemPromptOption} for `systemPrompt`.
   *
   * @throws Error on a second call (Level 1 is one session per process).
   */
  openSession(options?: HostOpenSessionOptions): Promise<HostSession>
  /** Registered models of the CURRENT provider only (never another provider's catalog). */
  listModels(): readonly HostModelView[]
  /** `undefined` for an id the registry does not resolve for the current provider. */
  modelInfo(id: string): ModelInfoSnapshot | undefined
  getModel(): string
  /**
   * Checked setter: throws on an unknown model id (for the current
   * provider), leaving the model unchanged. Applies from the next model
   * request, which can be inside the same turn. It is never a core copy.
   */
  setModel(id: string): void
  /**
   * Current reasoning effort, or `undefined` for the model default. Before
   * {@link openSession}, this is the boot value (`--effort` or config).
   * After it, this reads the live session's `AgentCore.getEffort` with no
   * fallback, so a reset by {@link setModel} shows as `undefined`.
   */
  getEffort(): string | undefined
  /**
   * Checked setter (`AgentCore.setEffort`): validates `level` against the
   * current model's effort levels and throws on a bad value, with state
   * unchanged. `undefined` always passes (the model default). Throws when
   * no session is open yet.
   */
  setEffort(level: string | undefined): void
}

/**
 * What the host hands a `hostModes` entry, after full boot. The host owns
 * the stdout-purity rule; the entry owns the protocol bytes.
 */
export interface HostModeContext {
  /** Args after `--host-mode <id>`. */
  readonly argv: readonly string[]
  readonly stdin: NodeJS.ReadStream
  /** The host guarantees nothing else writes here while this mode runs. */
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
  /**
   * Fires on the first `SIGTERM` or `SIGINT`. The entry must then end and
   * resolve its exit code. A second signal, or no end within the grace
   * period (5 s), makes the host end the process (exit code 128 plus the
   * signal number), so a stuck entry cannot block shutdown.
   */
  readonly abort: AbortSignal
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /** Writes to stderr. Prefer this over `console.*` (which this mode reroutes to stderr anyway). */
  readonly log: PluginLogger
  readonly runtime: HostRuntime
}

/**
 * A plugin's `hostModes[].entry` module default export. The host applies
 * the resolved exit code with `process.exitCode` (never `process.exit`,
 * see the module doc); a rejected promise becomes exit code 1.
 */
export type HostModeHandler = (ctx: HostModeContext) => Promise<number>
