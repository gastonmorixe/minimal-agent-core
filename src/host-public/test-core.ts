/**
 * Public re-export of src/test-utils/test-core.ts (`buildTestCore`), dev-only
 * test tooling, not production code. It genuinely depends on core's real
 * (staying-in-core) `buildAgentCore` wiring, so it is exported rather than
 * let a CLI test suite duplicate that risk with its own copy (S34
 * exports-gap decision, `./testing/*`).
 *
 * @module host-public/test-core
 */
export * from "../test-utils/test-core.ts"
