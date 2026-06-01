/**
 * The imperative shell around launching + probing worker processes.
 *
 * All OS interaction (spawn, pid-liveness, reading the result sentinel) is
 * funnelled through injected {@link SpawnDeps} / {@link ProbeDeps} so the
 * surrounding logic is unit-testable with fakes — the real `Bun.spawn` /
 * `process.kill` / `readFileSync` live only in {@link realSpawnDeps} /
 * {@link realProbeDeps}.
 *
 * Result transport is the "subagent output to filesystem" pattern (Anthropic's
 * game-of-telephone fix): a worker writes a tiny `<id>.result.json` sentinel as
 * its last act; the supervisor reads THAT, not the worker's transcript. When
 * the sentinel is absent the supervisor falls back to the clean-exit
 * placeholder in {@link supervisorTick}.
 *
 * @module sub-agents/lib/spawn
 */

import { existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs"
import { dirname } from "node:path"

import { parseFinalText, parseProgress } from "./progress.ts"
import type { SpawnPlan } from "./spawn-plan.ts"
import type { WorkerProbe } from "./supervisor.ts"
import { err, ok, type Progress, type Result, type ResultDigest } from "./types.ts"

/** Env key telling a worker where to write its result sentinel. */
export const ENV_RESULT_PATH = "MINIMAL_AGENT_SUBAGENT_RESULT_PATH"

// ---------------------------------------------------------------------------
// Injected dependencies (DIP — fakes in tests, real OS calls in prod)
// ---------------------------------------------------------------------------

/** Side-effects needed to launch a worker. */
export interface SpawnDeps {
  /** Launch a detached process; return its pid. Throws on failure. */
  readonly launch: (argv: readonly string[], opts: { cwd: string; env: Record<string, string>; logPath: string }) => number
}

/** Side-effects needed to probe a worker. */
export interface ProbeDeps {
  /** True if the pid is still alive. */
  readonly pidAlive: (pid: number) => boolean
  /** Read + validate the worker's result sentinel, or `undefined` if absent/malformed. */
  readonly readResult: (path: string) => ResultDigest | undefined
  /** Derive live progress from the worker's transcript, or `undefined` if unreadable. */
  readonly readProgress?: (transcriptPath: string) => Progress | undefined
  /**
   * Distill the worker's FINAL assistant message from its transcript, or
   * `undefined` when there is none. The fallback when no sentinel was written.
   */
  readonly readFinalText?: (transcriptPath: string) => string | undefined
  /**
   * Of the given paths, return those that DON'T exist or are empty. Used to
   * enforce the `expectArtifacts` contract (FIX 4). Pure list in, list out.
   */
  readonly missingArtifacts?: (paths: readonly string[]) => string[]
  /** Exit code of an exited pid, if known (best-effort; `undefined` when unknowable). */
  readonly exitCode?: (pid: number) => number | undefined
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/**
 * Execute a {@link SpawnPlan}: launch the worker. (The `fork` isolation tier
 * needs no pre-step — the plan's argv carries `--resume <leadSid>`, and the
 * agent's own resume path forks the lead's history into the child's pinned
 * sid.) Returns the pid in a {@link Result} (no throw).
 */
export function launchWorker(plan: SpawnPlan, deps: SpawnDeps, logPath: string): Result<number> {
  try {
    const pid = deps.launch(plan.argv, { cwd: plan.cwd, env: plan.env, logPath })
    return ok(pid)
  } catch (e) {
    return err(`spawn failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** What {@link probeWorker} needs to locate a worker's files. */
export interface ProbeTarget {
  readonly pid: number
  readonly resultPath: string
  readonly transcriptPath: string
  /** Paths the worker was contracted to produce (the `expectArtifacts` set). */
  readonly expectArtifacts?: readonly string[]
}

/**
 * Build a {@link WorkerProbe} for a running worker: is it alive (and if so its
 * live progress), did it leave a result sentinel, what was its exit code. Pure
 * given the deps.
 */
export function probeWorker(target: ProbeTarget, deps: ProbeDeps): WorkerProbe {
  const alive = deps.pidAlive(target.pid)
  if (alive) {
    const progress = deps.readProgress?.(target.transcriptPath)
    return { alive: true, ...(progress ? { progress } : {}) }
  }
  const rawResult = deps.readResult(target.resultPath)
  // FIX 3: a worker can CLAIM artifacts in its sentinel without writing them.
  // Cross-check the sentinel's own `artifacts[]` and prepend a loud warning to
  // the summary for any that are missing/empty, so a forgetful/lying worker is
  // caught automatically. The worker still counts as `done` (it reported), but
  // the lead reads the discrepancy.
  const result = rawResult ? warnMissingDeclared(rawResult, deps) : undefined
  const exitCode = deps.exitCode?.(target.pid)
  // Distillation fallback: only bother reading the final message when the worker
  // left NO structured sentinel — the sentinel always wins (see supervisorTick
  // precedence). This keeps a sentinel-writing worker's probe cheap.
  const distilled = result ? undefined : deps.readFinalText?.(target.transcriptPath)
  // Enforce the deliverable contract: which expected artifacts are missing/empty?
  const missingArtifacts =
    target.expectArtifacts && target.expectArtifacts.length > 0
      ? deps.missingArtifacts?.(target.expectArtifacts)
      : undefined
  return {
    alive: false,
    ...(result ? { result } : {}),
    ...(distilled ? { distilled } : {}),
    ...(missingArtifacts && missingArtifacts.length > 0 ? { missingArtifacts } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  }
}

/**
 * FIX 3: cross-check a sentinel's self-declared `artifacts[]` against disk and
 * prepend a `⚠ N/M artifacts missing: …` note to `short` for any that don't
 * exist or are empty. Pure given `deps.missingArtifacts`; a no-op when the
 * sentinel declared no artifacts or the dep is absent.
 */
export function warnMissingDeclared(result: ResultDigest, deps: ProbeDeps): ResultDigest {
  const declared = result.artifacts
  if (!declared || declared.length === 0 || !deps.missingArtifacts) return result
  const missing = deps.missingArtifacts(declared)
  if (missing.length === 0) return result
  const warn = `⚠ ${missing.length}/${declared.length} declared artifact(s) missing: ${missing.join(", ")}. `
  return { ...result, short: warn + result.short }
}

// ---------------------------------------------------------------------------
// Real implementations
// ---------------------------------------------------------------------------

/** Validate an untrusted parsed object as a {@link ResultDigest}. */
export function parseResultDigest(raw: unknown): ResultDigest | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.short !== "string") return undefined
  const tokens = typeof o.tokens === "number" && Number.isFinite(o.tokens) ? o.tokens : 0
  const tools = typeof o.tools === "number" && Number.isFinite(o.tools) ? o.tools : 0
  const artifacts = Array.isArray(o.artifacts) ? o.artifacts.filter((a): a is string => typeof a === "string") : undefined
  return { short: o.short, tokens, tools, ...(artifacts && artifacts.length > 0 ? { artifacts } : {}) }
}

/** Production spawn deps: detached `Bun.spawn` with stdout/stderr → a log file. */
export function realSpawnDeps(): SpawnDeps {
  return {
    launch: (argv, opts) => {
      mkdirSync(dirname(opts.logPath), { recursive: true })
      const fd = openSync(opts.logPath, "a")
      // `Bun.spawn` is available in the agent runtime. Detach so the worker
      // outlives a lead crash; pipe stdio to the log; no stdin.
      const proc = (globalThis as unknown as { Bun: { spawn: (cmd: string[], o: object) => { pid: number } } }).Bun.spawn(
        [...argv],
        // The plan env is an OVERLAY: a real worker still needs the parent's
        // PATH / HOME / credentials, so merge process.env underneath it.
        { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdin: "ignore", stdout: fd, stderr: fd },
      )
      return proc.pid
    },
  }
}

/** Injectable IO for {@link cachedProgressReader} (tests stub these). */
export interface ProgressReaderDeps {
  /** mtime (ms) of a file, or `null` when absent/unreadable. */
  readonly stat: (path: string) => number | null
  readonly read: (path: string) => string
  readonly parse: (text: string) => Progress
}

/**
 * A progress reader that re-parses a worker's transcript ONLY when its mtime
 * changed since the last read. At a fleet of 100 workers the supervisor probes
 * every second; without this it would re-parse 100 transcripts/s even when
 * idle. The cache is keyed by path; bounded by the number of distinct workers.
 */
export function cachedProgressReader(deps: ProgressReaderDeps): (path: string) => Progress | undefined {
  const cache = new Map<string, { mtimeMs: number; progress: Progress }>()
  return (path: string) => {
    const mtimeMs = deps.stat(path)
    if (mtimeMs === null) return undefined
    const hit = cache.get(path)
    if (hit && hit.mtimeMs === mtimeMs) return hit.progress
    const progress = deps.parse(deps.read(path))
    cache.set(path, { mtimeMs, progress })
    return progress
  }
}

/** Production probe deps: `process.kill(pid, 0)` liveness + sentinel JSON read. */
export function realProbeDeps(): ProbeDeps {
  const readProgress = cachedProgressReader({
    stat: (p) => {
      try {
        return statSync(p).mtimeMs
      } catch {
        return null
      }
    },
    read: (p) => readFileSync(p, "utf-8"),
    parse: parseProgress,
  })
  return {
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    readResult: (path) => {
      if (!existsSync(path)) return undefined
      try {
        return parseResultDigest(JSON.parse(readFileSync(path, "utf-8")))
      } catch {
        return undefined
      }
    },
    readProgress,
    readFinalText: (path) => {
      try {
        return parseFinalText(readFileSync(path, "utf-8"))
      } catch {
        return undefined
      }
    },
    missingArtifacts: (paths) =>
      paths.filter((p) => {
        try {
          // missing if it doesn't exist OR exists but is empty (0 bytes)
          return statSync(p).size === 0
        } catch {
          return true
        }
      }),
  }
}
