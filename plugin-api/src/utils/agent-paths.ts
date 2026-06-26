/**
 * The single source of truth for "where does minimal-agent keep its data".
 *
 * This is the LEAF copy: pure path math, no IO, no `src/` imports. Both the
 * host (`src/agent-paths.ts` re-exports these) and every plugin that can take
 * a workspace dependency (`@minimal-agent/plugin-api/utils/agent-paths`) call
 * the SAME functions, so the resolution rule lives in exactly one place.
 *
 * ## The contract
 *
 * `MINIMAL_AGENT_HOME` is authoritative. The host resolves the real home once
 * at boot ({@link resolveAgentHome}) and PUBLISHES it into `process.env`
 * (`publishAgentHomeEnv`, host-only, stays in `src/`), before any plugin loads.
 * From then on the var is set on every plugin surface because they all inherit
 * `process.env` (tool/event/live-area contexts copy it into `ctx.env`,
 * subprocess handlers inherit it). A plugin reads the env-injected value and
 * treats it as the base of its storage.
 *
 * Every function here is PURE and takes the environment as an argument so a
 * test can drive resolution without touching the real `process.env`. The
 * `homedir()` fallback is the last resort for running unit tests outside a
 * host process (where nobody published the var).
 *
 * @module utils/agent-paths
 */

import { homedir } from "node:os"
import { join } from "node:path"

/** The canonical env var that carries the resolved agent home to plugins. */
export const AGENT_HOME_ENV = "MINIMAL_AGENT_HOME"

/**
 * Resolve the agent's home directory. `MINIMAL_AGENT_HOME` wins when set
 * (relocation, tests, sandboxes); otherwise `$HOME/.minimal-agent`; otherwise
 * `os.homedir()/.minimal-agent`. Pure read, no IO.
 *
 * `$HOME` is honored before `os.homedir()` because on macOS `homedir()`
 * resolves via `getpwuid()` and IGNORES the `HOME` env var, so a spawned child
 * (or a test) that sets only `HOME=<tmpdir>` would otherwise read the real
 * `~/.minimal-agent`. Honoring `HOME` keeps a subprocess/test sandbox correct
 * without forcing every caller to also set `MINIMAL_AGENT_HOME`.
 */
export function resolveAgentHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AGENT_HOME_ENV]?.trim()
  if (override) return override
  const home = env.HOME?.trim()
  if (home) return join(home, ".minimal-agent")
  return join(homedir(), ".minimal-agent")
}

/** The sessions directory under the resolved home (`<home>/sessions`). */
export function resolveSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAgentHome(env), "sessions")
}

/**
 * The network-debug capture directory under the resolved home
 * (`<home>/net-dbg`). When `MINIMAL_AGENT_NET_DBG=1` the client mirrors raw
 * HTTP traffic here, one dated session folder per run. This lives under the
 * agent home (not the cwd) so captures from every project land in one
 * relocation-correct place instead of scattering `.net-dbg/` dirs across
 * working directories.
 */
export function resolveNetDbgDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAgentHome(env), "net-dbg")
}
