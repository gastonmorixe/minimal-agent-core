/**
 * Public re-export of src/session/session-store.ts (`SessionStore`, the
 * append-only JSONL writer/reader, and its record types). Part of the
 * `host-kit` construction kit (S34 exports-gap decision): the backing
 * implementation `SessionPersistenceAdapter` wraps, foundational for
 * `--resume`/history.
 *
 * @module host-public/session-store
 */
export * from "../session/session-store.ts"
