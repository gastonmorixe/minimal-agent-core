import { BETA_FLAGS_DETAILED } from "../headers.ts"
import { writeCommandList } from "../ui/command-list.ts"
import { c } from "../ui/style/ansi.ts"

/**
 * Implements `minimal-agent list-flags`: prints every beta feature flag the
 * client sends with Messages API requests, including each flag's source and
 * the condition under which it is attached.
 */
export function runListFlagsCommand(deps: { output?: { write(s: string): unknown } } = {}): void {
  writeCommandList(
    {
      title: "Beta feature flags",
      subtitle: "Sent with every Messages API request",
      items: BETA_FLAGS_DETAILED.map((flag) => ({
        title: flag.id,
        body: [flag.description, c.dim(`source: ${flag.source}`)],
        footer: `when:   ${flag.condition}`,
      })),
      summary: `${BETA_FLAGS_DETAILED.length} flags total`,
    },
    deps.output,
  )
}
