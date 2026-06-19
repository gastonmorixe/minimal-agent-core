/**
 * SourceKit-LSP provider (Swift, Obj-C, C, C++ diagnostics) over a PERSISTENT
 * LSP server.
 *
 * Uses `sourcekit-lsp` from PATH (Xcode toolchain) as a long-lived LSP server
 * that speaks the standard LSP protocol over stdio. Covers Swift, Obj-C (.h,
 * .m, .mm), and C/C++ files via clangd which sourcekit-lsp wraps internally.
 *
 * Resilience mirrors {@link TsgoLspProvider}: a {@link CircuitBreaker} guards
 * the child. A crash/timeout records a failure; once the breaker opens, checks
 * return [] (degraded) until a cooldown permits a restart trial. After too many
 * trips the breaker goes `dead` and the provider stays quiet for the session.
 *
 * @module plugins/diagnostics/providers/sourcekit-lsp-provider
 */
import { adaptLspDiagnostics } from "../adapters/lsp.ts"
import { CircuitBreaker } from "../lib/circuit-breaker.ts"
import { LspClient } from "../lib/lsp-client.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

const EXT_RE = /\.(swift|h|m|mm|c|cpp|cc|cxx|hpp|hxx)$/

/**
 * Per-pull ceiling. SourceKit-LSP init can be slow (~3-5s first time), but
 * warm pulls are fast. The circuit breaker handles the slow init.
 */
const PULL_TIMEOUT_MS = 5000

/** Race `p` against a deadline. Rejects with `lsp pull timeout` on expiry. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_res, rej) => {
    timer = setTimeout(() => rej(new Error("lsp pull timeout")), ms)
  })
  return Promise.race([p, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  }) as Promise<T>
}

/**
 * Diagnostic provider backed by a long-lived `sourcekit-lsp` LSP server for
 * Swift, Obj-C, and C/C++ files. Boots the server lazily (sharing one boot
 * promise across concurrent checks), pulls diagnostics per file with a
 * timeout, and wraps every interaction in a {@link CircuitBreaker} for
 * resilience.
 */
export class SourceKitLspProvider implements DiagnosticProvider {
  readonly id = "sourcekit-lsp"
  readonly kind = "apple" as const

  private client: LspClient | null = null
  private booting: Promise<LspClient> | null = null
  private readonly breaker = new CircuitBreaker({ maxFailures: 2, cooldownMs: 15_000, maxTrips: 5 })

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
      // sourcekit-lsp on Xcode 27+ doesn't use --stdio; it defaults to LSP
      // over stdio when no subcommand is given.
      const client = new LspClient([this.bin], this.root, { initTimeoutMs: 10_000 })
      client.onExit(() => {
        if (this.client === client) this.client = null
      })
      try {
        await client.whenReady()
      } catch (err) {
        try {
          client.dispose()
        } catch {
          /* already gone */
        }
        throw err
      }
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
    if (!client) return [] // breaker open/dead -> degrade silently

    try {
      client.sync(path, text)
      const items = await withTimeout(client.pullDiagnostics(path), PULL_TIMEOUT_MS)
      this.breaker.recordSuccess()
      return adaptLspDiagnostics(items, this.id)
    } catch {
      this.breaker.recordFailure()
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

  isActive(): boolean {
    return this.client !== null && !this.client.dead
  }
}
