/**
 * Public re-export of src/modes/modes.ts (`ModeManager` and its
 * change-event / attachment types). Part of the `host-kit` construction kit
 * (S34 exports-gap decision) — needed directly, not just through the SDK's
 * `ModeProvider` port, by status/chrome rendering code.
 *
 * @module host-public/modes
 */
export * from "../modes/modes.ts"
