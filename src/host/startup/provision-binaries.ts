/**
 * Plugin binary-provisioning phase for the CLI entry point.
 *
 * Each plugin's optional `setup()` declares the external binaries it
 * needs (hardcoded url/sha256/version); the host installs/updates any
 * that are missing or outdated into the managed `~/.minimal-agent/bin/`,
 * with a startup-row spinner + a syslog audit trail in
 * `~/.minimal-agent/ma.log`. A plugin NEVER downloads or probes paths
 * itself. If a plugin marks a binary mandatory (`haltIfMissing`) and it
 * can't be provisioned, boot stops with the plugin's message rather
 * than letting the user hit a broken tool at first call.
 *
 * Split out of `src/index.ts` to keep that file under the `max-lines`
 * lint budget.
 *
 * @module startup/provision-binaries
 */

import { diag } from "../../diagnostic-bus.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import { renderBinaryProvisionHalt } from "../ui/chrome/binary-provision.ts"
import { writeCommandRows } from "../ui/command-output.ts"
import { startStartupRowSpinner } from "../ui/startup/tree.ts"
import { c } from "../ui/style/ansi.ts"

/**
 * Run every plugin's `setup()` and provision the binaries they require.
 *
 * The caller gates this to interactive (header) boots and honors
 * `MINIMAL_AGENT_NO_BINARY_SETUP=1`; this function assumes the gate
 * already passed. On a `haltIfMissing` failure it prints the plugin's
 * message and exits the process with code 1.
 *
 * @param loader - The loaded plugin set whose `runSetups` declares
 *   binary requirements.
 */
export async function provisionPluginBinaries(loader: PluginLoader): Promise<void> {
  const { BinaryStore, inventoryAdapter, provisionSetups } = await import("../../binaries/index.ts")
  const { resolveGithubToken } = await import("../../auto-plugins.ts")
  // Memoized token resolver (the user's own GitHub token), used as the
  // FALLBACK for `github-release` sources that ship no embedded credential.
  // A plugin that bakes in its own read-only token (so account-less copies
  // can pull) never reaches this. Resolved at most once per boot.
  let tokenCache: string | null | undefined
  const store = new BinaryStore(undefined, {
    tokenProvider: async () => {
      if (tokenCache === undefined) tokenCache = await resolveGithubToken()
      return tokenCache
    },
    // Route binary lifecycle events onto the diagnostic bus so they land in
    // both the per-session log and the persistent `~/.minimal-agent/ma.log`
    // audit trail. Severity maps 1:1 to the diag helpers.
    log: (severity, source, message, sd) => {
      diag[severity](source, message, sd)
    },
  })
  let setups: Awaited<ReturnType<typeof loader.runSetups>> = []
  try {
    setups = await loader.runSetups(inventoryAdapter(store))
  } catch (e) {
    diag.notice(
      "binaries.setup",
      `plugin setup phase failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const needsWork = setups.some((s) =>
    (s.result.requireBinaries ?? []).some((spec) => store.status(spec) !== "satisfied"),
  )
  if (setups.length > 0 && needsWork) {
    const row = startStartupRowSpinner("binaries", "provisioning")
    const summary = await provisionSetups(store, setups, (p) => {
      if (p.phase === "fetching" && p.fraction != null) {
        // (spinner label is static; granular bytes land in the file log)
      }
    })
    // Render each touched binary as `<sigil>name (version)`, the version dim.
    // e.g. `+obscura (1780598942)` on a fresh install, `↑obscura (…)` on update.
    const withVer = (name: string): string => {
      const v = summary.versions[name]
      return v ? `${name} ${c.dim(`(${v})`)}` : name
    }
    const parts: string[] = []
    if (summary.installed.length > 0)
      parts.push(summary.installed.map((n) => `+${withVer(n)}`).join(", "))
    if (summary.updated.length > 0)
      parts.push(summary.updated.map((n) => `↑${withVer(n)}`).join(", "))
    if (summary.failed.length > 0)
      parts.push(c.boldRed(`✗${summary.failed.map((f) => f.name).join(", ")}`))
    const label = parts.length > 0 ? parts.join(c.dim(" · ")) : c.dim("up to date")
    if (summary.halt) row.fail(c.boldRed(label))
    else row.ok(label)
    if (summary.halt) {
      writeCommandRows(renderBinaryProvisionHalt(summary.halt), process.stderr)
      process.exit(1)
    }
  }
}
