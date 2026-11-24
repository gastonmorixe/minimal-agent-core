/**
 * The display members of the sideband API: `hasDisplay`, `displayNode` and
 * `display`. The plugin that owns a kind can give a display handler (manifest
 * `sideband[].display`). Core knows no kind: it calls the handler, checks the
 * result, cleans the label, and splits a text into segments.
 *
 * Rules:
 * - Each handler call is sync, in a try/catch. A throw, a thenable result or
 *   a result that is not an object with a string `label` is a failure: no
 *   display, and one `sideband.display-failed` warning for each kind. Core
 *   does not await a thenable.
 * - The label is cleaned: escape sequences, control and format characters
 *   and line separators go, white space runs become one space, and the label
 *   is cut to {@link DISPLAY_LABEL_CELLS} cells. An empty label is no display.
 * - Label mode drops `text` and `truncated`. A `missing` result drops `text`.
 * - The call runs in the display scope of the consumer sid (the read-only
 *   `sessions:files` scope that the loader injects). The `noReadScope`
 *   members run with no scope: a plugin with no `sessions:read` gets them.
 *
 * @packageDocumentation
 */

import type { PluginHost } from "@minimal-agent/core/plugin-api/types/host-capabilities"
import type { SidebandDisplayHandler } from "@minimal-agent/core/plugin-api/types/plugin"
import { truncateDisplayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import type { StructuredData } from "../bus/diagnostic-bus.ts"

import type {
  SidebandApi,
  SidebandDisplay,
  SidebandDisplayOptions,
  SidebandDisplaySegment,
  SidebandNode,
  SidebandReader,
} from "./types.ts"

/** One display handler that loaded: the owner plugin, the function, and the host opt-in. */
export interface SidebandDisplayEntry {
  /** The plugin id of the owner of the kind. */
  readonly owner: string
  /** The default export of the handler module. */
  readonly fn: SidebandDisplayHandler
  /** True when the manifest set `display.host: true`. */
  readonly host: boolean
}

/** Gives the capability host of a plugin, or `undefined`. */
export type SidebandDisplayHostFor = (pluginId: string) => PluginHost | undefined

/** Runs a sync `fn` in the read scope of `sid` (see `withDisplayReadSid`). */
export type SidebandDisplayScope = <T>(sid: string | undefined, fn: () => T) => T

/** The registry slice of the display: the handler of a kind. Optional on a registry. */
export interface SidebandDisplayRegistry {
  /** The kind names of the registry. */
  kinds(): readonly { kind: string }[]
  /** The display handler of `kind`, or `undefined`. */
  display?(kind: string): SidebandDisplayEntry | undefined
}

/** Options of {@link createDisplay}. */
export interface SidebandDisplayApiOptions {
  /** Target of `sideband.display-failed`. */
  diagnostics?: { warn(source: string, message: string, data?: StructuredData): void }
  /** The capability host of an owner plugin, for a handler with `display.host: true`. */
  displayHost?: SidebandDisplayHostFor
  /** The read scope of a call. Default: no scope. */
  displayScope?: SidebandDisplayScope
}

/** Why a display call failed. */
export type SidebandDisplayFailReason = "error" | "async" | "bad-result"

/** The largest label width, in terminal cells. */
export const DISPLAY_LABEL_CELLS = 80

/** The display members of {@link SidebandApi}. */
export type SidebandDisplayMembers = Pick<SidebandApi, "hasDisplay" | "displayNode" | "display">

/** The API slice that {@link createDisplay} reads: `find` and the handler slice. */
export type SidebandDisplayBase = SidebandReader & Pick<SidebandApi, "neutralize">

const ESC = String.fromCodePoint(0x1b)

/**
 * The escape sequences of a label: CSI (also the C1 form), OSC and DCS-like
 * strings up to BEL or ST, and each other two-char escape.
 */
const ESCAPE_SEQ_RE = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `\\u009b[0-?]*[ -/]*[@-~]`,
    `${ESC}[\\]PX^_][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)?`,
    `${ESC}[@-Z\\\\-_]`,
  ].join("|"),
  "gu",
)

/** The characters that end a line or are white space control characters. */
const LINE_BREAK_RE = /[\t\n\v\f\r\u0085\u2028\u2029]+/gu

/** Control and format characters, and line and paragraph separators. */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * A label that is safe for one terminal line: no escape sequence, no control
 * or format character, one space for each run of line breaks, trimmed, and
 * cut to {@link DISPLAY_LABEL_CELLS} cells.
 *
 * @param raw - The label of the handler.
 */
export function cleanDisplayLabel(raw: string): string {
  const flat = raw
    .replace(ESCAPE_SEQ_RE, "")
    .replace(LINE_BREAK_RE, " ")
    .replace(INVISIBLE_RE, "")
    .trim()
  return truncateDisplayWidth(flat, DISPLAY_LABEL_CELLS)
}

/** True when `v` has a `then` function. Reading `then` can throw: the caller catches it. */
function isThenable(v: unknown): boolean {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  )
}

