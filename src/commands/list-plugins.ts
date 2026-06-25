/**
 * `plugins list` / `--list-plugins`: installed plugins and effective on/off.
 *
 * @module commands/list-plugins
 */

import { loadPluginEnabledOverrides } from "../config.ts"
import {
  buildPluginCatalog,
  type CatalogRoots,
  type PluginCatalogEntry,
} from "../plugins/catalog.ts"
import { writeCommandTable } from "../ui/command-table.ts"
import { c } from "../ui/style/ansi.ts"

export interface ListPluginsDeps {
  roots: CatalogRoots
  cliArgs?: readonly string[]
  env?: { disable?: string; enable?: string }
  config?: { forceDisabled: Set<string>; forceEnabled: Set<string> }
  output?: { write(s: string): unknown }
}

/**
 * Print the plugin catalog as a compact table (id, name, state, note).
 */
export function runListPluginsCommand(deps: ListPluginsDeps): void {
  const config = deps.config ?? loadPluginEnabledOverrides()
  const entries = buildPluginCatalog(deps.roots, {
    config,
    env: deps.env ?? {
      disable: process.env.MINIMAL_AGENT_DISABLE_PLUGINS,
      enable: process.env.MINIMAL_AGENT_ENABLE_PLUGINS,
    },
    cliArgs: deps.cliArgs,
  })

  writeCommandTable(
    {
      sections: [{ rows: entries.map(rowFromEntry) }],
      columns: [
        { key: "id", minWidth: 18, color: "cyan" },
        { key: "name", minWidth: 16 },
        { key: "state", minWidth: 4 },
        { key: "note", minWidth: 8, color: "dim" },
      ],
      empty: "  (no plugins found)",
      summary: summaryLine(entries),
    },
    deps.output,
  )
}

function rowFromEntry(entry: PluginCatalogEntry) {
  return {
    cells: {
      id: entry.id,
      name: entry.name,
      state: entry.effectiveOn ? c.green("on") : c.dim("off"),
      note: entry.note,
    },
  }
}

function summaryLine(entries: PluginCatalogEntry[]): string {
  const on = entries.filter((e) => e.effectiveOn).length
  const off = entries.length - on
  return `${entries.length} plugins (${on} on, ${off} off)`
}
