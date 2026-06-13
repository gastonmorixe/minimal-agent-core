/**
 * The single source of truth for "where does minimal-agent keep its data", and
 * the mechanism by which that location is communicated to PLUGINS.
 *
 * ## The problem this solves
 *
 * Plugins live in their own repos and must not hardcode `~/.minimal-agent`.
 * The home dir can be relocated (`MINIMAL_AGENT_HOME`), and a plugin that bakes
 * in `join(homedir(), ".minimal-agent")` writes to the wrong place the moment a
 * user, a test harness, or a sandbox moves it. A plugin needs the host to TELL
 * it where its sanctioned storage is.
 *
 * ## The mechanism
 *
 * `MINIMAL_AGENT_HOME` is the contract. The host resolves the real home once at
 * boot ({@link resolveAgentHome}) and PUBLISHES it into `process.env`
 * ({@link publishAgentHomeEnv}) before any plugin loads. From then on the var is
 * authoritative and reaches every plugin surface uniformly, because they all
 * inherit `process.env`:
 *
 *   - tool / event / live-area handler contexts (`ctx.env` is built from
 *     `process.env`),
 *   - in-process turn-attachment factories,
 *   - subprocess handlers (spawned with the inherited environment).
 *
 * A plugin reads `process.env.MINIMAL_AGENT_HOME` and treats it as the base of
 * its storage (`<home>/intercom/…`, `<home>/sessions/<sid>.foo`, …). The
 * homedir fallback a plugin keeps is then only a last resort for running its
 * own unit tests outside a host process.
 *
 * Keeping ONE resolver here also lets the rest of `src/` stop open-coding
 * `join(homedir(), ".minimal-agent")` (44 copies today, several of which ignore
 * the override) and converge on a consistent, overridable path.
 *
 * @module agent-paths
 */

import { homedir } from "node:os"
import { join } from "node:path"

/** The canonical env var that carries the resolved agent home to plugins. */
export const AGENT_HOME_ENV = "MINIMAL_AGENT_HOME"

/**
 * Resolve the agent's home directory. `MINIMAL_AGENT_HOME` wins when set
 * (relocation, tests, sandboxes); otherwise `~/.minimal-agent`. Pure read.
 */
export function resolveAgentHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AGENT_HOME_ENV]?.trim()
  if (override) return override
  // Fall back to $HOME before os.homedir(): on macOS homedir() resolves via
  // getpwuid() and IGNORES the HOME env var, so a spawned child (or a test)
  // that sets only HOME=<tmpdir> would otherwise read the real ~/.minimal-agent.
  // Honoring HOME here keeps a subprocess/test sandbox correct without forcing
  // every caller to also set MINIMAL_AGENT_HOME.
  const home = env.HOME?.trim()
  if (home) return join(home, ".minimal-agent")
  return join(homedir(), ".minimal-agent")
}

/** The sessions directory under the resolved home. */
export function resolveSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAgentHome(env), "sessions")
}

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
