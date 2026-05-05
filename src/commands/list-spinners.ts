import { c } from "../agent.ts"
import { SPINNER_PRESETS } from "../spinner/named-presets.ts"

export function runListSpinnersCommand(): void {
  console.log(`\n  ${c.bold("Spinner presets")}`)
  console.log(`  ${c.dim("Pick one with --spinner <id> or env MINIMAL_AGENT_SPINNER=<id>")}\n`)
  for (const p of SPINNER_PRESETS) {
    console.log(`  ${c.dimCyan("╭")} ${c.cyan(p.id)}`)
    console.log(`  ${c.dimCyan("╰")} ${c.dim(p.description)}`)
    console.log()
  }
  console.log(`  ${c.dim(`${SPINNER_PRESETS.length} presets total`)}`)
}
