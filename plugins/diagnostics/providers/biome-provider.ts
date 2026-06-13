/**
 * Biome provider (format + assist + biome's own lint pass), spawn-per-call.
 *
 * Biome is fast (~60ms/file measured). We check the file ON DISK rather than
 * via `--stdin-file-path`: the `tool.didInvoke` hook fires AFTER the Edit/Write
 * has already written the file, so disk == the proposed text, and disk mode is
 * the one that emits clean `--reporter=json` on stdout (stdin mode instead
 * echoes the formatted source and routes status to stderr, which is unusable
 * here). `--reporter=json` feeds the {@link adaptBiome} adapter.
 *
 * @module plugins/diagnostics/providers/biome-provider
 */
import { relative } from "node:path"

import { adaptBiome } from "../adapters/biome.ts"
import type { DiagnosticProvider } from "../lib/provider.ts"
import type { Finding } from "../lib/types.ts"

import { runCapture } from "./spawn.ts"

const EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|css)$/

/**
 * Diagnostic provider that shells out to the workspace's biome binary
 * (`biome check --reporter=json`) for one file and adapts the output to
 * findings. Only handles paths inside the workspace root with extensions
 * biome formats/lints.
 */
export class BiomeProvider implements DiagnosticProvider {
  readonly id = "biome"
  readonly kind = "format" as const

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
    const res = await runCapture(this.bin, ["check", "--reporter=json", rel], {
      cwd: this.root,
      ...(signal ? { signal } : {}),
    })
    return adaptBiome(res.stdout)
  }

  dispose(): void {
    /* stateless */
  }
}
