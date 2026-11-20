/**
 * Public re-export of `src/architecture/sideband-literal-scan.ts`, dev-only
 * test tooling, not production code. The plugins and CLI gates of the
 * sideband guard use this one engine with their own roots and baselines
 * (`./testing/*`, design section 5).
 *
 * @module host-public/sideband-literal-scan
 */
export * from "../architecture/sideband-literal-scan.ts"
