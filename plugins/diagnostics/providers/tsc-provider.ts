/**
 * tsc provider (TypeScript type diagnostics) via spawn-based `tsc --noEmit`.
 *
 * This is the FALLBACK type provider for projects that have the standard
 * `typescript` package (tsc / tsserver) but NOT the `tsgo` Go-native preview
 * compiler. Detection prefers `tsgo` when both are present.
 *
 * Unlike the persistent LSP providers, this spawns `tsc --noEmit` per check
 * and parses its stdout. It checks the ENTIRE project, then filters findings
 * to the target file. Warm-up is ~300-500ms vs tsgo's ~2-3ms; it's perfectly
 * adequate for small-to-medium projects and is always available.
 *
 * Resilience: a non-zero exit from tsc is EXPECTED (it means errors were
 * found). Only a spawn failure (ENOENT, signal) degrades.
 *
 * @module plugins/diagnostics/providers/tsc-provider
 */
import { adaptTscOutput } from "../adapters/tsc.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

import { runCapture } from "./spawn.ts"

const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/**
 * Spawn-based type-checking provider backed by `tsc --noEmit`.
 * Stateless: every `check` call is a fresh `tsc` subprocess.
 */
export class TscSpawnProvider implements DiagnosticProvider {
  readonly id = "tsc"
  readonly kind = "type" as const

  constructor(
    private readonly bin: string,
    private readonly root: string,
  ) {}

  handles(path: string): boolean {
    return EXT_RE.test(path)
  }

  async check(path: string, _text: string, signal?: AbortSignal): Promise<Finding[]> {
    // `tsc --noEmit` checks the whole project. The file must already
    // be on disk (the hook runs POST-Write, so it is). We ignore
    // `_text` because tsc reads from the filesystem, not a buffer.
    try {
      const result = await runCapture(this.bin, ["--noEmit", "--pretty", "false"], {
        cwd: this.root,
        signal,
      })

      // tsc exits non-zero when it finds errors — that's success for us.
      // Only treat a missing binary or signal kill as failure.
      const findings = adaptTscOutput(result.stdout, this.id, path)
      return findings
    } catch {
      // Spawn failure (ENOENT, etc.) — degrade silently.
      return []
    }
  }

  dispose(): void {
    // No persistent state to release.
  }

  isActive?(): boolean {
    // Spawn-based: never "active" in the persistent sense.
    return false
  }
}
