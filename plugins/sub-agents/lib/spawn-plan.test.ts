import { describe, expect, it } from "bun:test"

import { renderResultProtocol } from "./prompts.ts"
import {
  buildSpawnPlan,
  composePrompt,
  ENV_DEPTH,
  ENV_DISABLE_PLUGINS,
  ENV_ID,
  ENV_LEAD,
  mergeDisabledPlugins,
  type SpawnInput,
  SUBAGENT_DISABLED_PLUGINS,
} from "./spawn-plan.ts"
import { sessionId, subagentId } from "./types.ts"

function input(overrides: Partial<SpawnInput> = {}): SpawnInput {
  return {
    agentBin: ["minimal-agent"],
    childSid: sessionId("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"),
    leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
    id: subagentId("A2"),
    task: "refactor parser",
    model: "claude-sonnet-4-6",
    mode: "none",
    isolation: "fresh",
    depth: 1,
    cwd: "/repo",
    ...overrides,
  }
}

describe("composePrompt", () => {
  it("returns the bare task when no preamble", () => {
    expect(composePrompt("do X")).toBe("do X")
  })
  it("frames the preamble above the task", () => {
    const out = composePrompt("do X", "You are Explorer.")
    expect(out.startsWith("You are Explorer.")).toBe(true)
    expect(out).toContain("Your task:")
    expect(out.endsWith("do X")).toBe(true)
  })

  it("appends the pre-rendered deliverable protocol AFTER the task", () => {
    const protocol = "## How you finish\nCall ReportResult."
    const out = composePrompt("do X", "You are Explorer.", protocol)
    expect(out).toContain("How you finish")
    expect(out).toContain("ReportResult")
    // task still present, protocol comes AFTER it
    expect(out.indexOf("do X")).toBeLessThan(out.indexOf("How you finish"))
  })

  it("appends the protocol with no preamble too", () => {
    const out = composePrompt("do X", undefined, "PROTOCOL-TEXT")
    expect(out.startsWith("do X")).toBe(true)
    expect(out).toContain("PROTOCOL-TEXT")
  })

  it("omits the protocol entirely when none is given", () => {
    expect(composePrompt("do X", "You are Explorer.")).not.toContain("How you finish")
    expect(composePrompt("do X", "You are Explorer.")).toBe(
      composePrompt("do X", "You are Explorer.", undefined),
    )
  })
})

describe("mergeDisabledPlugins (worker plugin-disable union)", () => {
  it("always disables the worker-only set (intercom) even with no inherited value", () => {
    const out = mergeDisabledPlugins(undefined)
    for (const id of SUBAGENT_DISABLED_PLUGINS) expect(out.split(",")).toContain(id)
    expect(out).toContain("intercom")
  })

  it("unions the inherited list with the worker-only set, inherited first", () => {
    const out = mergeDisabledPlugins("memory,web-search")
    expect(out).toBe("memory,web-search,intercom")
  })

  it("dedups when the inherited list already names a worker-only plugin", () => {
    const out = mergeDisabledPlugins("intercom,memory")
    expect(out).toBe("intercom,memory")
    expect(out.match(/intercom/g)?.length).toBe(1)
  })

  it("ignores blank/whitespace entries in the inherited list", () => {
    expect(mergeDisabledPlugins(" , memory , ")).toBe("memory,intercom")
  })
})

