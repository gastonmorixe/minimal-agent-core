/**
 * `--host-mode <id>` dispatch: hands the whole process to a plugin's
 * `hostModes[]` entry after full boot, instead of the one-shot `--prompt`
 * agent run or the REPL. First consumer: the ACP plugin (Level 1, in the
 * sibling `minimal-agent-plugins` repo), a long-lived JSON-RPC-over-stdio
 * protocol server.
 *
 * Lifted out of `src/index.ts` so the entry point stays a thin composition
 * root, mirroring `run-non-interactive.ts`. Called from `main()` AFTER
 * `bootSessionStores` and BEFORE the ready banner / resume header (both
 * write to stdout, which this mode's stdout-purity rule forbids) — see
 * `resume-mode.ts`'s `isHostModeRun` for the two call sites that must skip
 * those writes.
 *
 * Design: `research/2026-10-31-hostmodes-contract-draft.md` and
 * `research/2026-10-31-acp-plugin-spec-v3.md` sections 10/10a/11 (umbrella
 * repo). Level 1 scope and what is deferred: `src/host-public/host-mode.ts`'s
 * module doc.
 *
 * @module host/startup/run-host-mode
 */

import type { ModelInfoSnapshot } from "@minimal-agent/core/plugin-api/types/plugin"

import type { PromptSource } from "../../cli/extract-prompt.ts"
import type {
  HostModeContext,
  HostModelView,
  HostRuntime,
  HostSession,
} from "../../host-public/host-mode.ts"
import { buildModelInfoSnapshot } from "../../llm/model-info.ts"
import { listRegisteredModels } from "../../llm/model-registry.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import type { Session, SessionEntry } from "../../runtime/session.ts"
import type { AgentCore, TurnResult } from "../../sdk/agent-core.ts"
import { applyTurnWillStart } from "../repl-editor-hooks.ts"
import {
  type BuildAgentCoreDeps,
  createLifecyclePort,
  openAgentCoreSession,
} from "../sdk-adapters/build-agent-core.ts"

import { turnBlockedError } from "./run-non-interactive.ts"

/** Default time the entry has to end after the first shutdown signal. */
const DEFAULT_SIGNAL_GRACE_MS = 5000

/** Longest time a forced end waits for stdout to drain before it exits. */
const FORCED_EXIT_DRAIN_MS = 1000

/** Exit code for a forced end by signal: 128 plus the signal number. */
const SIGNAL_EXIT_CODE: Readonly<Record<"SIGINT" | "SIGTERM", number>> = {
  SIGINT: 130,
  SIGTERM: 143,
}

/** Everything {@link runHostMode} needs from `main()`'s already-resolved boot state. */
export interface RunHostModeInput {
  /** The matched `hostModes[].id` (`opts.hostModeId`; the caller already knows it is set). */
  readonly hostModeId: string
  /** Args after `--host-mode <id>`, handed to the entry verbatim as `ctx.argv`. */
  readonly hostModeArgv: readonly string[]
  /** The parsed prompt source, to reject `--host-mode` combined with a prompt flag. */
  readonly promptSource: PromptSource
  readonly loader: PluginLoader
  /**
   * Deps for the ONE session this process opens (Level 1 is one session
   * per process). Pass the SAME deps `InteractiveSession.create` would get
   * for the human path — host mode calls `openAgentCoreSession` with them
   * directly instead, since it needs the raw streaming `Session`, not the
   * TUI-flavored wrapper. TUI-only fields (`toolTimeTracker`,
   * `codeHighlighter`) and `initialMessages` (resume) are the caller's
   * call to make; Level 1 does not need them.
   */
  readonly sessionDeps: BuildAgentCoreDeps
  /** The already-open session id (`getSessionId()`), reused as the host-mode session's id. */
  readonly sessionId: string
  /** Fires `hostLifecycle.sessionStart`/`sessionEnd` once, like `main()` does for the human path. */
  readonly hostLifecycle: ReturnType<typeof createLifecyclePort>
  /** Writable stderr (injectable for tests). Defaults to `process.stderr`. */
  readonly stderr?: Pick<NodeJS.WriteStream, "write">
  /**
   * Time in ms the entry has to end after the first `SIGINT`/`SIGTERM`
   * before the host ends the process. Defaults to 5000.
   */
  readonly signalGraceMs?: number
  /**
   * Ends the process on a forced end (a second signal, or the grace period
   * ran out). Injectable for tests. The default waits for stdout to drain
   * (at most 1 s), then calls `process.exit` with `process.exitCode`.
   */
  readonly exitProcess?: (code: number) => void
  /**
   * Where `SIGINT`/`SIGTERM` arrive. Injectable for tests, so a test never
   * emits a real process signal. Defaults to `process`.
   */
  readonly signalSource?: Pick<NodeJS.Process, "on" | "removeListener">
}

