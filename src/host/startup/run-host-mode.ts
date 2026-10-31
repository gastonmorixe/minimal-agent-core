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
import type { AgentCore } from "../../sdk/agent-core.ts"
import {
  type BuildAgentCoreDeps,
  createLifecyclePort,
  openAgentCoreSession,
} from "../sdk-adapters/build-agent-core.ts"

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
}

/**
 * Run the matched host mode to completion. Never calls `process.exit`
 * (see the module doc / `src/host-public/host-mode.ts`'s stdout-purity rule): sets
 * `process.exitCode` and returns, letting `main()`'s natural exit drain
 * stdout.
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

  const runtime = buildHostRuntime(input)
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
  /** Undoes the stdout guard, the `console.log` reroute, and the signal listeners. */
  restore(): void
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
  const onSignal = (): void => abortController.abort()
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

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
      process.removeListener("SIGINT", onSignal)
      process.removeListener("SIGTERM", onSignal)
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
function buildHostRuntime(input: RunHostModeInput): HostRuntime {
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
      return {
        sessionId: input.sessionId,
        run: (run_input, options) => session.run(run_input, options),
        answer: (askId, answer) => session.answer(askId, answer),
        async close(): Promise<void> {
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
      return liveAgentCore?.getEffort() ?? sessionDeps.effort
    },
    setEffort(level: string | undefined): void {
      if (!liveAgentCore) throw new Error("setEffort: no session open yet (call openSession first)")
      // AgentCore.setEffort validates against the current model's effort
      // levels and throws on a bad value, state unchanged.
      liveAgentCore.setEffort(level)
    },
  }
}
