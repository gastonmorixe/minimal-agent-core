/**
 * The one sideband API (design `40-design.md` section 2). Core builds `find`,
 * `has`, `startsWith`, `replace`, `strip`, `trailing` and `attrs` on the
 * codec `parse` spans and the kind declarations, so core knows no wire form.
 * The codec plugin holds each tag literal and each regex.
 *
 * No codec: `ready` is false, `render` and `example` give `""` and emit one
 * `sideband.render-dropped` diagnostic for each kind, the read functions find
 * no node, `leadingKind` gives `undefined`, and `strip`, `replace` and
 * `neutralize` give the input. `strip` with `lenient` uses the codec
 * `stripLenient` when it has one; `leadingKind` uses the codec `leadingNode`
 * when it has one, else the `parse` spans. The
 * codec check comes before the kind check: a bare core has no codec and no
 * kind, so `render` gives `""` and does not throw. With a codec, an unknown
 * kind throws `SidebandKindUnknownError`.
 *
 * @packageDocumentation
 */

import type { StructuredData } from "../bus/diagnostic-bus.ts"

import { SidebandCodecMissingError, SidebandKindUnknownError } from "./errors.ts"
import type {
  ReadonlySidebandRegistry,
  SidebandApi,
  SidebandAttrs,
  SidebandAttrValue,
  SidebandCodec,
  SidebandKind,
  SidebandNode,
  SidebandQuery,
  StreamScanner,
} from "./types.ts"

/** A registry that can give a codec. `codec()` throws `SidebandCodecMissingError` when none is set. */
export type SidebandApiRegistry = ReadonlySidebandRegistry & { codec(): SidebandCodec }

/** The diagnostics slice that {@link createSidebandApi} uses. */
export interface SidebandApiDiagnostics {
  /** Report one warning. */
  warn(source: string, message: string, data?: StructuredData): void
}

/** Options of {@link createSidebandApi}. */
export interface SidebandApiOptions {
  /** Target of `sideband.render-dropped`. Without it, no diagnostic is sent. */
  diagnostics?: SidebandApiDiagnostics
  /**
   * `"empty"` (default): with no codec, `render` and `example` give `""`.
   * `"throw"`: they throw `SidebandCodecMissingError` (the S1.1 plugin context).
   */
  missingCodec?: "empty" | "throw"
}

/** The diagnostics target of each API that {@link createSidebandApi} built. */
const API_DIAGNOSTICS = new WeakMap<object, SidebandApiDiagnostics>()

/**
 * The diagnostics target that `api` was built with, or `undefined` (no
 * target, or an object that {@link createSidebandApi} did not build).
 */
export function sidebandDiagnosticsOf(api: object): SidebandApiDiagnostics | undefined {
  return API_DIAGNOSTICS.get(api)
}

/** True when `inner` is inside `outer` and is not `outer`. */
function inside(inner: SidebandNode, outer: SidebandNode): boolean {
  return (
    inner !== outer &&
    inner.span.start >= outer.span.start &&
    inner.span.end <= outer.span.end &&
    (inner.span.start !== outer.span.start || inner.span.end !== outer.span.end)
  )
}

/** Typed value of one attribute, or `undefined` for a bad value. */
function typedValue(
  raw: string,
  decl: SidebandKind["attrs"][string],
): SidebandAttrValue | undefined {
  switch (decl.type) {
    case "string":
      return raw
    case "int":
      return /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined
    case "bool":
      return raw === "true" ? true : raw === "false" ? false : undefined
    case "enum":
      return decl.values?.includes(raw) === true ? raw : undefined
    default:
      return undefined
  }
}

/** A scanner with no codec: each chunk is plain text. */
function passThroughScanner(): StreamScanner {
  let onText: (text: string) => void = () => {}
  return {
    write(chunk) {
      if (chunk !== "") onText(chunk)
    },
    end() {},
    onText(cb) {
      onText = cb
    },
    onNode() {},
  }
}

/** True for a space, tab, carriage return or line feed. */
const isSpace = (ch: string | undefined): boolean =>
  ch === " " || ch === "\n" || ch === "\t" || ch === "\r"

/** First index of `text` that is not white space (`text.length` when none). */
function firstContent(text: string): number {
  let i = 0
  while (i < text.length && isSpace(text[i])) i++
  return i
}

/**
 * Build the sideband API over a registry. The codec is read on each call, so
 * an API made before the codec is built sees it later.
 *
 * @param registry - Registry with kinds and an optional codec.
 * @param opts - Diagnostics target and the no-codec mode.
 * @returns The API.
 */
