/**
 * Loop inventory (spec v2 D1, S15): core has exactly one agent loop.
 *
 * An agent loop is a module that sends a model request, runs tool calls, and
 * repeats. This test scans every production TypeScript file in `src/` and
 * `plugin-api/src/` (comments stripped) for all three and allows exactly one
 * such module: `src/sdk/agent-core.ts` (`AgentCore.run`). Hosts vary
 * behavior through optional ports, never through a second loop.
 *
 * The three probes are checked against known modules first, so a renamed
 * seam fails here instead of making the inventory pass vacuously.
 *
 * @module architecture/loop-inventory.test
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { describe, expect, it } from "bun:test"

const ROOT = join(import.meta.dirname, "..", "..")

/** Calls a model transport: the `sendFn` port or a named transport. */
const SENDS =
  /\bsendFn\s*\(|\bselectedTransport\s*\(|\bcanonical(?:Send|Attempt)Fn\s*\(|\bsendMessage\s*\(/
/**
 * Runs tool calls: the `ToolExecutor` port (directly, or through the S19
 * `runToolCalls` step `AgentCore` delegates to) or the tool round.
 */
const RUNS_TOOLS = /\btoolExecutor\.execute\s*\(|\bexecuteToolRound\s*\(|\brunToolCalls\s*\(/
/** Repeats. */
const REPEATS = /\bwhile\s*\(|\bfor\s*\(/

function productionFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "test-utils" || name === "__fixtures__") continue
      out.push(...productionFiles(path))
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(path)
    }
  }
  return out
}

/** Drop block and line comments so doc prose never counts as code. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
}

const files = [
  ...productionFiles(join(ROOT, "src")),
  ...productionFiles(join(ROOT, "plugin-api", "src")),
].map((path) => ({ rel: relative(ROOT, path), text: code(path) }))

const matching = (re: RegExp): string[] => files.filter((f) => re.test(f.text)).map((f) => f.rel)

describe("loop inventory", () => {
  it("probes see the known sending and tool-running modules", () => {
    const senders = matching(SENDS)
    expect(senders).toContain("src/sdk/agent-core.ts")
    expect(senders).toContain("src/plugins/host/factory.ts")
    const toolRunners = matching(RUNS_TOOLS)
    expect(toolRunners).toContain("src/sdk/agent-core.ts")
    expect(toolRunners).toContain("src/host/sdk-adapters/tool-executor-adapter.ts")
  })

  it("allows exactly one module that sends, runs tools, and repeats", () => {
    const loops = files
      .filter((f) => SENDS.test(f.text) && RUNS_TOOLS.test(f.text) && REPEATS.test(f.text))
      .map((f) => f.rel)
    expect(loops).toEqual(["src/sdk/agent-core.ts"])
  })
})
