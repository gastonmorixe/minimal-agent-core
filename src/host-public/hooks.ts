/**
 * Public re-export of src/plugins/hooks/hooks.ts (`Hooks`, the single
 * plugin-hook facade). Part of the `host-kit` construction kit (S34
 * exports-gap decision) — a host needs to type its `Hooks` dependency
 * before feeding it into `createLifecyclePort`.
 *
 * @module host-public/hooks
 */
export * from "../plugins/hooks/hooks.ts"
