/**
 * Architecture ratchet: the runtime import closure of `src/sdk/agent-core.ts`
 * reaches `src/session/` only through the listed edges. A new path (for
 * example an `src/agent/` shim that reads the session id) fails this test.
 *
 * @module architecture/sdk-transitive.test
 */

import { describe, expect, it } from "bun:test"

import { forbiddenTransitiveEdges } from "./sdk-transitive-scan.ts"

describe("SDK transitive closure", () => {
  it("agent-core.ts reaches src/session only through the known edges", () => {
    // Exact inventory. Both edges come from outside the hook seams work:
    // the net-dbg logger and the canonical transport. Hook payload facts
    // come from `AgentCoreConfig.sessionFacts` (the host), not from here.
    expect(forbiddenTransitiveEdges("src/sdk/agent-core.ts", "src/session")).toEqual([
      "src/session/session-id-safety.ts <- src/logging/net-dbg.ts",
      "src/session/session-id.ts <- src/logging/net-dbg.ts",
      "src/session/session-tokens.ts <- src/llm/transport/canonical-send.ts",
    ])
  })

  it("no src/agent/ module carries a session import into agent-core.ts", () => {
    const viaAgent = forbiddenTransitiveEdges("src/sdk/agent-core.ts", "src/session").filter((e) =>
      e.includes("<- src/agent/"),
    )
    expect(viaAgent).toEqual([])
  })
})
