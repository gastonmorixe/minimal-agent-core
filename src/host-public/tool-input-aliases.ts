/**
 * Public re-export shim for `@minimal-agent/core/host/tool-input-aliases`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * NARROW by design: only the alias-resolution functions a host needs to
 * render what the model actually sent (including aliased field names) —
 * `globPatternFromInput` / `globPathFromInput` from
 * `../tools/glob-input.ts` and `writeContentFromInput` /
 * `writePathFromInput` from `../tools/write-input.ts`. The matching
 * execution-time resolvers (`resolveGlobExecArgs` / `resolveWriteExecArgs`)
 * stay core-engine-internal in `../tools.ts` and are deliberately NOT
 * re-exported here.
 *
 * @module host-public/tool-input-aliases
 */

export { globPathFromInput, globPatternFromInput } from "../tools/glob-input.ts"
export { writeContentFromInput, writePathFromInput } from "../tools/write-input.ts"
