/**
 * Host wiring — the only place that touches `node:fs` / `node:path` and the
 * agent's environment. Bridges the pure `lib/` core to real disk + the
 * resolved config path + plugin discovery roots, so `lib/` stays host-free.
 *
 * @module config/handlers/wiring
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { DiscoverDeps } from "../lib/discovery.ts"
import type { FsDeps } from "../lib/model.ts"

/**
 * Resolve the config path with the SAME precedence as `src/config.ts`:
 * `MINIMAL_AGENT_CONFIG` override, else `~/.minimal-agent/config.jsonc`
 * (preferred when it exists), else `~/.minimal-agent/config.json`.
 *
 * `env` is the plugin-scoped env (handlers pass `ctx.env`); falls back to
 * `process.env` for the home dir.
 */
export function resolveConfigPath(
  env: Record<string, string> = process.env as Record<string, string>,
): string {
  const override = env.MINIMAL_AGENT_CONFIG
  if (override) return override
  const home = env.HOME || homedir()
  const dir = join(home, ".minimal-agent")
  const jsonc = join(dir, "config.jsonc")
  if (existsSync(jsonc)) return jsonc
  // Prefer writing the documented `.jsonc` form for a fresh file even though
  // the legacy reader also accepts `.json`.
  const legacy = join(dir, "config.json")
  if (existsSync(legacy)) return legacy
  return jsonc
}

/** Build {@link FsDeps} bound to the real config file. */
export function realFsDeps(path: string): FsDeps {
  return {
    path,
    read: () => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return null
      }
    },
    write: (text: string) => {
      writeFileSync(path, text, "utf8")
    },
  }
}

/**
 * The plugin discovery roots, mirroring `PluginLoader.load`'s scan order
 * (project, then home, then embedded). `packageDir` is this plugin's own dir
 * (`<repo>/plugins/config`), so the embedded root is its parent.
 *
 * Order matters: first-seen id wins in `discoverPlugins`, matching the
 * loader's project-over-home-over-embedded precedence.
 */
export function discoveryRoots(
  packageDir: string,
  cwd: string,
  env: Record<string, string> = process.env as Record<string, string>,
): string[] {
  const home = env.HOME || homedir()
  const embeddedRoot = dirname(packageDir) // <repo>/plugins
  return [
    join(cwd, ".agents", "plugins"), // project
    join(home, ".agents", "plugins"), // home
    embeddedRoot, // embedded (ships with the agent)
  ]
}

/** Build {@link DiscoverDeps} wired to real fs. */
export function realDiscoverDeps(roots: string[]): DiscoverDeps {
  return {
    roots,
    join: (...parts: string[]) => join(...parts),
    readDir: (path: string) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    },
    readFile: (path: string) => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return null
      }
    },
  }
}