export function createSidebandApi(
  registry: SidebandApiRegistry,
  opts: SidebandApiOptions = {},
): SidebandApi {
  const dropped = new Set<string>()
  const strict = opts.missingCodec === "throw"

  /** The codec, or `undefined` when none is loaded. Other errors pass. */
  const codec = (): SidebandCodec | undefined => {
    try {
      return registry.codec()
    } catch (e) {
      if (e instanceof SidebandCodecMissingError) return undefined
      throw e
    }
  }

  const drop = (kind: string): string => {
    if (strict) throw new SidebandCodecMissingError()
    if (!dropped.has(kind)) {
      dropped.add(kind)
      opts.diagnostics?.warn("sideband.render-dropped", "", { kind })
    }
    return ""
  }

  const decl = (kind: string): SidebandKind => {
    const d = registry.kind(kind)
    if (!d) throw new SidebandKindUnknownError(kind)
    return d
  }

  const matches = (n: SidebandNode, q: SidebandQuery): boolean => {
    if (n.form === "v1-text" && q.legacyText !== true) return false
    if (q.kinds !== undefined && !q.kinds.includes(n.kind)) return false
    if (q.direction !== undefined || q.placement !== undefined) {
      const d = registry.kind(n.kind)
      if (!d) return false
      if (q.direction !== undefined && d.direction !== q.direction) return false
      if (q.placement !== undefined && d.placement !== q.placement) return false
    }
    return true
  }

  const find = (text: string, q: SidebandQuery = {}): SidebandNode[] => {
    const c = codec()
    if (!c || text === "") return []
    const all = c.parse(text, { nested: q.nested === true, legacyText: q.legacyText === true })
    // Start ascending, end descending: a parent comes before its children.
    const sorted = [...all].sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end)
    const top = q.nested === true ? sorted : outermost(sorted)
    return top.filter((n) => matches(n, q))
  }

  const replace: SidebandApi["replace"] = (text, fn, q) => {
    const nodes = find(text, q)
    const parts: string[] = []
    // End of the last replaced node: a node that starts before it is gone.
    let pos = 0
    // Kept nodes that contain the walk. `fn` sees a child only when its parent is kept.
    const open: SidebandNode[] = []
    for (const n of nodes) {
      while (open.length > 0 && n.span.start >= (open[open.length - 1] as SidebandNode).span.end) {
        open.pop()
      }
      if (n.span.start < pos) continue
      const top = open[open.length - 1]
      // Skip a node that crosses a kept node, or has the same span.
      if (top && (n.span.end > top.span.end || !inside(n, top))) continue
      const next = fn(n)
      if (next === undefined) {
        open.push(n)
        continue
      }
      parts.push(text.slice(pos, n.span.start), next)
      pos = n.span.end
    }
    if (parts.length === 0) return text
    parts.push(text.slice(pos))
    return parts.join("")
  }

  /** The registered kind names that match the kind, direction and placement filters of `q`. */
  const kindNames = (q: SidebandQuery): string[] =>
    registry
      .kinds()
      .filter(
        (k) =>
          (q.kinds === undefined || q.kinds.includes(k.kind)) &&
          (q.direction === undefined || k.direction === q.direction) &&
          (q.placement === undefined || k.placement === q.placement),
      )
      .map((k) => k.kind)

  /** The region at the end with `parse`: the nodes at the end, white space between them. */
  const trailingByParse = (text: string, q: SidebandQuery): ReturnType<SidebandApi["trailing"]> => {
    const nodes = find(text, { ...q, legacyText: true })
    const region: SidebandNode[] = []
    let end = text.length
    while (end > 0 && isSpace(text[end - 1])) end--
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i] as SidebandNode
      if (n.span.end !== end) break
      region.push(n)
      end = n.span.start
      while (end > 0 && isSpace(text[end - 1])) end--
    }
    if (region.length === 0) return { bodyEnd: text.length, nodes: [] }
    return { bodyEnd: end, nodes: region.reverse() }
  }

  const trailing: SidebandApi["trailing"] = (text, q = {}) => {
    const c = codec()
    if (!c) return { bodyEnd: text.length, nodes: [] }
    const plain = q.kinds === undefined && q.direction === undefined && q.placement === undefined
    if (plain && c.trailingStart) {
      // A fast hint only: use it when the nodes after it cover the text to
      // its end. Else (no node, a gap, or a kind the hint does not know, so
      // the hint is the text end) parse. Limit: a hint that finds only the
      // last part of a region is not detected; the region is then shorter.
      const start = c.trailingStart(text)
      if (start >= 0 && start < text.length) {
        const tail = text.slice(start)
        const nodes = find(tail, { ...q, legacyText: true })
        if (covers(tail, nodes)) return { bodyEnd: start, nodes: nodes.map((n) => shift(n, start)) }
      }
    }
    return trailingByParse(text, q)
  }

  const api: SidebandApi = {
    get ready() {
      return codec() !== undefined
    },
    render(kind, msg = {}) {
      const c = codec()
      if (!c) return drop(kind)
      return c.render(decl(kind), { ...msg, kind })
    },
    find,
    has: (text, q) => find(text, q).length > 0,
    startsWith(text, q) {
      const at = firstContent(text)
      return find(text, q).some((n) => n.span.start === at)
    },
    replace,
    strip(text, q = {}) {
      const { lenient, keepBody, replacement, ...query } = q
      const c = codec()
      if (!c || text === "") return text
      if (lenient === true && c.stripLenient) {
        // The codec reads kinds only: a direction or placement filter is a kind list.
        const kinds =
          query.direction !== undefined || query.placement !== undefined
            ? kindNames(query)
            : query.kinds
        return c.stripLenient(text, {
          ...(kinds !== undefined ? { kinds } : {}),
          ...(keepBody !== undefined ? { keepBody } : {}),
          ...(replacement !== undefined ? { replacement } : {}),
        })
      }
      return replace(text, () => replacement ?? "", query)
    },
    leadingKind(text) {
      const c = codec()
      if (!c || text === "") return undefined
      const n = c.leadingNode
        ? c.leadingNode(text)
        : find(text).find((x) => x.span.start === firstContent(text))
      return n?.kind
    },
    kindInfo(kind) {
      const d = registry.kind(kind)
      return d ? { direction: d.direction, placement: d.placement } : undefined
    },
    trailing,
    attrs(node) {
      const d = registry.kind(node.kind)
      const out: Record<string, SidebandAttrValue> = {}
      if (!d) return out
      for (const [name, attrDecl] of Object.entries(d.attrs)) {
        const raw = node.attrs[name]
        if (raw === undefined) continue
        const v = typedValue(raw, attrDecl)
        if (v !== undefined) out[name] = v
      }
      return out as SidebandAttrs
    },
    neutralize(untrusted) {
      const c = codec()
      return c ? c.neutralize(untrusted) : untrusted
    },
    scanner(scanOpts) {
      const c = codec()
      return c ? c.scanner(scanOpts) : passThroughScanner()
    },
    name(kind) {
      const c = codec()
      if (!c) return kind
      const d = decl(kind)
      return c.name?.(d) ?? d.kind
    },
    example(kind, msg) {
      const c = codec()
      if (!c) return drop(kind)
      return c.example(decl(kind), msg ? { ...msg, kind } : undefined)
    },
    kinds(q = {}) {
      return registry
        .kinds()
        .filter(
          (k) =>
            (q.direction === undefined || k.direction === q.direction) &&
            (q.placement === undefined || k.placement === q.placement),
        )
    },
  }
  if (opts.diagnostics) API_DIAGNOSTICS.set(api, opts.diagnostics)
  return api
}

