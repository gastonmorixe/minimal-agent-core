/**
 * Public re-export of src/binaries/index.ts (the binary-provisioning
 * barrel: `BinaryStore`, `provisionSetups`, `inventoryAdapter`, version
 * helpers, and types) — needed by the optional `mdstream`/`git` auto-fetch
 * feature (S34 exports-gap decision, Phase 0 / Bucket C).
 *
 * @module host-public/binaries
 */
export * from "../binaries/index.ts"
