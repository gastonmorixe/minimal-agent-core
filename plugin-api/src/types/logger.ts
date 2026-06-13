/**
 * Plugin-scoped diagnostic logger — type-only contract slice.
 *
 * Wave D-1: `src/plugins/types.ts` (now the package's `types/plugin.ts`)
 * references `PluginLogger` for the `log` field on every handler context. The
 * runtime implementation (`createPluginLogger`, the diagnostic bus + RFC 5424
 * machinery) is HOST STATE and stays in `src/diagnostic-bus.ts`. This module is
 * a faithful, type-only structural copy of that logger surface so the leaf
 * contract package depends on nothing in `src/`. TypeScript's structural typing
 * makes the host's real logger satisfy this interface at runtime, and the host
 * value assigns into a package-typed `TUIContext.log` without a cast.
 *
 * @module types/logger
 */

/**
 * Free-form key/value pairs that get serialized into RFC 5424
 * STRUCTURED-DATA. Keys with `=`, `]`, `"`, or whitespace are sanitized
 * to underscore by the formatter; values are escape-quoted.
 */
export type StructuredData = Readonly<Record<string, string | number | boolean>>

/**
 * Logger interface plugins receive as `ctx.log`. Same shape as the
 * global `diag` helpers, but auto-prefixes the `source` field with the
 * plugin id so log events are identifiable in the file log and TUI surface.
 *
 * Convention: pluginId is lowercase-kebab; the `source` argument is a
 * dotted-kebab sub-id (e.g. `ctx.log.warn("api-error", ...)`). The
 * emitted source is `<pluginId>.<source>`.
 */
export interface PluginLogger {
  emergency(source: string, message: string, sd?: StructuredData): void
  alert(source: string, message: string, sd?: StructuredData): void
  critical(source: string, message: string, sd?: StructuredData): void
  error(source: string, message: string, sd?: StructuredData): void
  warn(source: string, message: string, sd?: StructuredData): void
  notice(source: string, message: string, sd?: StructuredData): void
  info(source: string, message: string, sd?: StructuredData): void
  debug(source: string, message: string, sd?: StructuredData): void
}
