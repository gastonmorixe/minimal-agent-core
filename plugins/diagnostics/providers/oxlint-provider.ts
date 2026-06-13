/**
 * Oxlint provider (lint), spawn-per-call.
 *
 * Oxlint has no stdin mode, so it checks the file ON DISK : which is exactly
 * the just-written file after an Edit/Write. Startup-bound (~400ms measured),
 * so the runner keeps it off the critical path via its timeout + concurrency,
 * and config defaults it to opt-in. `-f json` feeds {@link adaptOxlint}.
 *
 * @module plugins/diagnostics/providers/oxlint-provider
 */
import { relative } from "node:path"

import { adaptOxlint } from "../adapters/oxlint.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

import { runCapture } from "./spawn.ts"

const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/**
 * Diagnostic provider that shells out to the workspace's oxlint binary
 * (`--format=json`) for one file and adapts the output to findings. Only
 * handles JS/TS-family paths inside the workspace root.
 */
export class OxlintProvider implements DiagnosticProvider {
  readonly id = "oxlint"
  readonly kind = "lint" as const

  constructor(
    private readonly bin: string,
    private readonly root: string,
  ) {}

  handles(path: string): boolean {
    return EXT_RE.test(path)
  }

  async check(path: string, _text: string, signal?: AbortSignal): Promise<Finding[]> {
    // path.relative (not startsWith+slice): `/repo-other` must not match
    // root `/repo` and yield a garbage suffix.
    const relPath = relative(this.root, path)
    const rel = relPath.startsWith("..") ? path : relPath
    const res = await runCapture(this.bin, ["-f", "json", rel], {
      cwd: this.root,
      ...(signal ? { signal } : {}),
    })
    return adaptOxlint(res.stdout)
  }

  dispose(): void {
    /* stateless */
  }
}
