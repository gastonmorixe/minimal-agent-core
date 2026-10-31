/**
 * Host-mode contract: a plugin-manifest `hostModes` entry hands the WHOLE
 * process to one plugin after full boot (auth, plugins/tools, modes,
 * stores), selected by `--host-mode <id>`. The first consumer is the ACP
 * plugin (`ma-acp-plugin`, Level 1, in the sibling `minimal-agent-plugins`
 * repo): a long-lived JSON-RPC-over-stdio protocol server, instead of the
 * one-shot `--prompt` / REPL agent run.
 *
 * This lives in `src/host-public/` (exported as `./host-kit/host-mode`),
 * not `src/sdk/`: {@link HostSession.run}'s real event/result types come
 * from `src/runtime`/`src/session`, which the SDK port-boundary ratchet
 * (`src/architecture/sdk-port-boundaries.test.ts`) forbids any file under
 * `src/sdk` from reaching, even type-only. `src/host-public` is the
 * "narrower audience than `./host/*`" home the host-kit cluster already
 * uses for exactly this shape of file.
 *
 * Design history: `research/2026-10-31-hostmodes-contract-draft.md` and
 * `research/2026-10-31-acp-plugin-spec-v3.md` section 10/10a in the
 * `minimal-agent` umbrella repo.
 *
 * Scope, Level 1:
 * - ONE host mode runs per process invocation (it owns stdin/stdout for the
 *   run's lifetime; a second `--host-mode` is a usage error, checked by the
 *   host before the entry is called).
 * - ONE session per process. {@link HostRuntime.openSession} may be called
 *   at most once; a second call throws. Many ACP sessions in one process is
 *   a real architecture change (`src/index.ts`'s boot builds exactly one
 *   conversation from process-global state today) and is explicitly
 *   deferred past Level 1 — see the design doc's "Single-session boot"
 *   section. The ACP host, at Level 1, runs one OS process per ACP session.
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
 * truncate buffered stdout on a fast exit with a slow reader — measured in
 * `research/acp-spike/pipe-flush` and the ACP spec section 11). The entry's
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

/**
 * One host-mode session. Built from the same per-session pieces
 * `src/index.ts`'s single-session boot uses for the human path
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
   * the turn ends. Mirrors `Session.run` (`src/runtime/session.ts`) exactly
   * — this IS that method, not a re-shaped copy — so the entry gets core's
   * real event shapes (`AgentEvent` via `SessionEntry`), not a neutral
   * stand-in. `result` resolves with the same `TurnResult` `AgentCore.run`
   * itself returns; await the iterable first (it throws on a run failure)
   * before reading `result` for the outcome.
   *
   * @throws Error when the session is closed, or already running a turn.
   */
  run(
    input: string,
    options: { emitDeltas: true; signal: AbortSignal },
  ): AsyncIterable<SessionEntry> & { readonly result: Promise<TurnResult> }
  /**
   * Answers a pending `ask_user` preflight question (the session's default
   * `PendingAskRegistry`). Returns `false` when `askId` has no pending ask.
   * This is NOT the per-tool approval gate (section 8 of the ACP spec) —
   * that is a `tool.willInvoke` chain hook the plugin registers itself, not
   * something the host wires here.
   */
  answer(askId: string, answer: string | null): boolean
  /** Ends the session. Calling `run` or `answer` again afterward throws. */
  close(): Promise<void>
}

/**
 * The live, per-process pieces a host-mode entry needs beyond stdio: the
 * one session factory, and model/effort switching. Model and effort are
 * CONTEXT functions, not methods on {@link HostSession} — the entry never
 * imports the model registry, or `AgentCore`, directly; this is the one
 * seam both the human CLI path and a host mode call through, so there is
 * exactly one place that validates a switch (decision record:
 * `acp-decisions.md` item 9 in the session that landed this contract).
 */
export interface HostRuntime {
  /**
   * Opens the one host-mode session for this process.
   *
   * @throws Error on a second call (Level 1 is one session per process).
   */
  openSession(): Promise<HostSession>
  /** Registered models of the CURRENT provider only (never another provider's catalog). */
  listModels(): readonly HostModelView[]
  /** `undefined` for an id the registry does not resolve for the current provider. */
  modelInfo(id: string): ModelInfoSnapshot | undefined
  getModel(): string
  /**
   * Checked setter: throws on an unknown model id (for the current
   * provider), leaving the model unchanged. Applies from the next model
   * request, which can be inside the same turn (see the ACP spec section
   * 10b item 4) — never a core copy.
   */
  setModel(id: string): void
  /**
   * `undefined` until core lands a real `AgentCore.getEffort` (ACP-B's
   * core PR, tracked in `acp-decisions.md` item 9 / the ACP spec section
   * 10b plan item 1 — not yet landed as of this file). Re-check once it
   * does: this should start reading the live value instead.
   */
  getEffort(): string | undefined
  /**
   * Throws unconditionally until core lands a real `AgentCore.setEffort`
   * (see {@link getEffort}'s note). Scaffolded now so the entry's own code
   * and types don't need to change shape when that PR lands — only this
   * function's body does.
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
  /** Fires on process shutdown (`SIGTERM`, `SIGINT`). */
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
