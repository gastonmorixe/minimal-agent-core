import { c } from "../agent.ts"
import { BETA_FLAGS_DETAILED } from "../headers.ts"

export function runListFlagsCommand(): void {
  console.log(`\n  ${c.bold("Beta feature flags")}`)
  console.log(`  ${c.dim("Sent with every Messages API request")}\n`)
  for (const flag of BETA_FLAGS_DETAILED) {
    console.log(`  ${c.dimCyan("╭")} ${c.cyan(flag.id)}`)
    console.log(`  ${c.dimCyan("│")} ${flag.description}`)
    console.log(`  ${c.dimCyan("│")} ${c.dim(`source: ${flag.source}`)}`)
    console.log(`  ${c.dimCyan("╰")} ${c.dim(`when:   ${flag.condition}`)}`)
    console.log()
  }
  console.log(`  ${c.dim(`${BETA_FLAGS_DETAILED.length} flags total`)}`)
}
