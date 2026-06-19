/**
 * DiagnosticsRunner — Facade over a set of injected {@link DiagnosticProvider}s.
 *
 * Responsibilities:
 *  - run every provider that `handles(path)` CONCURRENTLY (the slow oxlint never
 *    blocks the fast tsgo),
 *  - bound each provider by a timeout (a hung LSP degrades, doesn't freeze),
 *  - convert a throw/timeout into a degraded entry instead of propagating
 *    (providers never crash the hook),
 *  - merge findings + record per-provider timings.
 *
 * Dependency Injection: providers are passed in, so the runner is tested with
 * fakes and never spawns anything itself. Functional-core friendly: the merge /
 * timing / degrade logic is deterministic given the providers' outcomes.
 *
 * @module plugins/diagnostics/lib/runner
 */
import type { DiagnosticProvider } from "./provider.ts"
import type { Finding } from "./types.ts"

export interface DiagnosticsReport {
  /** Merged findings from all providers that ran successfully. */
  findings: Finding[]
  /** Ids of providers that failed or timed out (UI can say "type: n/a"). */
  degraded: string[]
  /** Per-provider wall-clock in ms (by provider id). */
  timings: Record<string, number>
}

export interface RunnerOptions {
  /** Per-provider timeout in ms. Default 2000. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 2000

/** Race a promise against an abort-driven timeout. */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await Promise.race([
      work(ctrl.signal),
      new Promise<never>((_res, rej) => {
        ctrl.signal.addEventListener(
          "abort",
          () => rej(new Error(`timed out after ${timeoutMs}ms`)),
          { once: true },
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fans one file check out to every provider that handles the path, in
 * parallel with a shared timeout. Provider failures and timeouts degrade
 * (the provider is reported in `degraded`) rather than failing the run, so
 * one broken linter never blocks the others' findings.
 */
export class DiagnosticsRunner {
  private readonly timeoutMs: number

  constructor(
    private readonly providers: DiagnosticProvider[],
    opts: RunnerOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** True when at least one provider would handle `path`. */
  handles(path: string): boolean {
    return this.providers.some((p) => p.handles(path))
  }

  /**
   * Check `path` (proposed `text`) across all matching providers. Always
   * resolves: failures land in `degraded`, successes in `findings`.
   */
  async check(path: string, text: string): Promise<DiagnosticsReport> {
    const active = this.providers.filter((p) => p.handles(path))
    const findings: Finding[] = []
    const degraded: string[] = []
    const timings: Record<string, number> = {}

    await Promise.all(
      active.map(async (p) => {
        const t0 = performance.now()
        try {
          const diags = await withTimeout((signal) => p.check(path, text, signal), this.timeoutMs)
          timings[p.id] = Math.round(performance.now() - t0)
          for (const d of diags) findings.push(d)
        } catch {
          timings[p.id] = Math.round(performance.now() - t0)
          degraded.push(p.id)
        }
      }),
    )

    return { findings, degraded, timings }
  }

  /** Dispose every provider (idempotent per provider). */
  dispose(): void {
    for (const p of this.providers) p.dispose()
  }

  /** Returns ids of persistent providers whose server is currently booted and alive. */
  getActivePersistentProviders(): string[] {
    return this.providers.filter((p) => p.isActive?.() ?? false).map((p) => p.id)
  }

  /**
   * True when a type provider considers `path` to be inside its project scope.
   * Defaults to false when no provider implements inScope, erring on the side of
   * running the out-of-scope fallback (a wasted spawn is better than a missed error).
   */
  isInTypeScope(path: string): boolean {
    const typeProviders = this.providers.filter((p) => p.kind === "type")
    if (typeProviders.length === 0) return true
    const answers = typeProviders
      .map((p) => p.inScope?.(path))
      .filter((a): a is boolean => a !== undefined)
    if (answers.length === 0) return false // nobody implemented inScope → can't tell, allow fallback
    return answers.some((a) => a)
  }
}
