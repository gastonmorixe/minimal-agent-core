/**
 * Public re-export of src/llm/provider-plugin.ts — the stateful provider
 * registry (`registerProviderPlugin`, `listProviderPlugins`,
 * `findProviderPlugin`, `canonicalProviderId`, `activateProviderPlugins`,
 * `clearProviderPlugins`) plus its re-exported plugin-api contract types.
 * The highest-value module in this cluster: every login, logout, list-
 * (models/providers), and auth-status command, plus `provider-boot.ts`,
 * walk this registry (S34 exports-gap decision, Phase 0 / Bucket C).
 *
 * @module host-public/provider-plugin
 */
export * from "../llm/provider-plugin.ts"
