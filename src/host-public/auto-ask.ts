/**
 * Public re-export of src/modes/auto-ask.ts (`AutoAskController`). Rides
 * along beside `./modes` in the `host-kit` construction kit (S34
 * exports-gap decision): it wires editor input events to a `ModeManager` to
 * auto-flip into ASK mode, so it needs the concrete class, not just a
 * signal.
 *
 * @module host-public/auto-ask
 */
export * from "../modes/auto-ask.ts"
