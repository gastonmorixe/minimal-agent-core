/**
 * Architecture fitness function: no direct process writes in the engine
 * (spec S25).
 *
 * THE RULE: engine code reports through the diagnostic bus. It never calls
 * `console.*`, `process.stdout.write`, `process.stderr.write`, or
 * `Bun.stdout` / `Bun.stderr`. Scope and terms are in `direct-write-scan.ts`.
 *
 * The rule has no allow list. The last two CLI-bound writers
 * (`logging/log-stderr.ts`, `infra/safe-stdout.ts`) moved to
 * minimal-agent-cli in S34.
 *
 * Fixing a failure: report through `diag` from `src/bus/diagnostic-bus.ts`
 * (Debug severity for debug traces), or take an injected writer from the
 * host.
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { directWriteScope, directWritesIn, scanDirectWrites } from "./direct-write-scan.ts"
import { scanSdkSource } from "./sdk-port-boundaries-scan.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..")

/**
 * The engine files that wrote directly before S25 (the corrected U17 list,
 * less the deleted legacy `agent.ts` and `cache/cache.ts`, decision 14). The
 * scope must keep covering them.
 */
const CONVERTED_FILES = [
  "src/auth/oauth-login.ts",
  "src/config/config.ts",
  "src/llm/preflight.ts",
  "src/llm/transport/debug.ts",
  "src/logging/net-dbg.ts",
  "src/modes/modes.ts",
  "src/network/client.ts",
  "src/session/session-restore.ts",
]

describe("directWritesIn (scanner)", () => {
  it("finds console output, stream writes, and Bun streams", () => {
    const source = [
      'console.log("x")',
      'console.error("x")',
      'console?.["warn"]("x")',
      'process.stdout.write("x")',
      'process.stderr.write("x")',
      'globalThis.process.stderr.write("x")',
      'Bun.write(Bun.stdout, "x")',
      'Bun.stderr.write("x")',
    ].join("\n")
    expect(directWritesIn(scanSdkSource(source, "unit.ts")).map((w) => w.token)).toEqual([
      "console.log",
      "console.error",
      "console.warn",
      "process.stdout.write",
      "process.stderr.write",
      "process.stderr.write",
      "Bun.stdout",
      "Bun.stderr",
    ])
  })

  it("ignores comments, strings, width reads, stream hand-off, and shadowed names", () => {
    const source = [
      '// console.log("x")',
      '/* process.stderr.write("x") */',
      'const text = "console.error process.stdout.write"',
      "const width = process.stdout.columns",
      "const tty = process.stderr.isTTY",
      "const ctx = { stderr: process.stderr }",
      'function f(console: { log(s: string): void }) { console.log("local") }',
      'diag.warn("cache.anomaly", "console.log in a message is fine")',
    ].join("\n")
    expect(directWritesIn(scanSdkSource(source, "unit.ts"))).toEqual([])
  })
})

describe("no direct writes in the engine (repo ratchet)", () => {
  const scope = directWriteScope(REPO_ROOT)
  const writes = scanDirectWrites(REPO_ROOT, scope)

  it("scopes every engine file, including the files S25 converted", () => {
    for (const file of CONVERTED_FILES) expect(scope).toContain(file)
    expect(scope).toContain("src/sdk/agent-core.ts")
    expect(scope).toContain("plugin-api/src/index.ts")
    // The host adapters left the CLI folders in S34 Phase 4 B. They are engine code.
    expect(scope).toContain("src/adapters/build-agent-core.ts")
    // Dev tooling and test helpers are not engine code.
    expect(scope).not.toContain("src/architecture/direct-write-scan.ts")
    expect(scope).not.toContain("src/test-utils/sibling-repo.ts")
  })

  it("no engine file writes directly", () => {
    const offenders = writes.map((w) => `  ${w.file}:${w.line} ${w.token}`)
    expect(
      offenders,
      offenders.length > 0
        ? "Direct writes in engine code. Report through diag (src/bus/diagnostic-bus.ts)\n" +
            "or take an injected writer:\n" +
            offenders.join("\n")
        : "",
    ).toEqual([])
  })
})
