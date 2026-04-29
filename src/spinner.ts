/**
 * Backwards-compat shim — the spinner package was decoupled into
 * `src/spinner/`. Existing imports of `./spinner.ts` keep working via
 * this re-export. New code should import from `./spinner/index.ts` (or
 * the dedicated submodules) directly.
 *
 * @module spinner
 * @see ./spinner/index.ts
 */

export * from "./spinner/index.ts"
