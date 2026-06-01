/**
 * Prompt loading + templating.
 *
 * The agent keeps EVERY model-facing prompt (system prompts, identity lines,
 * tool descriptions, sub-prompts) in markdown files on disk, never hardcoded
 * as TypeScript string literals. This module is the one seam that loads those
 * files and fills their placeholders. The control flow that decides WHICH
 * fragment to use, and in what order, stays in TypeScript; the PROSE lives in
 * `.md` / `.tmpl.md`.
 *
 * Why markdown-on-disk instead of inline strings:
 *   - Prompts are content, not code. Editing prose shouldn't mean editing a
 *     `.ts` file (and re-reasoning about escaping, concatenation, `\n\n`).
 *   - One uniform convention for core, in-repo plugins, and external plugins
 *     (which already ship `PROMPT.md`; see `src/plugins/loader.ts`).
 *   - Diffs to prompt text read as prose diffs, not string-literal diffs.
 *
 * ## Placeholder grammar
 *
 * Templates use a `%%…%%` marker so they never collide with markdown,
 * backticks, or shell `${…}`:
 *
 *   - `%%name%%`  — REQUIRED. If `name` is not supplied (or is `null` /
 *     `undefined`), {@link renderTemplate} throws a {@link PromptTemplateError}.
 *     Fail-fast catches a typo or unwired variable at load time rather than
 *     shipping a literal `%%name%%` into a request.
 *   - `%%name?%%` — OPTIONAL ("yield"-like). When absent it renders to the
 *     empty string, and if the placeholder sat alone on its own line that line
 *     collapses so the slot leaves no blank-line scar.
 *
 * `name` matches `[A-Za-z0-9_.-]+` (so `mark-1`, `cooldownSec`, `tool.bash`
 * are all valid).
 *
 * Runtime: the agent runs from source under Bun (`bun run src/index.ts`), so
 * these files are read with {@link readFileSync} relative to the calling
 * module's directory. There is no bundler step to special-case.
 *
 * @module prompts
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
  /**
   * @param missing - Required placeholder names with no supplied value.
   * @param source - Absolute path of the template file, if loaded from disk.
   */
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
  /**
   * Trim leading/trailing whitespace from the final string. Default `true`,
   * which matches how prompt constants were historically declared (a
   * `.trim()`-ed template literal) and absorbs the trailing newline that POSIX
   * text files carry. Pass `false` only when surrounding whitespace is
   * significant.
   */
  trim?: boolean
  /** Source path, used purely to enrich {@link PromptTemplateError}. */
  source?: string
}

/**
 * Render a template string by substituting `%%name%%` placeholders.
 *
 * Pure (no IO). Required placeholders with no value collect into a single
 * {@link PromptTemplateError}; optional `%%name?%%` placeholders with no value
 * render empty and, when they occupied a whole line, that line is dropped so
 * the output has no orphaned blank line.
 *
 * @param template - The raw template text.
 * @param vars - Values to substitute. Missing keys are "not supplied".
 * @param opts - {@link RenderOptions}.
 * @returns The rendered string (trimmed unless `opts.trim === false`).
 * @throws {PromptTemplateError} If a required placeholder has no value.
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

  // Only normalize whitespace when an optional slot actually emptied; that
  // keeps templates WITHOUT optional slots byte-identical to their source.
  let out = rendered
  if (droppedOptional) {
    // A placeholder that owned its whole line leaves an empty line; collapse
    // any run of 3+ newlines that this created back down to a paragraph break.
    out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
  }
  return opts.trim === false ? out : out.trim()
}

/**
 * In-process cache of raw file contents, keyed by absolute path. Prompt files
 * are static for the life of the process and are read on hot paths (system
 * prompt assembly, tool registration), so we read each at most once.
 */
const fileCache = new Map<string, string>()

/**
 * Read a prompt file's raw text, memoized by absolute path. The on-disk bytes
 * are returned verbatim (no trimming); {@link renderPrompt} handles trimming
 * after substitution.
 *
 * @param absPath - Absolute path to the prompt file.
 * @returns The file's raw UTF-8 contents.
 */
export function loadPromptText(absPath: string): string {
  const cached = fileCache.get(absPath)
  if (cached !== undefined) return cached
  const text = readFileSync(absPath, "utf-8")
  fileCache.set(absPath, text)
  return text
}

/**
 * Load a prompt file and render its placeholders in one step.
 *
 * @param absPath - Absolute path to the `.md` / `.tmpl.md` file.
 * @param vars - Values for the file's placeholders.
 * @param opts - {@link RenderOptions} (`source` is filled in automatically).
 * @returns The rendered prompt text (trimmed by default).
 * @throws {PromptTemplateError} If a required placeholder has no value.
 */
export function renderPrompt(
  absPath: string,
  vars: PromptVars = {},
  opts: RenderOptions = {},
): string {
  return renderTemplate(loadPromptText(absPath), vars, { ...opts, source: opts.source ?? absPath })
}

/**
 * Resolve an absolute path to a prompt file relative to the CALLING module.
 *
 * Pass `import.meta` from the caller; this resolves `import.meta.dirname`
 * (Bun + Node 20+) with a `fileURLToPath(import.meta.url)` fallback, then joins
 * the segments. Example, from `src/headers.ts`:
 *
 * ```ts
 * const text = renderPrompt(promptPath(import.meta, "prompts", "instructions.md"))
 * ```
 *
 * @param meta - The caller's `import.meta`.
 * @param segments - Path segments relative to the caller's directory.
 * @returns An absolute filesystem path.
 */
export function promptPath(meta: ImportMeta, ...segments: string[]): string {
  const dir = meta.dirname ?? dirname(fileURLToPath(meta.url))
  return join(dir, ...segments)
}

/**
 * Clear the raw-file cache. Tests that write temp prompt files and re-read
 * them call this between cases; production never needs it.
 */
export function clearPromptCache(): void {
  fileCache.clear()
}
