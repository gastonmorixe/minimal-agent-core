import { c } from "../agent.ts"
import type { AuthResult } from "../auth.ts"
import { listModels } from "../client.ts"

export async function runListModelsCommand(auth: AuthResult): Promise<void> {
  const models = await listModels(auth)

  const families = new Map<string, typeof models>()
  for (const modelInfo of models) {
    const family = modelInfo.id.replace(/-\d.*$/, "")
    if (!families.has(family)) {
      families.set(family, [])
    }
    families.get(family)!.push(modelInfo)
  }

  console.log("")
  for (const [family, members] of [...families.entries()].sort()) {
    console.log(`  ${c.bold(family)}`)
    for (const modelInfo of members.sort((a, b) => a.id.localeCompare(b.id))) {
      const id = c.cyan(modelInfo.id.padEnd(24))
      const name = modelInfo.display_name ? c.dim(modelInfo.display_name.padEnd(28)) : "".padEnd(28)
      const date = modelInfo.created_at ? c.dim(modelInfo.created_at.slice(0, 10)) : ""
      console.log(`    ${id} ${name} ${date}`)
    }
    console.log("")
  }
  console.log(`  ${c.dim(`${models.length} models available`)}`)
}
