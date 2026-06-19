/**
 * DiagnosticsService — the plugin's composition root (Facade).
 *
 * Wires detection → providers → runner under a config, and exposes the single
 * `check(path, text)` the hook handler calls. Holds the persistent runner for
 * the session (so the tsgo LSP child is reused across edits) and disposes it on
 * teardown.
 *
 * Built lazily + memoized per root, so the first relevant Edit boots the
 * server and subsequent edits reuse it. All construction is driven by
 * {@link detectTools}, so a project with no tools yields a no-op service.
 *
 * @module plugins/diagnostics/lib/service
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import type { DiagnosticsConfig } from "./config.ts"
import { detectTools } from "./detect.ts"
import { filterFindings, formatNote } from "./format-notes.ts"
import type { DiagnosticProvider } from "./provider.ts"
import { DiagnosticsRunner } from "./runner.ts"
import type { Finding } from "./types.ts"

/** Factory hooks injected for testability (real impls spawn processes). */
export interface ProviderFactories {
  makeTsgo(bin: string, root: string): DiagnosticProvider
  makeBiome(bin: string, root: string): DiagnosticProvider
  makeOxlint(bin: string, root: string): DiagnosticProvider
  makeTsc(bin: string, root: string): DiagnosticProvider
  makeTscDirect(bin: string, root: string): DiagnosticProvider
  makeSourceKit(bin: string, root: string): DiagnosticProvider
}

export interface ServiceCheckResult {
  /** Findings to render (already filtered by severity floor + cap). */
  findings: Finding[]
  /** Model-facing note lines (one per kept finding). */
  notes: string[]
  /** Providers that degraded this run. */
  degraded: string[]
}

/**
 * Session-scoped facade over the diagnostics pipeline: lazily detects which
 * tools (biome/oxlint/tsgo) exist in the workspace, builds the provider
 * runner once, and turns raw findings into severity-filtered, capped,
 * model-facing note lines per checked file.
 */
export class DiagnosticsService {
  private runner: DiagnosticsRunner | null = null
  private built = false
  private tscBin: string | null = null

  constructor(
    private readonly root: string,
    private readonly config: DiagnosticsConfig,
    private readonly factories: ProviderFactories,
  ) {}

  /** Build the runner from detected tools, honoring config gates. Memoized. */
  private ensureRunner(): DiagnosticsRunner | null {
    if (this.built) return this.runner
    this.built = true
    const detected = detectTools(this.root)
    const providers: DiagnosticProvider[] = []
    for (const t of detected) {
      if (t.id === "tsgo" && this.config.type) {
        providers.push(this.factories.makeTsgo(t.bin, this.root))
      } else if (t.id === "tsc" && this.config.type) {
        providers.push(this.factories.makeTsc(t.bin, this.root))
        this.tscBin = t.bin
      } else if (t.id === "biome" && this.config.format) {
        providers.push(this.factories.makeBiome(t.bin, this.root))
      } else if (t.id === "oxlint" && this.config.lint) {
        providers.push(this.factories.makeOxlint(t.bin, this.root))
      } else if (t.id === "sourcekit-lsp" && this.config.apple) {
        providers.push(this.factories.makeSourceKit(t.bin, this.root))
      }
    }
    this.runner =
      providers.length > 0
        ? new DiagnosticsRunner(providers, { timeoutMs: this.config.timeoutMs })
        : null

    // Stash tsc bin for the out-of-scope fallback. The detection loop may have
    // skipped tsc when tsgo was present (suppressedBy), so probe the binary
    // independently of detection.
    if (!this.tscBin) {
      const tscPath = join(this.root, "node_modules", ".bin", "tsc")
      if (existsSync(tscPath)) this.tscBin = tscPath
    }

    return this.runner
  }

  /** True when at least one provider would handle `path`. */
  handles(path: string): boolean {
    const runner = this.ensureRunner()
    return runner?.handles(path) ?? false
  }

  /**
   * Run diagnostics for the proposed `text` at `path`, returning rendered
   * findings + model notes (filtered). Resolves with empty arrays when nothing
   * applies. Never throws.
   */
  async check(path: string, text: string): Promise<ServiceCheckResult> {
    if (!this.config.enabled) return { findings: [], notes: [], degraded: [] }
    const runner = this.ensureRunner()
    if (!runner || !runner.handles(path)) return { findings: [], notes: [], degraded: [] }

    const report = await runner.check(path, text)
    let findings = report.findings
    let degraded = report.degraded

    // Out-of-scope fallback: if the normal providers returned nothing,
    // the file is outside project scope, and outOfScope is enabled, try
    // tsc-direct which bypasses the project config. Skip when the file
    // IS in type scope (clean file, not excluded) to avoid a wasted spawn.
    if (
      findings.length === 0 &&
      this.config.type &&
      this.config.outOfScope.enabled &&
      this.tscBin &&
      !runner.isInTypeScope(path)
    ) {
      const directProvider = this.factories.makeTscDirect(this.tscBin, this.root)
      if (directProvider.handles(path)) {
        try {
          const directFindings = await directProvider.check(path, text)
          findings = [...findings, ...directFindings]
        } catch {
          // direct provider failure: degrade silently
        }
      }
    }

    const kept = filterFindings(findings, {
      severityFloor: this.config.severityFloor,
      max: this.config.maxInline,
    })
    return { findings: kept, notes: kept.map(formatNote), degraded }
  }

  dispose(): void {
    this.runner?.dispose()
    this.runner = null
  }

  /** Returns ids of persistent LSP providers whose server is currently booted and alive. */
  getActivePersistentProviders(): string[] {
    return this.runner?.getActivePersistentProviders() ?? []
  }
}
