/**
 * Filesystem + handler resolution helpers used by the plugin loader.
 * Pure functions; no class state. Split out of `src/plugins/loader.ts`
 * to keep that file under the `max-lines` lint budget.
 *
 * @module plugins/loader/helpers
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

import type {
  LoadedPlugin,
  ManifestHandler,
  ResolvedHandler,
  TUIContext,
  TUIHandler,
  TUIResult,
} from "../types.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function discoverPackageDirs(rootDir: string, sub: string): string[] {
  const base = join(rootDir, sub)
  if (!existsSync(base) || !statSync(base).isDirectory()) return []
  const out: string[] = []
  for (const entry of readdirSync(base)) {
    const full = join(base, entry)
    if (!statSync(full).isDirectory()) continue
    if (!existsSync(join(full, "manifest.json"))) continue
    out.push(full)
  }
  return out
}

export function resolvePath(pkgDir: string, rel: string): string {
  return isAbsolute(rel) ? rel : resolve(pkgDir, rel)
}

/**
 * Strip a single leading ATX-style top-level heading (`# ...`) from a
 * Markdown body, plus any blank lines that follow it. Used when embedding a
 * plugin's `PROMPT.md` inside a `<plugin id="...">` wrapper so the plugin id
 * doesn't appear twice (once as the XML attribute, once as a stray H1) and
 * so plugin authors don't accidentally inject a top-level heading into the
 * host system prompt's outline.
 *
 * Only the first heading is removed, and only if it is the very first
 * non-empty line. Deeper headings (`##`, `###`, ...) and headings that appear
 * later in the body are left untouched.
 */
