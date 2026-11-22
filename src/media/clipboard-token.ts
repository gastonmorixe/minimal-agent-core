/**
 * Clipboard image to media token, async.
 *
 * Bun's native `Bun.Image.fromClipboard()` has an async `.bytes()`, so it cannot
 * run in the editor's sync paste path. A host calls this when a paste gave no
 * text. It has no UI code: the host decides how to show the token. A failed
 * read is reported as a `media.clipboard_failed` warning on `diagnostics`.
 *
 * @module media/clipboard-token
 */

import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"

import { type ClipboardImageResult, readClipboardImage } from "./clipboard.ts"
import { acceptOrWarn } from "./paste-intercept.ts"
import type { MediaRegistry } from "./registry.ts"
import { getSessionMediaRegistry } from "./session-registry.ts"
import { formatMediaToken } from "./token.ts"
import { resolveModelMediaContext } from "./tool-context.ts"

/**
 * Read the clipboard image and register it. Resolves to the `[Image #id …]`
 * token, or `null` when the clipboard has no image, the read failed, or the
 * image is rejected. A failure or a rejection is reported on `diagnostics`; an
 * empty clipboard is not a failure and stays silent. Never rejects.
 * `readImage` is for tests.
 */
export async function clipboardImageToken(
  registry: MediaRegistry = getSessionMediaRegistry(),
  diagnostics: Diagnostics = processDiagnostics(),
  text?: SyntheticTextResolver,
  modelId?: string,
  readImage: () => Promise<ClipboardImageResult> = readClipboardImage,
): Promise<string | null> {
  const fail = (reason: string): null => {
    diagnostics.warn("media.clipboard_failed", `Could not paste the clipboard image: ${reason}`, {
      reason,
    })
    return null
  }
  try {
    const { bytes, error } = await readImage()
    if (error) return fail(error)
    if (!bytes || bytes.length === 0) return null
    const item = await registry.registerBytes(bytes, "clipboard", "image/png")
    const model = resolveModelMediaContext(modelId)
    if (!acceptOrWarn(item, diagnostics, text, model)) return null
    return formatMediaToken(item)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
