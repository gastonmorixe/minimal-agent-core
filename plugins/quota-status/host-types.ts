/**
 * LOCAL structural re-declaration of the host surfaces this plugin
 * consumes that have no home in the leaf contract package.
 *
 * The decoupling contract (Wave D): a plugin may NOT import host code
 * (`src/...`), not even type-only — it must be able to live in its own
 * repository. Provider-neutral types that the package owns are imported
 * from `@minimal-agent/plugin-api/*`; the slices below are host-internal
 * shapes with no package export, so we re-declare exactly the fields we
 * use and rely on TypeScript's structural typing (the real host object
 * satisfies these at runtime).
 *
 * The host-side source of truth is `src/session-tokens.ts`. Keep field
 * names in lockstep — the plugin's own tests pin the rendered output.
 *
 * @module quota-status/host-types
 */

/**
 * Session-wide token accumulator snapshot. Mirror of the host's
 * `SessionTokens` (`src/session-tokens.ts`). The renderer reads
 * `contextSize` for the context-usage bar and the other cumulative
 * fields for the (debug) totals; all are plain numbers.
 */
export interface SessionTokens {
  /** New input tokens (not served from cache). Cumulative across turns. */
  input: number
  /** Output (generated) tokens. Cumulative across turns. */
  output: number
  /** Cumulative `cache_read_input_tokens` across all turns. */
  cacheRead: number
  /** Input tokens written to cache. Cumulative. */
  cacheCreate: number
  /** Sum of all four cumulative fields. */
  total: number
  /** Number of API responses contributing to these totals. */
  turns: number
  /** Latest turn's input footprint (`input + cacheRead + cacheCreate`). */
  contextSize: number
}
