/**
 * Public re-export shim for `@minimal-agent/core/host/tool-time`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `fmtToolTime` + the stateful `ToolTimeTracker` (day-rollover tracking)
 * used to render "when did this tool fire" suffixes consistently across
 * live and replayed transcripts. See `../tools/tool-time.ts` for the
 * full contract.
 *
 * @module host-public/tool-time
 */

export * from "../tools/tool-time.ts"
