import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { ToolUseBlock } from "../llm/messages.ts"
import { Hooks } from "../plugins/hooks/hooks.ts"
import {
  allowDecision,
  chainResultToDecision,
  denyDecision,
  type LifecyclePort,
  NOOP_LIFECYCLE,
} from "../sdk/lifecycle.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

function baseCtx(overrides: Partial<ToolRoundContext> = {}): ToolRoundContext {
  return {
    presentation: new Map(),
    writeTranscript: () => {},
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    toolTimeTracker: null,
    model: "test-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    ...overrides,
  }
}

describe("executeToolRound — tool.willInvoke", () => {
  test("deny prevents Write IO", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-"))
    const path = join(dir, "secret.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool() {
        return denyDecision("no writes in this test")
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_deny",
      name: "Write",
      input: { file_path: path, content: "should-not-land\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain("no writes")
    expect(existsSync(path)).toBe(false)
  })

  test("rewrite changes Write path (updatedInput)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-rw-"))
    const original = join(dir, "orig.txt")
    const rewritten = join(dir, "safe.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision({
          ...p,
          input: { ...p.input, file_path: rewritten, content: "rewritten\n" },
        })
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_rw",
      name: "Write",
      input: { file_path: original, content: "orig\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(result.is_error).toBeFalsy()
    expect(existsSync(original)).toBe(false)
    expect(readFileSync(rewritten, "utf8")).toBe("rewritten\n")
  })

  test("a rewrite that fails validation is denied and still names the rewritten keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-invalid-"))
    const original = join(dir, "orig.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        const { content: _dropped, ...rest } = p.input
        return allowDecision({ ...p, input: rest })
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_invalid",
      name: "Write",
      input: { file_path: original, content: "orig\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain("Write requires `content`")
    // The note survives the deny, so the model sees that policy removed
    // the key. Key names only, never values.
    expect(String(result.content)).toContain("input rewritten by policy: content")
    expect(String(result.content)).not.toContain("orig\n")
    expect(existsSync(original)).toBe(false)
  })

  test("rewrite runs on a copy: history tool_use.input is unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-copy-"))
    const original = join(dir, "orig.txt")
    const rewritten = join(dir, "vault-swapped.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision({ ...p, input: { ...p.input, file_path: rewritten } })
      },
    }
    const historyInput = { file_path: original, content: "fake-data\n" }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_copy",
      name: "Write",
      input: historyInput,
    }
    const bytesBefore = JSON.stringify(tool.input)
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(result.is_error).toBeFalsy()
    expect(existsSync(original)).toBe(false)
    expect(readFileSync(rewritten, "utf8")).toBe("fake-data\n")
    expect(tool.input).toBe(historyInput)
    expect(JSON.stringify(tool.input)).toBe(bytesBefore)
  })

  test("rewrite adds a policy note with key names only, never values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-note-"))
    const original = join(dir, "orig.txt")
    const rewritten = join(dir, "FAKE-SECRET-PATH.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision({
          ...p,
          input: { ...p.input, file_path: rewritten, content: "FAKE-SECRET-VALUE\n" },
        })
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_note",
      name: "Write",
      input: { file_path: original, content: "placeholder\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    const text = String(result.content)
    const notes = text.split("\n").filter((l) => l.includes("input rewritten by policy"))
    expect(notes).toEqual([
      "<ma::agent::policy>input rewritten by policy: content, file_path</ma::agent::policy>",
    ])
    expect(text).not.toContain("FAKE-SECRET-VALUE")
  })

  test("no policy note when the hook returns the input unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-same-"))
    const path = join(dir, "same.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision({ ...p, input: { ...p.input } })
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_same",
      name: "Write",
      input: { file_path: path, content: "same\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(String(result.content)).not.toContain("input rewritten by policy")
  })

  test("alias normalization runs on a copy: history keeps model form", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-alias-"))
    const path = join(dir, "alias.txt")
    const historyInput = { path, contents: "alias-data\n" }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_alias",
      name: "Write",
      input: historyInput,
    }
    const bytesBefore = JSON.stringify(tool.input)
    const result = await executeToolRound(tool, baseCtx())
    expect(result.is_error).toBeFalsy()
    expect(readFileSync(path, "utf8")).toBe("alias-data\n")
    expect(tool.input).toBe(historyInput)
    expect(JSON.stringify(tool.input)).toBe(bytesBefore)
    expect(Object.keys(tool.input)).toEqual(["path", "contents"])
  })

  test("in-place nested mutation by a hook does not touch history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-deep-"))
    const path = join(dir, "deep.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        ;(p.input.nested as { x: number }).x = 999
        return allowDecision(p)
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_deep",
      name: "Write",
      input: { file_path: path, content: "deep\n", nested: { x: 1 } },
    }
    const historyInput = tool.input
    const bytesBefore = JSON.stringify(tool.input)
    await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(tool.input).toBe(historyInput)
    expect(JSON.stringify(tool.input)).toBe(bytesBefore)
  })

  test("array input mutated in place by a hook does not touch history", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        ;(p.input as unknown as unknown[]).push("FAKE-INJECTED")
        return allowDecision(p)
      },
    }
    const historyInput = ["a", { b: 1 }]
    const tool = {
      type: "tool_use",
      id: "tu_array",
      name: "NoSuchCustomTool",
      input: historyInput,
    } as unknown as ToolUseBlock
    const bytesBefore = JSON.stringify(tool.input)
    await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(tool.input as unknown).toBe(historyInput)
    expect(JSON.stringify(tool.input)).toBe(bytesBefore)
  })

  test("policy note keeps only safe key names and caps the list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-cap-"))
    const path = join(dir, "cap.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        const extra: Record<string, unknown> = { "<x>": 1 }
        for (let i = 0; i < 20; i++) extra[`k${String(i).padStart(2, "0")}`] = i
        return allowDecision({ ...p, input: { ...p.input, ...extra } })
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_cap",
      name: "Write",
      input: { file_path: path, content: "cap\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    const note = String(result.content)
      .split("\n")
      .find((l) => l.includes("input rewritten by policy"))
    expect(note).toBeDefined()
    const inner = String(note)
      .replace("<ma::agent::policy>input rewritten by policy: ", "")
      .replace("</ma::agent::policy>", "")
    expect(inner).not.toContain("<")
    const parts = inner.split(", ")
    expect(parts.at(-1)).toBe("+5 more")
    expect(parts.length - 1).toBeLessThanOrEqual(16)
    for (const name of parts.slice(0, -1)) expect(name).toMatch(/^[A-Za-z0-9_.-]{1,64}$/)
  })

  test("a port that mutates the input in place and then throws runs the pre-hook input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-throw-"))
    const original = join(dir, "orig.txt")
    const hijacked = join(dir, "hijacked.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        p.input.file_path = hijacked
        throw new Error("port failure")
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_throw",
      name: "Write",
      input: { file_path: original, content: "orig\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(result.is_error).toBeFalsy()
    expect(existsSync(hijacked)).toBe(false)
    expect(readFileSync(original, "utf8")).toBe("orig\n")
  })

  test("in-place top-level rewrite gives a policy note and the new path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-inplace-"))
    const original = join(dir, "orig.txt")
    const rewritten = join(dir, "inplace.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        p.input.file_path = rewritten
        return allowDecision(p)
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_inplace",
      name: "Write",
      input: { file_path: original, content: "inplace\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(result.is_error).toBeFalsy()
    expect(existsSync(original)).toBe(false)
    expect(readFileSync(rewritten, "utf8")).toBe("inplace\n")
    expect(String(result.content)).toContain(
      "<ma::agent::policy>input rewritten by policy: file_path</ma::agent::policy>",
    )
  })

  test("nested key order change is not a rewrite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-order-"))
    const path = join(dir, "order.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision({ ...p, input: { ...p.input, opts: { b: 2, a: 1 } } })
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_order",
      name: "Write",
      input: { file_path: path, content: "order\n", opts: { a: 1, b: 2 } },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(String(result.content)).not.toContain("input rewritten by policy")
  })

  test("diff does not throw on BigInt: rewrite still applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-bigint-"))
    const original = join(dir, "orig.txt")
    const rewritten = join(dir, "bigint.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision({ ...p, input: { ...p.input, file_path: rewritten, big: 1n } })
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_bigint",
      name: "Write",
      input: { file_path: original, content: "bigint\n", big: 1n },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(existsSync(original)).toBe(false)
    expect(readFileSync(rewritten, "utf8")).toBe("bigint\n")
    expect(String(result.content)).toContain("input rewritten by policy: file_path<")
  })

  test("diff does not throw on a cycle: rewrite still applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-cycle-"))
    const original = join(dir, "orig.txt")
    const rewritten = join(dir, "cycle.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        const loop: Record<string, unknown> = {}
        loop.self = loop
        return allowDecision({ ...p, input: { ...p.input, file_path: rewritten, loop } })
      },
    }
    // The cycle sits in both the model input and the rewrite, so the
    // diff has to compare two cyclic values.
    const modelLoop: Record<string, unknown> = {}
    modelLoop.self = modelLoop
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_cycle",
      name: "Write",
      input: { file_path: original, content: "cycle\n", loop: modelLoop },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(existsSync(original)).toBe(false)
    expect(readFileSync(rewritten, "utf8")).toBe("cycle\n")
    expect(String(result.content)).toContain("input rewritten by policy: file_path")
  })

  test("removed key and nested change: note lists names only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-rm-"))
    const path = join(dir, "rm.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        const { meta: _meta, ...rest } = p.input
        return allowDecision({ ...p, input: { ...rest, opts: { deep: "FAKE-NESTED-VALUE" } } })
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_rm",
      name: "Write",
      input: {
        file_path: path,
        content: "rm\n",
        meta: "FAKE-REMOVED-VALUE",
        opts: { deep: "old" },
      },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    const text = String(result.content)
    expect(text).toContain(
      "<ma::agent::policy>input rewritten by policy: meta, opts</ma::agent::policy>",
    )
    expect(text).not.toContain("FAKE-NESTED-VALUE")
    expect(text).not.toContain("FAKE-REMOVED-VALUE")
  })

  test("a failClosed hook that returns { payload: null } denies and the tool does not run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-null-"))
    const path = join(dir, "gated.txt")
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("tool.willInvoke", () => ({ payload: null }) as never, {
      caller: "plugin",
      priority: 50,
      source: "acp",
      failClosed: true,
    })
    // The same mapping that the host LifecyclePortAdapter uses.
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      hasFailClosedToolHook: () => hooks.hookBus.failClosedCount("tool.willInvoke") > 0,
      async beforeTool(p) {
        return chainResultToDecision(await hooks.emitChain("tool.willInvoke", p))
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_null",
      name: "Write",
      input: { file_path: path, content: "should-not-land\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(result.is_error).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  test("a throw in the chain path with a failClosed hook on it denies the tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-gate-throw-"))
    const path = join(dir, "gated.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      hasFailClosedToolHook: () => true,
      async beforeTool() {
        throw new Error("port failure")
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_gate_throw",
      name: "Write",
      input: { file_path: path, content: "should-not-land\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain("port failure")
    expect(existsSync(path)).toBe(false)
  })
})
