/**
 * Build `outputConfig` for a transport send from effort + optional schema.
 *
 * @module sdk/output-config
 */

/** Spreadable `{ outputConfig }` (or `{}`) for `sendFn` options. */
export function outputConfigSpread(opts: { effort?: string; outputSchema?: object }): {
  outputConfig?: {
    effort?: string
    format?: { type: string; schema?: unknown }
  }
} {
  const cfg: {
    effort?: string
    format?: { type: string; schema?: unknown }
  } = {}
  if (opts.effort) cfg.effort = opts.effort
  if (opts.outputSchema) cfg.format = { type: "json_schema", schema: opts.outputSchema }
  return Object.keys(cfg).length > 0 ? { outputConfig: cfg } : {}
}
