/**
 * Interactive model picker prompt.
 *
 * Shows a numbered list of available models and reads a selection from
 * `RawInput`. Model-availability error parsing stays in `agent/model-error.ts`;
 * this module owns only the terminal interaction.
 *
 * @module ui/model-picker
 */

import { RawInput } from "../input.ts"
import type { ModelInfo } from "../llm/transport/types.ts"

import { c } from "./style/ansi.ts"

export interface ModelPickerOutput {
  write(s: string): unknown
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
  errOutput: ModelPickerOutput,
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
