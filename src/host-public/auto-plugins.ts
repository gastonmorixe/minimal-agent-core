/**
 * Public re-export of src/plugins/auto-plugins.ts (`bootstrapUserPlugins`,
 * the first-run plugin bootstrap: clones the first-party plugins repo that
 * the host names, resolves a GitHub token, drives a spinner callback). Part of the `host-kit` construction kit (S34 exports-gap
 * decision, UNCLEAR resolution #2): genuine, verbatim-reusable product
 * behavior — the CLI should not reimplement a git-clone-based first-run
 * flow.
 *
 * @module host-public/auto-plugins
 */
export * from "../plugins/auto-plugins.ts"
