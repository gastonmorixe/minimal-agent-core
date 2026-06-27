import { listProviderPlugins } from "../llm/provider-plugin.ts"
import { writeCommandList } from "../ui/command-list.ts"
import { c } from "../ui/style/ansi.ts"

/**
 * Implements `minimal-agent list-flags`: prints every protocol beta/feature
 * flag the registered provider plugins can send, including each flag's source
 * and the condition under which it is attached.
 *
 * Provider-NEUTRAL by construction (OCP): the rows come from each registered
 * `ProviderPlugin.listBetaFlags` hook, so adding a provider extends the listing
 * with zero edits here and the command names no provider itself.
 */
export function runListFlagsCommand(deps: { output?: { write(s: string): unknown } } = {}): void {
  const flags = listProviderPlugins().flatMap((p) => p.listBetaFlags?.() ?? [])
  writeCommandList(
    {
      title: "Beta feature flags",
      subtitle: "Protocol opt-in flags the provider sends with requests",
      items: flags.map((flag) => ({
        title: flag.id,
        body: [flag.description, ...(flag.source ? [c.dim(`source: ${flag.source}`)] : [])],
        footer: flag.condition ? `when:   ${flag.condition}` : undefined,
      })),
      summary: `${flags.length} flags total`,
    },
    deps.output,
  )
}