/**
 * The nodes that no other node contains. `sorted` is in start ascending, end
 * descending order. One pass: a node is inside when an earlier node ends
 * after it, or ends at the same index and starts before it.
 */
function outermost(sorted: readonly SidebandNode[]): SidebandNode[] {
  const out: SidebandNode[] = []
  let maxEnd = -1
  let startAtMax = -1
  for (const n of sorted) {
    const { start, end } = n.span
    if (end < maxEnd || (end === maxEnd && startAtMax < start)) continue
    out.push(n)
    if (end > maxEnd) {
      maxEnd = end
      startAtMax = start
    }
  }
  return out
}

/**
 * True when `nodes` (top-level, sorted) cover `text` to its end, with only
 * white space before, between and after them, and there is one node or more.
 */
function covers(text: string, nodes: readonly SidebandNode[]): boolean {
  if (nodes.length === 0) return false
  let at = 0
  for (const n of nodes) {
    while (at < n.span.start && isSpace(text[at])) at++
    if (at !== n.span.start) return false
    at = n.span.end
  }
  while (at < text.length && isSpace(text[at])) at++
  return at === text.length
}

/** A copy of `n` with each span moved by `by`. */
function shift(n: SidebandNode, by: number): SidebandNode {
  const move = (s: { start: number; end: number }) => ({ start: s.start + by, end: s.end + by })
  return {
    ...n,
    span: move(n.span),
    ...(n.open ? { open: move(n.open) } : {}),
    ...(n.close ? { close: move(n.close) } : {}),
  }
}

/** A frozen registry with no kind and no codec. */
const EMPTY_REGISTRY: SidebandApiRegistry = Object.freeze({
  kind: () => undefined,
  kinds: () => [],
  codec: (): SidebandCodec => {
    throw new SidebandCodecMissingError()
  },
})

/**
 * The API with no codec and no kind: `render` gives `""`, the read functions
 * find nothing. The default where no loader is wired. It sends no diagnostic.
 */
export const NO_SIDEBAND: SidebandApi = Object.freeze(createSidebandApi(EMPTY_REGISTRY))