describe("buildSpawnPlan disables intercom for every worker", () => {
  it("stamps MINIMAL_AGENT_DISABLE_PLUGINS with intercom by default", () => {
    const r = buildSpawnPlan(input())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.env[ENV_DISABLE_PLUGINS]).toBe("intercom")
  })

  it("unions the lead's inherited disables with intercom", () => {
    const r = buildSpawnPlan(input({ inheritedDisabledPlugins: "memory,web-search" }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.env[ENV_DISABLE_PLUGINS]).toBe("memory,web-search,intercom")
  })

  it("cannot be clobbered by an extraEnv entry for the same key", () => {
    const r = buildSpawnPlan(input({ extraEnv: { [ENV_DISABLE_PLUGINS]: "nothing" } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.env[ENV_DISABLE_PLUGINS]).toContain("intercom")
  })
})

describe("renderResultProtocol (the markdown template)", () => {
  it("teaches: leaf worker, no delegation, write the file, then call ReportResult; with the fallback path", () => {
    const out = renderResultProtocol("/sessions/abc.result.json")
    expect(out).toMatch(/leaf worker/i)
    expect(out).toMatch(/cannot delegate/i)
    expect(out).toMatch(/SpawnAgent/)
    expect(out).toMatch(/ReportResult/)
    expect(out).toMatch(/write it yourself/i)
    // the manual-sentinel fallback carries the exact path
    expect(out).toContain("/sessions/abc.result.json")
    expect(out).toContain('"short"')
  })
})

describe("buildSpawnPlan — fresh", () => {
  it("produces a pinned-sid, no-header, writable-mode argv", () => {
    const r = buildSpawnPlan(input({ effort: "high" }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { argv, env } = r.value
    expect(argv[0]).toBe("minimal-agent")
    expect(argv).toContain("--session-id")
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978")
    expect(argv).toContain("--no-header")
    expect(argv[argv.indexOf("--mode") + 1]).toBe("none")
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-4-6")
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high")
    // --prompt is last so the text can't be read as a flag value.
    expect(argv[argv.length - 2]).toBe("--prompt")
    expect(argv[argv.length - 1]).toBe("refactor parser")
    expect(argv).not.toContain("--resume") // fresh: no resume
    expect(env[ENV_DEPTH]).toBe("1")
    expect(env[ENV_LEAD]).toBe("11111111-1111-4111-8111-111111111111")
    expect(env[ENV_ID]).toBe("A2")
  })

  it("omits --effort when not given", () => {
    const r = buildSpawnPlan(input())
    expect(r.ok && r.value.argv.includes("--effort")).toBe(false)
  })

  it("OMITS --model when model is empty (model-agnostic; child self-resolves)", () => {
    const r = buildSpawnPlan(input({ model: "" }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.argv).not.toContain("--model")
    // the rest of the argv is still well-formed
    expect(r.value.argv).toContain("--session-id")
    expect(r.value.argv[r.value.argv.length - 2]).toBe("--prompt")
  })

  it("passes --provider alongside --model when provider is known", () => {
    const r = buildSpawnPlan(input({ model: "deepseek-v4-pro", provider: "opencode" }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { argv } = r.value
    expect(argv[argv.indexOf("--model") + 1]).toBe("deepseek-v4-pro")
    expect(argv[argv.indexOf("--provider") + 1]).toBe("opencode")
  })

  it("omits --provider when model is set but provider is empty", () => {
    const r = buildSpawnPlan(input({ model: "claude-sonnet-4-6", provider: "" }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.argv).toContain("--model")
    expect(r.value.argv).not.toContain("--provider")
  })

  it("honors a custom agentBin (injected, never hardcoded)", () => {
    const r = buildSpawnPlan(input({ agentBin: ["bun", "run", "/x/src/index.ts"] }))
    expect(r.ok && r.value.argv.slice(0, 3)).toEqual(["bun", "run", "/x/src/index.ts"])
  })

  it("threads the rendered protocol into the composed --prompt", () => {
    const r = buildSpawnPlan(
      input({ resultProtocol: renderResultProtocol("/sessions/9c.result.json") }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const prompt = r.value.argv[r.value.argv.length - 1]
    expect(prompt).toContain("/sessions/9c.result.json")
    expect(prompt).toMatch(/ReportResult/)
  })
})

describe("buildSpawnPlan — fork", () => {
  it("resumes the lead session so its history forks into the child sid", () => {
    const r = buildSpawnPlan(input({ isolation: "fork" }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { argv } = r.value
    // --resume <leadSid> ... --session-id <childSid>: the agent's resume path
    // forks srcSid (lead) → dstSid (getSessionId() == pinned child sid).
    expect(argv[argv.indexOf("--resume") + 1]).toBe("11111111-1111-4111-8111-111111111111")
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978")
    expect(argv.indexOf("--resume")).toBeLessThan(argv.indexOf("--session-id"))
  })
})

describe("buildSpawnPlan — validation (Result, not throw)", () => {
  it("rejects empty agentBin / task / bad depth (empty model is VALID, see model-agnostic test)", () => {
    expect(buildSpawnPlan(input({ agentBin: [] })).ok).toBe(false)
    expect(buildSpawnPlan(input({ task: "   " })).ok).toBe(false)
    expect(buildSpawnPlan(input({ depth: 0 })).ok).toBe(false)
    const bad = buildSpawnPlan(input({ depth: 0 }))
    expect(bad.ok ? "" : bad.error).toMatch(/depth/)
  })
})
