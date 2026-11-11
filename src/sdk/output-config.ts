/**
 * Build `outputConfig` for a transport send from effort + optional schema.
 *
 * @module sdk/output-config
 */

/** The `outputConfig.format` shape a send carries. */
export interface OutputConfigFormat {
  type: string
  schema?: unknown
  /** Strict structured output was asked for (SPEC-ONESHOT R2). Absent when off. */
  strict?: boolean
}

/**
 * Spreadable `{ outputConfig }` (or `{}`) for `sendFn` options. `strict`
 * goes into the format only when it is true and a schema is set: strict
 * without a schema has no effect.
 */
export function outputConfigSpread(opts: {
  effort?: string
  outputSchema?: object
  strict?: boolean
}): {
  outputConfig?: {
    effort?: string
    format?: OutputConfigFormat
  }
} {
  const cfg: {
    effort?: string
    format?: OutputConfigFormat
  } = {}
  if (opts.effort) cfg.effort = opts.effort
  if (opts.outputSchema) {
    cfg.format = {
      type: "json_schema",
      schema: opts.outputSchema,
      ...(opts.strict === true ? { strict: true } : {}),
    }
  }
  return Object.keys(cfg).length > 0 ? { outputConfig: cfg } : {}
}