/**
 * Run the matched host mode to completion. On a normal end it never calls
 * `process.exit` (see the module doc / `src/host-public/host-mode.ts`'s
 * stdout-purity rule): it sets `process.exitCode` and returns, letting
 * `main()`'s natural exit drain stdout. The one exception is a forced end
 * after a second signal or the signal grace period (see
 * `installSignalHandling`), which first waits for stdout to drain.
 */
export async function runHostMode(input: RunHostModeInput): Promise<void> {
  const stderr = input.stderr ?? process.stderr

  if (input.promptSource.kind !== "none") {
    stderr.write("error: --host-mode cannot be combined with --prompt, -p, or a stdin prompt\n")
    process.exitCode = 2
    return
  }

  const mode = input.loader.findHostMode(input.hostModeId)
  if (!mode) {
    stderr.write(
      `error: unknown host mode "${input.hostModeId}" (no loaded, enabled plugin contributes it)\n`,
    )
    process.exitCode = 2
    return
  }

  const runtime = buildHostRuntime(input, stderr)
  const ctx = installHostModeContext(input, runtime, stderr)

  let code: number
  try {
    code = await mode.handler(ctx)
  } catch (e) {
    stderr.write(
      `[host-mode:${input.hostModeId}] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    )
    code = 1
  } finally {
    ctx.restore()
  }
  process.exitCode = code
}

/** The {@link HostModeContext} plus a teardown function, returned by {@link installHostModeContext}. */
interface InstalledHostModeContext extends HostModeContext {
  /** Undoes the stdout guard, the `console.log` reroute, the signal listeners, and the grace wait. */
  restore(): void
}

/**
 * The default {@link RunHostModeInput.exitProcess}. It never exits right
 * after a protocol write: it waits until stdout has written all queued
 * bytes (an empty write's callback), or at most {@link FORCED_EXIT_DRAIN_MS}.
 */
function exitAfterStdoutDrain(write: NodeJS.WriteStream["write"]): (code: number) => void {
  return (code: number): void => {
    process.exitCode = code
    const exit = (): never => process.exit(code)
    // `AbortSignal.timeout` never keeps the process alive by itself, and
    // it is not a timer call for the core timer inventory.
    AbortSignal.timeout(FORCED_EXIT_DRAIN_MS).addEventListener("abort", exit, { once: true })
    write("", exit)
  }
}

/**
 * Listens for `SIGINT`/`SIGTERM` for the life of the mode. A listener
 * turns off the default exit, so a buggy entry could make the process
 * impossible to stop. To prevent that:
 * - The first signal aborts `ctx.abort` and starts a grace timer.
 * - A second signal, or the end of the grace period, ends the process
 *   with exit code 128 plus the signal number.
 * Returns a function that removes the listeners and stops the grace wait.
 */
function installSignalHandling(
  input: RunHostModeInput,
  abortController: AbortController,
  stderr: Pick<NodeJS.WriteStream, "write">,
  exitProcess: (code: number) => void,
): () => void {
  let graceSignal: AbortSignal | undefined
  let onGraceEnd: (() => void) | undefined
  let forced = false
  const forceEnd = (signal: "SIGINT" | "SIGTERM", why: string): void => {
    if (forced) return
    forced = true
    stderr.write(`[host-mode:${input.hostModeId}] ${why}; ending the process\n`)
    const code = SIGNAL_EXIT_CODE[signal]
    process.exitCode = code
    exitProcess(code)
  }
  const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (abortController.signal.aborted) {
      forceEnd(signal, `second ${signal}`)
      return
    }
    abortController.abort()
    const graceMs = input.signalGraceMs ?? DEFAULT_SIGNAL_GRACE_MS
    // `AbortSignal.timeout` never keeps the process alive after the mode
    // ends, and it is not a timer call for the core timer inventory.
    graceSignal = AbortSignal.timeout(graceMs)
    onGraceEnd = (): void => forceEnd(signal, `host mode did not end ${graceMs} ms after ${signal}`)
    graceSignal.addEventListener("abort", onGraceEnd, { once: true })
  }
  const onSigint = (): void => onSignal("SIGINT")
  const onSigterm = (): void => onSignal("SIGTERM")
  const source = input.signalSource ?? process
  source.on("SIGINT", onSigint)
  source.on("SIGTERM", onSigterm)
  return (): void => {
    if (graceSignal && onGraceEnd) graceSignal.removeEventListener("abort", onGraceEnd)
    source.removeListener("SIGINT", onSigint)
    source.removeListener("SIGTERM", onSigterm)
  }
}

/**
 * Installs the stdout-purity guard (the host owns this, not the plugin —
 * see `src/host-public/host-mode.ts`'s module doc) and builds the rest of the
 * context. ONLY the returned `ctx.stdout`'s `write` reaches the real
 * stdout for the life of the mode; every other write (a stray
 * `process.stdout.write` from anywhere else in the process, `console.log`)
 * is logged to stderr and dropped. This is the same class of bug the ACP
 * spec names at `index.ts:1074`/`:303` (a human line on stdout corrupting
 * NDJSON), closed structurally instead of file by file.
 */
function installHostModeContext(
  input: RunHostModeInput,
  runtime: HostRuntime,
  stderr: Pick<NodeJS.WriteStream, "write">,
): InstalledHostModeContext {
  const realStdoutWrite = process.stdout.write.bind(process.stdout)
  const guardedStdout = Object.create(process.stdout) as NodeJS.WriteStream
  Object.defineProperty(guardedStdout, "write", { value: realStdoutWrite, writable: false })

  const originalStdoutWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    const bytes = typeof chunk === "string" ? chunk.length : (chunk as Uint8Array)?.byteLength
    stderr.write(
      `[host-mode:${input.hostModeId}] dropped a stray stdout write (${bytes ?? "?"} bytes); ` +
        "only the entry's own ctx.stdout may write in this mode\n",
    )
    const cb = rest.find((a): a is (err?: Error) => void => typeof a === "function")
    cb?.()
    return true
  }) as typeof process.stdout.write

  const originalConsoleLog = console.log
  // biome-ignore lint/suspicious/noConsole: rerouting console.log itself, the one legal use.
  console.log = (...a: unknown[]) => console.error(...a)

  const abortController = new AbortController()
  const removeSignalHandling = installSignalHandling(
    input,
    abortController,
    stderr,
    input.exitProcess ?? exitAfterStdoutDrain(realStdoutWrite),
  )

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }

  const ctx: InstalledHostModeContext = {
    argv: input.hostModeArgv,
    stdin: process.stdin,
    stdout: guardedStdout,
    stderr: process.stderr,
    abort: abortController.signal,
    cwd: process.cwd(),
    env,
    log: {
      emergency: (source, message) => stderr.write(`[${source}] EMERGENCY: ${message}\n`),
      alert: (source, message) => stderr.write(`[${source}] ALERT: ${message}\n`),
      critical: (source, message) => stderr.write(`[${source}] CRITICAL: ${message}\n`),
      error: (source, message) => stderr.write(`[${source}] error: ${message}\n`),
      warn: (source, message) => stderr.write(`[${source}] warn: ${message}\n`),
      notice: (source, message) => stderr.write(`[${source}] ${message}\n`),
      info: (source, message) => stderr.write(`[${source}] ${message}\n`),
      debug: (source, message) => stderr.write(`[${source}] debug: ${message}\n`),
    },
    runtime,
    restore(): void {
      process.stdout.write = originalStdoutWrite
      // biome-ignore lint/suspicious/noConsole: restoring the pre-guard console.log.
      console.log = originalConsoleLog
      removeSignalHandling()
    },
  }
  return ctx
}

/**
 * Builds the {@link HostRuntime} the entry gets: one lazy session factory,
 * plus model/effort switching through context functions (never a
 * `Session`/`AgentCore` wrapper the plugin could reach around — see
 * `acp-decisions.md` item 9 and `src/host-public/host-mode.ts`'s interface doc).
 */
function buildHostRuntime(
  input: RunHostModeInput,
  stderr: Pick<NodeJS.WriteStream, "write">,
): HostRuntime {
  const { sessionDeps } = input
  let opened = false
  // Set once `openSession` builds the session; `getModel`/`setModel` read
  // and write THIS core instance from then on (the host-mode escape hatch
  // `Session.agentCore()` — a plugin never gets it directly).
  let liveAgentCore: AgentCore | null = null

  return {
    async openSession(): Promise<HostSession> {
      if (opened) {
        throw new Error(
          "HostRuntime.openSession was already called once in this process " +
            "(Level 1 is one session per process; see src/host-public/host-mode.ts)",
        )
      }
      opened = true
      const session = await openAgentCoreSession({ ...sessionDeps, sessionId: input.sessionId })
      liveAgentCore = session.agentCore()
      void input.hostLifecycle.sessionStart?.({
        sid: input.sessionId,
        cwd: process.cwd(),
        model: sessionDeps.model,
      })
      let closed = false
      const run = hostSessionRun(session, input.loader, stderr, () => closed)
      return {
        sessionId: input.sessionId,
        run,
        answer: (askId, answer) => session.answer(askId, answer),
        async close(): Promise<void> {
          closed = true
          session.close()
          void input.hostLifecycle.sessionEnd?.({ sid: input.sessionId })
        },
      }
    },
    listModels(): readonly HostModelView[] {
      const providerId = sessionDeps.providerId
      return listRegisteredModels()
        .filter((m) => providerId === undefined || m.providerId === providerId)
        .map((m) => ({ id: m.id, label: m.displayName }))
    },
    modelInfo(id: string): ModelInfoSnapshot | undefined {
      const snap = buildModelInfoSnapshot(id, sessionDeps.providerId)
      return snap.resolved ? snap : undefined
    },
    getModel(): string {
      return liveAgentCore?.getModel() ?? sessionDeps.model
    },
    setModel(id: string): void {
      if (!liveAgentCore) throw new Error("setModel: no session open yet (call openSession first)")
      // AgentCore.setModel is the checked setter (registry check scoped to
      // the session's provider, effort reset when it no longer fits; throws
      // on an unknown id with state unchanged).
      liveAgentCore.setModel(id)
    },
    getEffort(): string | undefined {
      // Once a session is open, the live core is the only truth: its
      // effort can be `undefined` (the model default) after setModel
      // reset it. The boot value applies only before any session exists.
      return liveAgentCore ? liveAgentCore.getEffort() : sessionDeps.effort
    },
    setEffort(level: string | undefined): void {
      if (!liveAgentCore) throw new Error("setEffort: no session open yet (call openSession first)")
      // AgentCore.setEffort validates against the current model's effort
      // levels and throws on a bad value, state unchanged.
      liveAgentCore.setEffort(level)
    },
  }
}

/**
 * Builds {@link HostSession.run}: `Session.run`, with the `turn.willStart`
 * chain applied first, the same way `run-non-interactive.ts` applies it
 * (`applyTurnWillStart`). A hook can rewrite the prompt text. A halting
 * hook stops the turn before any model request: the iterable throws, and
 * `result` rejects, with the same `turn.blocked` error
 * ({@link turnBlockedError}) the one-shot run uses. The session stays
 * usable for the next prompt.
 *
 * The hook chain is async, so the real `Session.run` starts after it.
 * To keep the "already running" and "closed" errors synchronous, this
 * wrapper checks both itself before it starts the chain.
 */
function hostSessionRun(
  session: Session,
  loader: PluginLoader,
  stderr: Pick<NodeJS.WriteStream, "write">,
  isClosed: () => boolean,
): HostSession["run"] {
  let busy = false
  return (text, options) => {
    if (isClosed()) throw new Error(`session ${session.id} is closed`)
    if (busy) throw new Error(`session ${session.id} already has a run in progress`)
    busy = true
    const idle = (): void => {
      busy = false
    }
    const started = (async (): Promise<
      AsyncIterable<SessionEntry> & { readonly result: Promise<TurnResult> }
    > => {
      const turn = await applyTurnWillStart(loader, text)
      if (turn.halted) {
        const err = turnBlockedError()
        stderr.write(`${err.message}\n`)
        throw err
      }
      const inner = session.run(turn.text, options)
      // Attached before any caller reads the entries, so `busy` is clear
      // before the entry stream ends for the caller.
      inner.result.then(idle, idle)
      return inner
    })()
    started.catch(idle)
    const result = started.then((inner) => inner.result)
    // Same rule as `Session.run`: a caller that only reads the entries
    // must not see an unhandled rejection of `result`.
    result.catch(() => {})
    return {
      result,
      [Symbol.asyncIterator](): AsyncIterator<SessionEntry> {
        return (async function* drain(): AsyncGenerator<SessionEntry, void, undefined> {
          yield* await started
        })()
      },
    }
  }
}
