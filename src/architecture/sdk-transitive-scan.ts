/**
 * Transitive runtime import closure of one SDK entry file. The SDK port
 * boundary scanner checks only direct edges, so a shim outside `src/sdk/`
 * can carry a forbidden import into the SDK. This walk follows the static,
 * relative, non-`import type` edges and lists each forbidden file it reaches
 * with the file that imports it.
 *
 * @module architecture/sdk-transitive-scan
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, normalize } from "node:path"

/** Static relative `import ... from` / `export ... from` / bare `import "x"`, not `import type`. */
const RUNTIME_EDGE =
  /^\s*(?:import|export)\s+(?!type\b)[^"';]*?from\s+["'](\.[^"']+)["']|^\s*import\s+["'](\.[^"']+)["']/gm

/**
 * Walk the runtime closure of `entry` (a repo-relative path). Return
 * `"<reached> <- <importer>"` for each reached file under `forbiddenRoot`,
 * sorted. The walk does not go into the forbidden files.
 */
export function forbiddenTransitiveEdges(entry: string, forbiddenRoot: string): string[] {
  const seen = new Set<string>()
  const hits: string[] = []
  const walk = (file: string, importer: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    if (file.startsWith(`${forbiddenRoot}/`)) {
      hits.push(`${file} <- ${importer}`)
      return
    }
    const source = readFileSync(file, "utf8")
    for (const m of source.matchAll(RUNTIME_EDGE)) {
      const spec = m[1] ?? m[2]
      if (!spec) continue
      const target = normalize(join(dirname(file), spec))
      if (existsSync(target)) walk(target, file)
    }
  }
  walk(entry, "(entry)")
  return hits.sort()
}
