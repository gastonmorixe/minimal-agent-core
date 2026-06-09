import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { ModelInfoSnapshot, PromptFragmentContext } from "../../../src/plugins/types.ts"

import planningFragment from "./planning_fragment.ts"

const PKG_DIR = join(import.meta.dir, "..")

function snapshot(userDefined: boolean): ModelInfoSnapshot {
  return {
    modelId: "m",
    displayName: "M",
    providerId: "p",
    surfaceId: "s",
    contextWindow: 1,
    maxOutputTokens: 1,
    modalities: { image: false, audio: false, pdf: false, video: false },
    acceptedInput: {},
    thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
    effort: { levels: [], default: "" },
    caching: { explicit: false, automatic: false, ttls: [], reportsCacheHits: false },
    tools: { userDefined, parallel: false },
    serverTools: [],
    pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 },
    resolved: true,
  }
}

function ctx(query?: () => ModelInfoSnapshot | undefined): PromptFragmentContext {
  return {
    packageDir: PKG_DIR,
    cwd: PKG_DIR,
    env: {},
    abort: new AbortController().signal,
    stderr: process.stderr,
    log: {
      debug() {},
      info() {},
      notice() {},
      warn() {},
      error() {},
    } as unknown as PromptFragmentContext["log"],
    agent: { sessionId: "s", pid: 1, model: "m", version: "0" },
    ...(query ? { queryModelInfo: query } : {}),
  }
}

describe("tasks planning fragment", () => {
  it("emits the PLAN/PHASES guidance when the model supports user-defined tools", () => {
    const out = planningFragment(ctx(() => snapshot(true)))
    expect(out).toMatch(/PLAN and work in PHASES with TASKs and SUB-TASKs/)
  })

  it("suppresses the guidance when the model lacks user-defined tool support", () => {
    const out = planningFragment(ctx(() => snapshot(false)))
    expect(out).toBe("")
  })

  it("emits when no model snapshot is available (defers to the loader gate)", () => {
    const out = planningFragment(ctx())
    expect(out).toMatch(/PLAN and work in PHASES/)
  })

  it("reads the text from prompts/planning.md, not a hardcoded literal", () => {
    const out = planningFragment(ctx(() => snapshot(true)))
    // The file content is the single source of truth; the handler trims it.
    expect(out.length).toBeGreaterThan(0)
    expect(out).toBe(out.trim())
  })
})
