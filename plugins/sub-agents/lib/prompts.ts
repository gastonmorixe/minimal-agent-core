/**
 * Prompt IO seam for the sub-agents plugin. Every model-facing string the
 * plugin injects into a worker's prompt lives in `../prompts/*.md` and is loaded
 * here, never hardcoded as a TypeScript literal (the repo-wide convention). The
 * pure load+template helpers are re-declared LOCALLY in `./prompt-io.ts` so the
 * plugin imports nothing from the host repo (the decoupling contract). This is
 * the one module in the plugin's spawn path that touches disk for prose, so
 * `spawn-plan.ts` and `library.ts` stay pure: they receive already-rendered
 * text.
 *
 * @module sub-agents/lib/prompts
 */

import { loadPromptText, promptPath, renderPrompt } from "./prompt-io.ts"

/**
 * The REQUIRED deliverable protocol appended to a worker's prompt: how it
 * finishes (write the file itself, then call `ReportResult`), with the manual
 * sentinel path as the documented fallback. `%%resultPath%%` is the exact path
 * the fallback writes to.
 */
export function renderResultProtocol(resultPath: string): string {
  return renderPrompt(promptPath(import.meta, "..", "prompts", "result-protocol.tmpl.md"), {
    resultPath,
  })
}

/**
 * The shared leaf-worker discipline clause appended to every library
 * specialist's system prompt. Static (no placeholders), so a plain read.
 */
export function leafDiscipline(): string {
  return loadPromptText(promptPath(import.meta, "..", "prompts", "leaf-discipline.md")).trim()
}
