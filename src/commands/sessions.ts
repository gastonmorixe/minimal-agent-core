import { readFileSync } from "node:fs"
import { c } from "../agent.ts"
import { firstUserPromptSnippet } from "../session-restore.ts"
import {
  defaultSessionsDir,
  parseLines as parseSessionLines,
  sessionFilePath,
} from "../session-store.ts"
import { readSessionIndex } from "./session-index.ts"

/**
 * `--sessions`: print a table of saved sessions and exit.
 */
export function runSessionsCommand(): void {
  const all = readSessionIndex()
  if (all.length === 0) {
    console.log(`\n  ${c.dim("no saved sessions yet")}`)
    console.log(`  ${c.dim(`(sessions are stored at ${defaultSessionsDir()})`)}`)
    return
  }
  console.log("")
  console.log(
    `  ${c.bold("when".padEnd(20))} ${c.bold("sid".padEnd(38))} ${c.bold("model".padEnd(22))} ${c.bold("preview")}`,
  )
  for (const rec of all) {
    let snippet = ""
    try {
      // Read the whole file — they're append-only JSONL, typically small.
      // For huge sessions this is still fine because we only do it on
      // explicit `--sessions` listing (one-shot), not in any hot path.
      const text = readFileSync(sessionFilePath(rec.sid), "utf-8")
      const { records: parsed } = parseSessionLines(text)
      snippet = firstUserPromptSnippet(parsed, 40)
    } catch {
      // ignore — session file may have been deleted
    }
    const when = c.dim(rec.createdAt.replace("T", " ").slice(0, 19))
    const sid = c.cyan(rec.sid.padEnd(38))
    const model = c.dim(rec.model.padEnd(22))
    console.log(`  ${when}  ${sid} ${model} ${c.faintWhite(snippet)}`)
  }
  console.log("")
  console.log(`  ${c.dim(`${all.length} session(s) at ${defaultSessionsDir()}`)}`)
  console.log(`  ${c.dim("resume with: --resume <sid>  (or --resume last)")}`)
}
