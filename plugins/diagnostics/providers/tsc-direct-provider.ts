/**
 * tsc-direct provider — out-of-scope type fallback.
 *
 * When the normal tsgo/tsc providers return nothing (file outside tsconfig
 * `include`), this provider runs `tsc --noEmit --strict --pretty false <FILE>`
 * directly, bypassing the project config. Every finding is tagged
 * `scope: "ad-hoc"` so the model knows it's a harness fallback, not the
 * project's own linting.
 *
 * Stateless spawn-per-check; ~300-500ms warm.
 *
 * @module plugins/diagnostics/providers/tsc-direct-provider
 */
import { adaptTscOutput } from "../adapters/tsc.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

import { runCapture } from "./spawn.ts"

const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** Runs `tsc --noEmit` directly on a file bypassing tsconfig, for ad-hoc type checking. */
export class TscDirectProvider implements DiagnosticProvider {
  readonly id = "tsc-direct"
  readonly kind = "type" as const

  constructor(
    private readonly bin: string,
    private readonly root: string,
  ) {}

  handles(path: string): boolean {
    return EXT_RE.test(path)
  }

  async check(path: string, _text: string, signal?: AbortSignal): Promise<Finding[]> {
    try {
      const result = await runCapture(
        this.bin,
        ["--noEmit", "--strict", "--pretty", "false", "--ignoreConfig", path],
        {
          cwd: this.root,
          signal,
        },
      )
      const findings = adaptTscOutput(result.stdout, this.id, path)
      for (const f of findings) f.scope = "ad-hoc"
      return findings
    } catch {
      return []
    }
  }

  dispose(): void {}

  isActive(): boolean {
    return false
  }
}
