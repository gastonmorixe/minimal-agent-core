import { writeCommandList } from "../ui/command-list.ts"
import { SPINNER_PRESETS } from "../ui/spinner/named-presets.ts"

/**
 * Implements `minimal-agent list-spinners`: prints every named spinner preset
 * with its description so the user can pick one for `--spinner` or
 * `MINIMAL_AGENT_SPINNER`.
 */
export function runListSpinnersCommand(
  deps: { output?: { write(s: string): unknown } } = {},
): void {
  writeCommandList(
    {
      title: "Spinner presets",
      subtitle: "Pick one with --spinner <id> or env MINIMAL_AGENT_SPINNER=<id>",
      items: SPINNER_PRESETS.map((p) => ({ title: p.id, footer: p.description })),
      summary: `${SPINNER_PRESETS.length} presets total`,
    },
    deps.output,
  )
}
