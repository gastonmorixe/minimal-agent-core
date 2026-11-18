/**
 * Architecture fitness function: no direct stdout/stderr writes anywhere but
 * the few files that render for the user.
 *
 * `no-direct-writes.test.ts` guards the engine source with a TypeScript scan.
 * This test guards the whole repo with the `ma/no-direct-stdio` oxlint rule
 * (`scripts/lint/no-direct-stdio.mjs`), which also sees `console.*`, a stream
 * handed on as a value, `fs.writeSync(1|2)`, `/dev/stdout` and a child process
 * that inherits the terminal.
 *
 * The rule alone is not enough: one config edit switches it off. So this test
 * runs the checker `scripts/lint/verify-no-direct-stdio.mjs`, which fails when
 *
 *  - `.oxlintrc.json` stops registering the plugin or stops setting it to error,
 *  - a canary write is no longer reported with the repo config,
 *  - a file outside `src/architecture/no-direct-stdio.baseline.json` writes,
 *  - a baseline file writes more often than recorded (new debt), or
 *  - a baseline file got clean but stayed in the list (the list only shrinks).
 *
 * Fixing a failure: report through the diagnostic bus (`diag`), or take an
 * injected writer from the host. Do not add a file to the baseline unless it
 * is a final renderer.
 */

import { spawnSync } from "node:child_process"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

const REPO_ROOT = join(import.meta.dirname, "..", "..")
const CHECKER = join(REPO_ROOT, "scripts", "lint", "verify-no-direct-stdio.mjs")

/** Run the checker in a child process and capture its output. */
function runChecker(args: readonly string[]): {
  status: number | null
  stdout: string
  stderr: string
} {
  const run = spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

describe("no direct stdout/stderr writes (oxlint rule + ratchet)", () => {
  it("the repo config enforces the rule and the baseline is exact", () => {
    const run = runChecker(["--repo", REPO_ROOT])
    // The checker prints each problem on stderr; show them if this fails.
    expect(run.stderr).toBe("")
    expect(run.status).toBe(0)
    expect(run.stdout).toContain("no-direct-stdio ok")
  }, 60_000)

  it("the checker really fails on a planted canary (selftest)", () => {
    const run = runChecker(["--selftest"])
    expect(run.stderr).toBe("")
    expect(run.status).toBe(0)
    expect(run.stdout).toContain("selftest ok")
  }, 60_000)
})
