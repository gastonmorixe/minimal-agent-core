// Copies core's base prompt files into ma-base-prompt-plugin. Core is the source of truth.
// startup-hashes.real-plugin.test.ts fails when the copies drift.
import { copyFileSync } from "node:fs"
import { join, resolve } from "node:path"

const CORE = resolve(import.meta.dir, "../src/prompts")
const PLUGIN = resolve(import.meta.dir, "../../minimal-agent-plugins/ma-base-prompt-plugin/prompts")

for (const name of ["identity.neutral.md", "instructions.md"]) {
  copyFileSync(join(CORE, name), join(PLUGIN, name))
  console.log(`synced ${name}`)
}
