/**
 * Public re-export of src/llm/test-fixtures.ts (`registerTestProvider`), a
 * ~300-line synthetic provider fixture. Dev-only test tooling, not
 * production code. Exporting it saves a CLI test suite from reimplementing
 * a fake provider from scratch (S34 exports-gap decision, `./testing/*`).
 *
 * @module host-public/provider-fixture
 */
export * from "../llm/test-fixtures.ts"
