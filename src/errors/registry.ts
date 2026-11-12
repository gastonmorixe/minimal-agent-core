/**
 * Error renderer registry. Holds no text. Dispatches on `kind` only.
 *
 * @module errors/registry
 */

import { CoreError } from "./core-error.ts"
import { isCoreErrorJson } from "./guard.ts"
import type { CoreErrorJson, ErrorRenderer, ErrorRendererRegistry } from "./types.ts"

/** Owner id that marks the host. Any other owner id is a plugin. */
export const HOST_OWNER_ID = "host"

interface Entry {
  r: ErrorRenderer
  host: boolean
  exact: boolean
}

/**
 * Create a registry. Precedence for one kind, first non-undefined result wins:
 * owner `"host"` before any other owner, then exact kind before `"*"`, then
 * registration order. So a host `"*"` renderer beats a plugin exact-kind
 * renderer: the spec says a host renderer MUST win over a plugin renderer for
 * the same kind, and `"*"` covers every kind. Input that is neither a
 * `CoreError` nor a `CoreErrorJson` renders to `undefined`. Open question: the spec gives no host marker, so the
 * owner id `"host"` is a convention.
 */
export function createErrorRendererRegistry(): ErrorRendererRegistry {
  const entries: Entry[] = []
  return {
    register(r, ownerId) {
      entries.push({ r, host: ownerId === HOST_OWNER_ID, exact: r.kinds !== "*" })
    },
    render(err: CoreError | CoreErrorJson, locale?: string) {
      const input: unknown = err
      const json: unknown = input instanceof CoreError ? input.toJSON() : input
      if (!isCoreErrorJson(json)) return undefined
      const rank = (e: Entry) => (e.host ? 0 : 2) + (e.exact ? 0 : 1)
      const hits = entries
        .filter((e) => e.r.kinds === "*" || e.r.kinds.includes(json.kind))
        .sort((a, b) => rank(a) - rank(b))
      for (const h of hits) {
        const out = h.r.render(json, locale)
        if (out !== undefined) return out
      }
      return undefined
    },
  }
}
