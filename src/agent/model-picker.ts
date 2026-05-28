/**
 * Model-availability error parsing + interactive model picker.
 *
 * Split out of `src/agent.ts` to keep that file under the
 * `max-lines` lint budget. The two `parseModel...Error` predicates
 * are re-exported from `agent.ts` for back-compat; `promptModelPicker`
 * stays a sibling-only export consumed from `./repl-live-area.ts`.
 *
 * @module agent/model-picker
 */

import type { ModelInfo } from "../client.ts"
import { RawInput } from "../input.ts"

import { c } from "./ansi.ts"
import type { ReplErrOutput } from "./repl.ts"

export function parseModelNotFoundError(message: string): string | null {
  if (!message.includes("not_found_error")) return null
  const match = message.match(/"message"\s*:\s*"model:\s*([^"]+)"/)
  return match ? match[1] : null
}

/**
 * Detect API errors that don't say "model not found" but still mean the
 * current model selection won't work for this account : e.g. picking a
 * `[1m]` variant on a subscription without long-context access:
 *
 *   `API 400: {"type":"error","error":{"type":"invalid_request_error",
 *    "message":"The long context beta is not yet available for this subscription."},...}`
 *
 * Returns the current model id (so the caller can re-open the picker), or
 * null if the error is unrelated to model selection.
 */
export function parseModelUnavailableError(
  message: string,
  currentModel: string | undefined,
): string | null {
  if (!currentModel) return null
  if (message.includes("long context beta is not yet available")) return currentModel
  return null
}

/**
 * Show the user a numbered list of available models and read a selection.
 * Returns the picked model id, or null when the user skips (empty input).
 *
 * The user may type a number (1-based), or any model id (including the
 * client-side `[1m]` suffix variants synthesized by `listModels`).
 */
export async function promptModelPicker(
  models: ModelInfo[],
  currentModel: string,
  errOutput: ReplErrOutput,
): Promise<string | null> {
  errOutput.write(`\n  ${c.bold("available models")} ${c.dim(`(current: ${currentModel})`)}\n`)
  const width = String(models.length).length
  for (let i = 0; i < models.length; i++) {
    const m = models[i]
    const num = c.cyan(String(i + 1).padStart(width))
    const name = m.display_name ? c.dim(` ${m.display_name}`) : ""
    errOutput.write(`    ${num}) ${m.id}${name}\n`)
  }
  errOutput.write("\n")
  const picker = new RawInput(
    `${c.bold(c.pink("❯"))} ${c.dim("pick model (number or id, empty to skip):")} `,
    "",
  )
  const ans = await picker.read()
  if (!ans) return null
  const trimmed = ans.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  if (Number.isInteger(n) && n >= 1 && n <= models.length) {
    return models[n - 1].id
  }
  // Accept any user-typed id verbatim (covers `[1m]` variants and forward
  // compatibility with future model ids the catalog may not yet list).
  return trimmed
}