export function stripLeadingHeading(body: string): string {
  // Tolerate a UTF-8 BOM and any leading blank lines before the heading.
  const match = body.match(/^\uFEFF?\s*#[ \t]+[^\n]*\n+/)
  if (!match) return body.trim()
  return body.slice(match[0].length).trim()
}

/**
 * Semantic role of a plugin's system-prompt contribution. Determines the
 * `<ma::sys::ROLE …>` wrapper the composer emits and the ordering group the
 * section sorts into. The role describes WHAT the content is to the model
 * (a behavioral mandate, guidance for a tool, the syntax of an inline emit
 * directive, mode-specific behavior, or session reference data) — never
 * WHICH plugin produced it. The word "plugin" never reaches the model.
 */
export type PromptRole = "behavior" | "tool" | "emit" | "mode" | "context"

/**
 * Stable render order across roles. Behavioral mandates lead (they shape
 * every response), then per-tool guidance, then inline-emit syntax, then
 * mode rules, then session-context data last. Within a role, sections sort
 * by `name` so the composed block is byte-stable for a given plugin set
 * regardless of filesystem discovery order (the system prompt sits on a
 * cache breakpoint and must not churn turn-to-turn).
 */
export const PROMPT_ROLE_ORDER: Record<PromptRole, number> = {
  behavior: 0,
  tool: 1,
  emit: 2,
  mode: 3,
  context: 4,
}

/**
 * Extract the text of a single leading ATX-style H1 (`# Heading`), trailing
 * `#` run tolerated, or `null` when the body does not open with one. Used to
 * derive a human-meaningful section `name` for `behavior`/`context` sections
 * (which have no tool/tag/mode identifier to borrow). Pairs with
 * {@link stripLeadingHeading}, which removes the same heading from the body.
 */
export function leadingHeadingText(body: string): string | null {
  const m = body.match(/^\uFEFF?\s*#[ \t]+(.*?)[ \t]*#*[ \t]*\n/)
  return m && m[1] ? m[1].trim() : null
}

/**
 * Slugify a free-form label into a tag-attribute-safe token: lowercased,
 * runs of non-alphanumerics collapsed to single hyphens, ends trimmed.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Escape a value for an XML-style double-quoted attribute. */
export function escapeTagAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Infer a plugin's prompt {@link PromptRole} and section `name` from its
 * manifest shape — no manifest field required. Precedence:
 *
 * 1. declares a mode            → `mode`,  name = first mode id
 * 2. contributes a tool         → `tool`,  name = first tool name
 * 3. contributes only inline tag→ `emit`,  name = first inline-tag name
 * 4. PROMPT.md only (no frags)  → `behavior`, name = slug(H1 | display name)
 * 5. PROMPT.md + prompt fragment→ `context`,  name = slug(H1 | display name)
 *
 * The tool/mode/emit names are the exact identifiers the model already sees
 * elsewhere (the `tools[]` array, the mode-change signals, the emit syntax),
 * so the section label binds the guidance to the thing it describes.
 */
export function classifyPluginPrompt(pkg: LoadedPlugin): { role: PromptRole; name: string } {
  const m = pkg.manifest
  const firstMode = m.modes?.[0]
  if (firstMode) return { role: "mode", name: firstMode.id }
  for (const h of m.tuis ?? []) {
    if (h.trigger.type === "tool") return { role: "tool", name: h.trigger.tool.name }
  }
  for (const h of m.tuis ?? []) {
    if (h.trigger.type === "inline_tag") return { role: "emit", name: h.trigger.tag }
  }
  const hasFragments = (m.promptFragments?.length ?? 0) > 0
  const label = (pkg.prompt ? leadingHeadingText(pkg.prompt) : null) ?? m.name ?? m.id
  const name = slugify(label) || m.id
  return { role: hasFragments ? "context" : "behavior", name }
}

export async function resolveHandler(
  h: ManifestHandler,
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedHandler | null> {
  if (h.handler.type === "module") {
    const abs = resolvePath(packageDir, h.handler.path)
    if (!existsSync(abs)) {
      logger(`${packageDir}: module handler not found: ${abs}`)
      return null
    }
    let mod: { default?: TUIHandler }
    try {
      mod = await import(abs)
    } catch (e) {
      logger(
        `${packageDir}: failed to import ${abs}: ${e instanceof Error ? e.message : String(e)}`,
      )
      return null
    }
    const fn = mod.default
    if (typeof fn !== "function") {
      logger(`${packageDir}: ${abs} has no default export function`)
      return null
    }
    return {
      definition: h,
      entryAbsolute: abs,
      invoke: async (ctx) => fn(ctx),
    }
  }

  // subprocess
  const cmd = h.handler.command
  const exe = cmd[0]
  const exeAbs = isAbsolute(exe) ? exe : resolve(packageDir, exe)
  if (!existsSync(exeAbs)) {
    logger(`${packageDir}: subprocess executable not found: ${exeAbs}`)
    return null
  }
  return {
    definition: h,
    entryAbsolute: exeAbs,
    invoke: async (ctx) => invokeSubprocess(exeAbs, cmd.slice(1), ctx),
  }
}

/**
 * Spawn a subprocess handler with the v1 stdio protocol.
 *
 * The subprocess receives a JSON envelope on stdin and writes its response
 * to stdout. Tool-call non-interactive handlers return stdout as
 * `tool_result.content`. Inline handlers return stdout as `rendered.ansi`.
 * Interactive handlers are not yet supported via subprocess; they fall back
 * to the module-handler path.
 */
export async function invokeSubprocess(
  exe: string,
  args: string[],
  ctx: TUIContext,
): Promise<TUIResult> {
  const proc = Bun.spawn([exe, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: ctx.packageDir,
    env: ctx.env,
  })
  const envelope = JSON.stringify({
    trigger: ctx.trigger,
    cwd: ctx.cwd,
    env: ctx.env,
  })
  void proc.stdin.write(envelope + "\n")
  void proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (ctx.trigger.type === "tool") {
    return { kind: "tool_result", content: out, is_error: code !== 0 }
  }
  return { kind: "rendered", ansi: out }
}

export function findPackageDirFor(plugins: LoadedPlugin[], handler: ResolvedHandler): string {
  for (const pkg of plugins) {
    if (pkg.handlers.includes(handler)) return pkg.packageDir
  }
  return process.cwd()
}

/**
 * Locate the plugin id that owns the given handler instance. Returns
 * an empty string when no plugin matches (a degenerate test-fixture
 * case; the resulting logger emits with an unprefixed source).
 */
export function findPluginIdFor(plugins: LoadedPlugin[], handler: ResolvedHandler): string {
  for (const pkg of plugins) {
    if (pkg.handlers.includes(handler)) return pkg.manifest.id
  }
  return ""
}
