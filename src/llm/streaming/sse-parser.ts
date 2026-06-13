/**
 * Re-export shim — the implementation moved to the leaf contract package
 * `@minimal-agent/plugin-api` in Wave D-0.
 *
 * The generic SSE parser now lives at
 * `plugin-api/src/utils/sse-parser.ts`. This file stays at the old path so
 * every existing core importer (`./streaming/sse-parser.ts`) keeps
 * compiling untouched while plugins migrate to the package import
 * directly. Behavior is byte-identical (the package file is a verbatim
 * copy).
 *
 * @module llm/streaming/sse-parser
 */

export * from "@minimal-agent/plugin-api/utils/sse-parser"
