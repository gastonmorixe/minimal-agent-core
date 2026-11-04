/**
 * Command loader fixture helper: a process-wide log of the fixture handler
 * modules that were imported. Each fixture handler calls
 * {@link markImported} at module load, so a test can prove which modules
 * the loader imported.
 *
 * @module plugins/cli-command-fixtures/import-log
 */

const KEY = "__maCliCommandFixtureImports"

function log(): string[] {
  const g = globalThis as Record<string, unknown>
  if (!Array.isArray(g[KEY])) g[KEY] = []
  return g[KEY] as string[]
}

/** Record that the fixture module `name` was imported. */
export function markImported(name: string): void {
  log().push(name)
}

/** A copy of the import log, in import order. */
export function importedModules(): string[] {
  return [...log()]
}
