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
