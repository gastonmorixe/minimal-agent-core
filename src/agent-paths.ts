/**
 * Host-side facade over the agent-home resolver, plus the boot-time publisher.
 *
 * ## Where the resolution rule lives
 *
 * The pure resolver ({@link resolveAgentHome}, {@link resolveSessionsDir},
 * {@link resolveNetDbgDir}, {@link AGENT_HOME_ENV}) lives in the LEAF contract
 * package `@minimal-agent/plugin-api/utils/agent-paths` so the host (`src/`)
 * and every plugin that can take a workspace dependency call the SAME
 * functions. This module RE-EXPORTS them so existing `src/` imports
 * (`./agent-paths.ts`) keep working unchanged, and adds the one piece that is
 * host-only: {@link publishAgentHomeEnv}, which mutates `process.env`.
 *
 * ## The mechanism (unchanged)
 *
 * `MINIMAL_AGENT_HOME` is the contract. The host resolves the real home once
 * at boot ({@link resolveAgentHome}) and PUBLISHES it into `process.env`
 * ({@link publishAgentHomeEnv}) before any plugin loads. From then on the var
 * is authoritative and reaches every plugin surface uniformly, because they
 * all inherit `process.env`:
 *
 *   - tool / event / live-area handler contexts (`ctx.env` is built from
 *     `process.env`),
 *   - the `paths` host capability (`ctx.host.paths`, an in-process facade over
 *     this same resolver),
 *   - in-process turn-attachment factories,
 *   - subprocess handlers (spawned with the inherited environment).
 *
 * A plugin reads the env-injected home (or `ctx.host.paths`) and treats it as
 * the base of its storage (`<home>/intercom/…`, `<home>/sessions/<sid>.foo`,
 * …). The homedir fallback a plugin keeps is then only a last resort for
 * running its own unit tests outside a host process.
 *
 * @module agent-paths
 */

export {
  AGENT_HOME_ENV,
  resolveAgentHome,
  resolveNetDbgDir,
  resolveSessionsDir,
} from "@minimal-agent/plugin-api/utils/agent-paths"

import { AGENT_HOME_ENV, resolveAgentHome } from "@minimal-agent/plugin-api/utils/agent-paths"

/**
 * Publish the resolved agent home into `process.env.MINIMAL_AGENT_HOME` so that
 * every plugin (and subprocess) inherits an authoritative, relocation-correct
 * base path instead of guessing `~/.minimal-agent`.
 *
 * Idempotent and override-preserving: if the var is already set (a user/test
 * relocation), it is normalized but never replaced by the default. Call once,
 * early in `main()`, before the plugin loader runs.
 *
 * @returns the resolved home that is now guaranteed to be in `process.env`.
 */
export function publishAgentHomeEnv(env: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolveAgentHome(env)
  env[AGENT_HOME_ENV] = resolved
  return resolved
}
