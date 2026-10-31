/**
 * Core timer inventory and its scanner (spec S43). The ratchet lives in
 * `src/architecture/timer-inventory.test.ts`.
 *
 * THE RULE: every non-test core file that calls `setTimeout` or
 * `setInterval` is listed in {@link TIMER_INVENTORY} with its call-site
 * count, an owner, and a reason. A timer is not an agent loop (E7): these are
 * timeouts, debounces, spinner frames, keepalives, and kill grace periods.
 * The list only shrinks: a new timer call fails the test, and a removed one
 * must lower or drop its entry.
 *
 * Planned exits: the reflection cooldown timers leave core in S30. The
 * `cli` entries leave with their files in S34. The network keepalive stays
 * (EM14).
 *
 * Test code (`*.test.ts` and `src/test-utils/`) is not scanned. Regenerate
 * the counts after a cleanup with:
 *
 *   bun -e 'import("./src/architecture/timer-inventory.ts").then(m =\>
 *     console.log(m.scanTimerCalls(".")))'
 *
 * @module architecture/timer-inventory
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { stripComments, tsFilesUnder } from "./provider-scan.ts"

/** One inventoried file. */
export interface TimerEntry {
  /** `setTimeout` / `setInterval` call sites in the file. */
  readonly sites: number
  /** The repo that owns the file after the split. Matches its migration-manifest row. */
  readonly owner: "core" | "cli"
  /** What the timers are for. */
  readonly reason: string
}

/** Repo-relative roots that hold core source. */
export const TIMER_SCAN_ROOTS: readonly string[] = ["src", "plugin-api/src"]

/** A call to `setTimeout` or `setInterval`. Type uses (`typeof setTimeout`) do not match. */
const TIMER_CALL_RE = /\bset(?:Timeout|Interval)\s*\(/g

/** True for test code, which the inventory does not cover. */
export function isTestCode(repoRel: string): boolean {
  return repoRel.endsWith(".test.ts") || repoRel.startsWith("src/test-utils/")
}

/** Count timer calls in `source`, with comments stripped. */
export function countTimerCalls(source: string): number {
  return stripComments(source).match(TIMER_CALL_RE)?.length ?? 0
}

/**
 * Scan the non-test `.ts` files under `roots` (relative to `repoRoot`) and
 * return repo-relative path to timer call count, for files with at least one.
 */
export function scanTimerCalls(
  repoRoot: string,
  roots: readonly string[] = TIMER_SCAN_ROOTS,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const root of roots) {
    for (const rel of tsFilesUnder(join(repoRoot, root))) {
      const repoRel = `${root}/${rel.split("\\").join("/")}`
      if (isTestCode(repoRel)) continue
      const n = countTimerCalls(readFileSync(join(repoRoot, repoRel), "utf8"))
      if (n > 0) out.set(repoRel, n)
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)))
}

/** The inventory, frozen at the 2026-10-31 scan. Counts only go down. */
export const TIMER_INVENTORY: ReadonlyMap<string, TimerEntry> = new Map<string, TimerEntry>([
  // ---- network and transport ----
  [
    "src/network/http2-transport.ts",
    {
      sites: 4,
      owner: "core",
      reason:
        "HTTP/2 PING keepalive (stays, EM14), cancel-to-destroy escalation, connect timeout, and close timeout.",
    },
  ],
  [
    "src/llm/transport/watchdog.ts",
    { sites: 1, owner: "core", reason: "Stream idle and hard-timeout watchdog tick." },
  ],
  // ---- engine ----
  [
    "src/agent/reflection.ts",
    {
      sites: 2,
      owner: "core",
      reason: "Reflection cooldown countdown and wait. Leaves core in S30 (reflectionGate port).",
    },
  ],
  [
    "src/auth/oauth-login.ts",
    { sites: 1, owner: "core", reason: "Sign-in deadline: aborts the login wait after a timeout." },
  ],
  [
    "src/infra/lockfile.ts",
    { sites: 1, owner: "core", reason: "Default sleep between lock acquisition polls." },
  ],
  [
    "src/plugins/hooks/hook-bus.ts",
    { sites: 1, owner: "core", reason: "Per-handler hook timeout." },
  ],
  [
    "src/plugins/host/factory.ts",
    { sites: 1, owner: "core", reason: "Timeout on a plugin's llm.complete capability call." },
  ],
  [
    "src/plugins/loader.ts",
    { sites: 2, owner: "core", reason: "Prompt-fragment timeout and plugin handler timeout." },
  ],
  [
    "src/plugins/loader/commands.ts",
    { sites: 1, owner: "core", reason: "Slash-command handler timeout." },
  ],
  [
    "src/plugins/loader/helpers.ts",
    { sites: 1, owner: "core", reason: "SIGTERM-to-SIGKILL grace for a subprocess handler." },
  ],
  ["src/plugins/loader/setups.ts", { sites: 1, owner: "core", reason: "Plugin setup() timeout." }],
  [
    "src/tools/tools.ts",
    { sites: 2, owner: "core", reason: "Bash tool command timeout and SIGTERM-to-SIGKILL grace." },
  ],
  [
    "plugin-api/src/utils/file-lock.ts",
    { sites: 1, owner: "core", reason: "Abortable sleep between file-lock retries." },
  ],
  [
    "plugin-api/src/utils/retry.ts",
    { sites: 1, owner: "core", reason: "Abortable backoff sleep for retry()." },
  ],
  // ---- terminal host (moves to the CLI in S34) ----
  [
    "src/host/commands/auth-status.ts",
    { sites: 1, owner: "cli", reason: "Timeout for a provider auth-status probe." },
  ],
  [
    "src/host/editor-controller.ts",
    {
      sites: 4,
      owner: "cli",
      reason: "Armed-quit ticker and expiry, input-event debounce, and resize debounce.",
    },
  ],
  [
    "src/host/editor/key-dispatch.ts",
    {
      sites: 1,
      owner: "cli",
      reason:
        "Default setTimeout for paste coalescing / double-Esc / bare-Esc timers (tests inject a fake).",
    },
  ],
  [
    "src/host/ui/formatter/mdstream-code-highlighter.ts",
    { sites: 1, owner: "cli", reason: "Timeout for one code highlight request." },
  ],
  [
    "src/host/ui/startup/progress-spinner.ts",
    { sites: 1, owner: "cli", reason: "Startup spinner frame ticker." },
  ],
  [
    "src/host/ui/startup/tree.ts",
    { sites: 1, owner: "cli", reason: "Startup tree row spinner ticker." },
  ],
  [
    "src/host/ui/status/line-renderer.ts",
    { sites: 1, owner: "cli", reason: "Status line spinner frame timer." },
  ],
  [
    "src/host/ui/status/live-area-controller.ts",
    { sites: 1, owner: "cli", reason: "Live-area spinner frame timer." },
  ],
  [
    "src/host/ui/status/live-area-scheduler.ts",
    { sites: 1, owner: "cli", reason: "Default paint scheduler timer (tests inject a fake)." },
  ],
  [
    "src/host/ui/term-caps.ts",
    { sites: 1, owner: "cli", reason: "Timeout for the synchronized-output capability probe." },
  ],
  [
    "src/terminal/nerd-glyph-width.ts",
    { sites: 1, owner: "cli", reason: "Timeout for the cursor-position probe of glyph width." },
  ],
  [
    "src/terminal/term-probe.ts",
    { sites: 1, owner: "cli", reason: "Default timeout for a terminal probe reply." },
  ],
])