/** A copy of the checked handler result, or the reason it is bad. */
function checkResult(
  v: unknown,
  mode: SidebandDisplayOptions["mode"],
): SidebandDisplay | "bad-result" | undefined {
  if (v === undefined) return undefined
  if (typeof v !== "object" || v === null) return "bad-result"
  const r = v as Record<string, unknown>
  if (typeof r.label !== "string") return "bad-result"
  const label = cleanDisplayLabel(r.label)
  if (label === "") return undefined
  const out: SidebandDisplay = { label }
  if (r.missing === true) {
    out.missing = true
    return out
  }
  if (mode === "full" && typeof r.text === "string") {
    out.text = r.text
    if (r.truncated === true) out.truncated = true
  }
  return out
}

/**
 * The number of code points in `text[from, to)`. A surrogate pair counts as
 * one, a lone surrogate counts as one.
 */
function codePoints(text: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < to) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/**
 * Build the display members over a registry and the read slice of the API.
 * `noReadScope` holds the same members with no read scope (for a plugin with
 * no `sessions:read`). The two sets share the one-warning-for-each-kind rule.
 *
 * @param registry - The kinds and the display handlers.
 * @param base - The API without the display members (for `find` and the handler slice).
 * @param opts - Diagnostics, the owner host and the read scope.
 */
export function createDisplay(
  registry: SidebandDisplayRegistry,
  base: SidebandDisplayBase,
  opts: SidebandDisplayApiOptions = {},
): SidebandDisplayMembers & { readonly noReadScope: SidebandDisplayMembers } {
  const warned = new Set<string>()
  const scoped = displayMembers(registry, base, opts, warned, opts.displayScope)
  return { ...scoped, noReadScope: displayMembers(registry, base, opts, warned, undefined) }
}

/** The display members with one read scope (`undefined`: no scope). */
function displayMembers(
  registry: SidebandDisplayRegistry,
  base: SidebandDisplayBase,
  opts: SidebandDisplayApiOptions,
  warned: Set<string>,
  readScope: SidebandDisplayScope | undefined,
): SidebandDisplayMembers {
  const scope: SidebandDisplayScope = readScope ?? ((_sid, fn) => fn())
  const entryOf = (kind: string): SidebandDisplayEntry | undefined => registry.display?.(kind)

  /** The read slice that a handler gets as `ctx.sideband`. */
  const slice: SidebandDisplayBase = Object.freeze({
    find: base.find,
    has: base.has,
    startsWith: base.startsWith,
    replace: base.replace,
    strip: base.strip,
    trailing: base.trailing,
    attrs: base.attrs,
    leadingKind: base.leadingKind,
    kindInfo: base.kindInfo,
    neutralize: base.neutralize,
  })

  const fail = (e: SidebandDisplayEntry, kind: string, reason: SidebandDisplayFailReason) => {
    if (warned.has(kind)) return
    warned.add(kind)
    opts.diagnostics?.warn("sideband.display-failed", "", { pluginId: e.owner, kind, reason })
  }

  const displayNode: SidebandApi["displayNode"] = (node, o) => {
    if (o.kinds !== undefined && !o.kinds.includes(node.kind)) return undefined
    const e = entryOf(node.kind)
    if (e === undefined) return undefined
    let raw: unknown
    try {
      const host = e.host ? opts.displayHost?.(e.owner) : undefined
      const ctx = Object.freeze({
        mode: o.mode,
        sideband: slice,
        ...(o.sid !== undefined ? { sid: o.sid } : {}),
        ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}),
        ...(host !== undefined ? { host } : {}),
      })
      raw = scope(o.sid, () => e.fn(node, ctx))
      if (isThenable(raw)) {
        // A native rejected Promise must not be an unhandled rejection.
        if (raw instanceof Promise) raw.catch(() => {})
        fail(e, node.kind, "async")
        return undefined
      }
      // Inside the try: a getter on the result can throw.
      const checked = checkResult(raw, o.mode)
      if (checked === "bad-result") {
        fail(e, node.kind, "bad-result")
        return undefined
      }
      return checked
    } catch {
      fail(e, node.kind, "error")
      return undefined
    }
  }

  const display: SidebandApi["display"] = (text, o) => {
    const plain = (): { segments: SidebandDisplaySegment[]; changed: boolean } => ({
      segments: [{ type: "text", text }],
      changed: false,
    })
    if (text === "" || registry.display === undefined) return plain()
    const names = o.kinds ?? registry.kinds().map((k) => k.kind)
    const kinds = names.filter((k) => entryOf(k) !== undefined)
    if (kinds.length === 0) return plain()
    const nodes: SidebandNode[] = base.find(text, { kinds })
    const segments: SidebandDisplaySegment[] = []
    let at = 0
    let cpAt = 0
    for (const n of nodes) {
      if (n.span.start < at) continue
      const d = displayNode(n, o)
      if (d === undefined) continue
      const startCp = cpAt + codePoints(text, at, n.span.start)
      const endCp = startCp + codePoints(text, n.span.start, n.span.end)
      if (n.span.start > at) segments.push({ type: "text", text: text.slice(at, n.span.start) })
      segments.push({
        type: "node",
        node: n,
        kind: n.kind,
        display: d,
        cp: { start: startCp, end: endCp },
      })
      at = n.span.end
      cpAt = endCp
    }
    if (segments.length === 0) return plain()
    if (at < text.length) segments.push({ type: "text", text: text.slice(at) })
    return { segments, changed: true }
  }

  return {
    hasDisplay: (kind) => entryOf(kind) !== undefined,
    displayNode,
    display,
  }
}
