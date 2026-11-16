/**
 * Startup profile: parse, validate, serialize, read, and write.
 *
 * The type lives in plugin-api (`types/startup-profile.ts`). This module is
 * the strict codec. A lead host writes `<sessionsDir>/<sid>.profile.json`
 * from its final startup values. A child host reads it with
 * {@link readStartupProfileFile} and exits on `ok: false`.
 *
 * Core zero-text rule: a failure carries identifiers only. `code` names the
 * failure class, `field` is the JSON path of the bad value, and `error` is
 * `code` or `code field` so a host can print it after its own prefix.
 *
 * @module session/startup-profile
 */

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  STARTUP_PROFILE_PART_NAMES,
  STARTUP_PROFILE_VERSION,
  type StartupProfile,
  type StartupProfilePartName,
  type StartupProfilePromptPart,
  type StartupProfileSystemPrompt,
  type StartupProfileTools,
} from "@minimal-agent/core/plugin-api/types/startup-profile"

import type { ToolNamePolicy } from "../sdk/tool-filter.ts"

/** Failure class of a profile read or parse. */
export type StartupProfileErrorCode =
  | "not-found"
  | "read-failed"
  | "invalid-json"
  | "not-object"
  | "unsupported-version"
  | "invalid-field"
  | "unknown-field"

/** Result of {@link parseStartupProfile} and {@link readStartupProfileFile}. */
export type StartupProfileParse =
  | { ok: true; value: StartupProfile }
  | { ok: false; error: string; code: StartupProfileErrorCode; field?: string }

type Fail = Extract<StartupProfileParse, { ok: false }>

function fail(code: StartupProfileErrorCode, field?: string): Fail {
  return field === undefined
    ? { ok: false, error: code, code }
    : { ok: false, error: `${code} ${field}`, code, field }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const TOP_KEYS = new Set([
  "version",
  "systemPrompt",
  "noAgentsMd",
  "pluginPrompts",
  "plugins",
  "bare",
  "tools",
])
const PART_NAMES: ReadonlySet<string> = new Set(STARTUP_PROFILE_PART_NAMES)

function unknownKey(obj: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) return k
  return null
}

function stringList(v: unknown, field: string): readonly string[] | Fail {
  if (!Array.isArray(v)) return fail("invalid-field", field)
  for (let i = 0; i < v.length; i++) {
    const s = v[i]
    if (typeof s !== "string" || s.length === 0) return fail("invalid-field", `${field}[${i}]`)
  }
  return [...(v as string[])]
}

function isFail(v: unknown): v is Fail {
  return isRecord(v) && v.ok === false
}

function parsePart(v: unknown, field: string): StartupProfilePromptPart | Fail {
  if (!isRecord(v)) return fail("invalid-field", field)
  if (v.kind === "default" || v.kind === "omit") {
    const extra = unknownKey(v, new Set(["kind"]))
    if (extra !== null) return fail("unknown-field", `${field}.${extra}`)
    return { kind: v.kind }
  }
  if (v.kind === "replace") {
    const extra = unknownKey(v, new Set(["kind", "text"]))
    if (extra !== null) return fail("unknown-field", `${field}.${extra}`)
    if (typeof v.text !== "string") return fail("invalid-field", `${field}.text`)
    return { kind: "replace", text: v.text }
  }
  return fail("invalid-field", `${field}.kind`)
}

function parseSystemPrompt(v: unknown): StartupProfileSystemPrompt | Fail {
  if (!isRecord(v)) return fail("invalid-field", "systemPrompt")
  const out: Partial<Record<StartupProfilePartName, StartupProfilePromptPart>> & {
    unsafeProviderOverrides?: boolean
  } = {}
  for (const [k, raw] of Object.entries(v)) {
    if (k === "unsafeProviderOverrides") {
      if (typeof raw !== "boolean")
        return fail("invalid-field", "systemPrompt.unsafeProviderOverrides")
      out.unsafeProviderOverrides = raw
      continue
    }
    if (!PART_NAMES.has(k)) return fail("unknown-field", `systemPrompt.${k}`)
    const part = parsePart(raw, `systemPrompt.${k}`)
    if (isFail(part)) return part
    out[k as StartupProfilePartName] = part
  }
  return out
}

function parseTools(v: unknown): StartupProfileTools | Fail {
  if (!isRecord(v)) return fail("invalid-field", "tools")
  if (v.kind === "all" || v.kind === "none") {
    const extra = unknownKey(v, new Set(["kind"]))
    if (extra !== null) return fail("unknown-field", `tools.${extra}`)
    return { kind: v.kind }
  }
  if (v.kind === "list") {
    const extra = unknownKey(v, new Set(["kind", "names"]))
    if (extra !== null) return fail("unknown-field", `tools.${extra}`)
    const names = stringList(v.names, "tools.names")
    if (isFail(names)) return names
    return { kind: "list", names }
  }
  return fail("invalid-field", "tools.kind")
}

