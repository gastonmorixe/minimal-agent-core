/**
 * Prompt loading + templating, LOCAL to the memory plugin.
 *
 * A faithful, self-contained copy of the host's pure prompt helpers (source of
 * truth: `src/prompts.ts`), re-declared here so the plugin imports NOTHING from
 * the host repo (the Wave D decoupling contract). Same `%%name%%` / `%%name?%%`
 * placeholder grammar, same disk-read + memoization behavior. Only the helpers
 * this plugin actually uses are reproduced (`promptPath`, `loadPromptText`,
 * `renderPrompt`, plus the underlying `renderTemplate`). Mirrors the
 * sub-agents/schedule plugins' own `prompt-io.ts` idiom.
 *
 * @module memory/lib/prompt-io
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Matches `%%name%%` (required) and `%%name?%%` (optional). */
const PLACEHOLDER_RE = /%%([A-Za-z0-9_.-]+)(\?)?%%/g

/** A value that can be substituted into a template placeholder. */
export type PromptVar = string | number | boolean | null | undefined

/** Variable bag passed to {@link renderTemplate} / {@link renderPrompt}. */
export type PromptVars = Record<string, PromptVar>

/**
 * Thrown when a template references a REQUIRED placeholder (`%%name%%`) that
 * the caller did not supply. Carries the offending names and, when known, the
 * source file, so the failure points at the exact unwired variable.
 */
export class PromptTemplateError extends Error {
  /** The required placeholder names that had no value. */
  readonly missing: string[]
  /** Absolute path of the template file, when rendered from disk. */
  readonly source?: string
  constructor(missing: string[], source?: string) {
    const where = source ? ` in ${source}` : ""
    super(`prompt template${where} is missing required variable(s): ${missing.join(", ")}`)
    this.name = "PromptTemplateError"
    this.missing = missing
    this.source = source
  }
}

/** Options for {@link renderTemplate} and {@link renderPrompt}. */
export interface RenderOptions {
  /** Trim leading/trailing whitespace from the final string. Default `true`. */
  trim?: boolean
  /** Source path, used purely to enrich {@link PromptTemplateError}. */
  source?: string
}

/**
 * Render a template string by substituting `%%name%%` placeholders. Pure (no
 * IO). Required placeholders with no value collect into a single
 * {@link PromptTemplateError}; optional `%%name?%%` placeholders with no value
 * render empty and, when they occupied a whole line, that line is dropped.
 */
export function renderTemplate(
  template: string,
  vars: PromptVars = {},
  opts: RenderOptions = {},
): string {
  const missing = new Set<string>()
  let droppedOptional = false

  const rendered = template.replace(PLACEHOLDER_RE, (full, rawName: string, optional?: string) => {
    const value = vars[rawName]
    const present = value !== undefined && value !== null
    if (present) return String(value)
    if (optional) {
      droppedOptional = true
      return ""
    }
    missing.add(rawName)
    return full
  })

  if (missing.size > 0) {
    throw new PromptTemplateError([...missing], opts.source)
  }

  let out = rendered
  if (droppedOptional) {
    out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
  }
  return opts.trim === false ? out : out.trim()
}

/** In-process cache of raw file contents, keyed by absolute path. */
const fileCache = new Map<string, string>()

/**
 * Read a prompt file's raw text, memoized by absolute path. The on-disk bytes
 * are returned verbatim; {@link renderPrompt} handles trimming after
 * substitution.
 */
export function loadPromptText(absPath: string): string {
  const cached = fileCache.get(absPath)
  if (cached !== undefined) return cached
  const text = readFileSync(absPath, "utf-8")
  fileCache.set(absPath, text)
  return text
}

/** Load a prompt file and render its placeholders in one step. */
export function renderPrompt(
  absPath: string,
  vars: PromptVars = {},
  opts: RenderOptions = {},
): string {
  return renderTemplate(loadPromptText(absPath), vars, { ...opts, source: opts.source ?? absPath })
}

/**
 * Resolve an absolute path to a prompt file relative to the CALLING module.
 * Pass `import.meta` from the caller.
 */
export function promptPath(meta: ImportMeta, ...segments: string[]): string {
  const dir = meta.dirname ?? dirname(fileURLToPath(meta.url))
  return join(dir, ...segments)
}
