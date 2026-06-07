/**
 * tsgo provider (TypeScript type diagnostics) over a PERSISTENT LSP server.
 *
 * This is the highest-value signal : type errors grep and lint can't see. A
 * persistent `tsgo --lsp -stdio` answers per-edit pulls in 2-3ms (vs ~316ms to
 * spawn `tsgo --noEmit` cold), so the server is booted ONCE (lazily, on the
 * first TS check) and reused.
 *
 * Resilience: a {@link CircuitBreaker} guards the child. A crash/timeout
 * records a failure; once the breaker opens, checks return [] (degraded) until
 * a cooldown permits a restart trial. After too many trips the breaker goes
 * `dead` and the provider stays quiet for the session : never a crash, never a
 * hot restart loop.
 *
 * @module plugins/diagnostics/providers/tsgo-provider
 */
import { adaptLspDiagnostics } from "../adapters/lsp.ts"
import { CircuitBreaker } from "../lib/circuit-breaker.ts"
import { LspClient } from "../lib/lsp-client.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

export class TsgoLspProvider implements DiagnosticProvider {
  readonly id = "tsgo"
  readonly kind = "type" as const

  private client: LspClient | null = null
  private booting: Promise<LspClient> | null = null
  private readonly breaker = new CircuitBreaker({ maxFailures: 2, cooldownMs: 10_000, maxTrips: 5 })

  constructor(
    private readonly bin: string,
    private readonly root: string,
  ) {}

  handles(path: string): boolean {
    return EXT_RE.test(path)
  }

  /** Lazily boot (or reuse) the LSP child. Honors the breaker. */
  private async ensureClient(): Promise<LspClient | null> {
    if (!this.breaker.canAttempt()) return null
    if (this.client && !this.client.dead) return this.client
    if (this.booting) return this.booting

    this.booting = (async () => {
      const client = new LspClient([this.bin, "--lsp", "-stdio"], this.root)
      client.onExit(() => {
        // Unexpected exit: drop the handle so the next check reboots (subject
        // to the breaker). The breaker failure is recorded by `check`.
        if (this.client === client) this.client = null
      })
      await client.whenReady()
      this.client = client
      return client
    })()

    try {
      const c = await this.booting
      return c
    } finally {
      this.booting = null
    }
  }

  async check(path: string, text: string): Promise<Finding[]> {
    let client: LspClient | null
    try {
      client = await this.ensureClient()
    } catch {
      this.breaker.recordFailure()
      return []
    }
    if (!client) return [] // breaker open/dead → degrade silently

    try {
      client.sync(path, text)
      const items = await client.pullDiagnostics(path)
      this.breaker.recordSuccess()
      return adaptLspDiagnostics(items, this.id)
    } catch {
      this.breaker.recordFailure()
      // Drop a possibly-wedged client so the next call reboots.
      if (this.client) {
        try {
          this.client.dispose()
        } catch {
          /* ignore */
        }
        this.client = null
      }
      return []
    }
  }

  dispose(): void {
    this.client?.dispose()
    this.client = null
  }
}