function parsePluginPrompts(v: unknown): StartupProfile["pluginPrompts"] | Fail {
  if (!isRecord(v)) return fail("invalid-field", "pluginPrompts")
  const extra = unknownKey(v, new Set(["all", "suppress", "keep"]))
  if (extra !== null) return fail("unknown-field", `pluginPrompts.${extra}`)
  if (typeof v.all !== "boolean") return fail("invalid-field", "pluginPrompts.all")
  const suppress = stringList(v.suppress, "pluginPrompts.suppress")
  if (isFail(suppress)) return suppress
  const keep = stringList(v.keep, "pluginPrompts.keep")
  if (isFail(keep)) return keep
  return { all: v.all, suppress, keep }
}

function parsePlugins(v: unknown): StartupProfile["plugins"] | Fail {
  if (!isRecord(v)) return fail("invalid-field", "plugins")
  const extra = unknownKey(v, new Set(["disable", "enable"]))
  if (extra !== null) return fail("unknown-field", `plugins.${extra}`)
  const disable = stringList(v.disable, "plugins.disable")
  if (isFail(disable)) return disable
  const enable = stringList(v.enable, "plugins.enable")
  if (isFail(enable)) return enable
  return { disable, enable }
}

/**
 * Strictly validate an already-decoded JSON value as a {@link StartupProfile}.
 * Rejects a wrong version, a missing or mistyped field, an unknown key, an
 * unknown prompt part name, and an empty or non-string id.
 */
export function parseStartupProfile(json: unknown): StartupProfileParse {
  if (!isRecord(json)) return fail("not-object")
  if (json.version !== STARTUP_PROFILE_VERSION) return fail("unsupported-version", "version")
  const extra = unknownKey(json, TOP_KEYS)
  if (extra !== null) return fail("unknown-field", extra)
  const systemPrompt = parseSystemPrompt(json.systemPrompt)
  if (isFail(systemPrompt)) return systemPrompt
  if (typeof json.noAgentsMd !== "boolean") return fail("invalid-field", "noAgentsMd")
  const pluginPrompts = parsePluginPrompts(json.pluginPrompts)
  if (isFail(pluginPrompts)) return pluginPrompts
  const plugins = parsePlugins(json.plugins)
  if (isFail(plugins)) return plugins
  if (typeof json.bare !== "boolean") return fail("invalid-field", "bare")
  const tools = parseTools(json.tools)
  if (isFail(tools)) return tools
  return {
    ok: true,
    value: {
      version: STARTUP_PROFILE_VERSION,
      systemPrompt,
      noAgentsMd: json.noAgentsMd,
      pluginPrompts,
      plugins,
      bare: json.bare,
      tools,
    },
  }
}

function sorted(xs: readonly string[]): string[] {
  return [...new Set(xs)].sort()
}

/**
 * Serialize a profile as pretty JSON with a trailing newline. Id arrays
 * (plugin ids, plugin prompt ids, tool names) are deduped and sorted so the
 * same settings always give the same bytes.
 */
export function serializeStartupProfile(p: StartupProfile): string {
  const tools: StartupProfileTools =
    p.tools.kind === "list" ? { kind: "list", names: sorted(p.tools.names) } : p.tools
  const out: StartupProfile = {
    version: STARTUP_PROFILE_VERSION,
    systemPrompt: p.systemPrompt,
    noAgentsMd: p.noAgentsMd,
    pluginPrompts: {
      all: p.pluginPrompts.all,
      suppress: sorted(p.pluginPrompts.suppress),
      keep: sorted(p.pluginPrompts.keep),
    },
    plugins: { disable: sorted(p.plugins.disable), enable: sorted(p.plugins.enable) },
    bare: p.bare,
    tools,
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** Read and validate a profile file. A missing file, read error, or bad JSON gives `ok: false`. */
export function readStartupProfileFile(path: string): StartupProfileParse {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    return code === "ENOENT" ? fail("not-found") : fail("read-failed", code)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return fail("invalid-json")
  }
  return parseStartupProfile(json)
}

/** Write a profile atomically (tmp file + rename) with mode 0o600. Throws on I/O failure. */
export function writeStartupProfileFile(path: string, p: StartupProfile): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, serializeStartupProfile(p), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // tmp was never created or is already gone
    }
    throw err
  }
}

/** Canonical profile path for a session: `<sessionsDir>/<sid>.profile.json`. */
export function startupProfilePath(sessionsDir: string, sid: string): string {
  return join(sessionsDir, `${sid}.profile.json`)
}

/** Convert a core {@link ToolNamePolicy} to profile form. `null` means all tools. */
export function toolsFromNamePolicy(p: ToolNamePolicy): StartupProfileTools {
  if (p === null) return { kind: "all" }
  if (p.kind === "deny-all") return { kind: "none" }
  return { kind: "list", names: [...p.tools] }
}

/** Convert profile tools back to a core {@link ToolNamePolicy}. `all` gives `null`. */
export function namePolicyFromTools(t: StartupProfileTools): ToolNamePolicy {
  if (t.kind === "all") return null
  if (t.kind === "none") return { kind: "deny-all" }
  return { kind: "allow-list", tools: [...t.names] }
}
