/**
 * Smoke test: the 8 `./sdk/*` subpaths closed by the S34 exports-gap wave
 * (agent Y1) resolve by package name and carry the symbols their consumers
 * need.
 *
 * Each import below uses the `@minimal-agent/core/sdk/...` specifier, the
 * way an external consumer (minimal-agent-cli, minimal-agent-web) installed
 * from git would, never a relative `src/...` path — same discipline as
 * `src/sdk/consumer-smoke.test.ts`. `messages.ts` and `provider.ts` are
 * pure types with zero runtime exports, so their checks construct a value
 * structurally typed against the imported type instead of calling a
 * function.
 *
 * @module sdk/sdk-subpath-exports.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import type { ContentBlock, Message } from "@minimal-agent/core/sdk/messages"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { validateAgainstSchema } from "@minimal-agent/core/sdk/output-schema"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { selectOutputMode } from "@minimal-agent/core/sdk/print-mode"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import type { PreflightIssue, ValidationResult } from "@minimal-agent/core/sdk/provider"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { applyToolNamePolicy } from "@minimal-agent/core/sdk/tool-filter"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { makeToolDidInvokePayload } from "@minimal-agent/core/sdk/tool-lifecycle"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import {
  has1mContext,
  type ModelInfo,
  normalizeModelForAPI,
} from "@minimal-agent/core/sdk/transport-types"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { formatTurnNoticePlain, type TurnNotice } from "@minimal-agent/core/sdk/turn-notice"

describe("@minimal-agent/core/sdk/* public subpaths (S34 exports-gap, Y1 cluster)", () => {
  it("./sdk/turn-notice: TurnNotice + formatTurnNoticePlain", () => {
    const notice: TurnNotice = { kind: "ask_denied", severity: "warn", code: "x", title: "t" }
    expect(formatTurnNoticePlain(notice)).toContain('"t" (x)')
  })

  it("./sdk/output-schema: validateAgainstSchema", () => {
    expect(validateAgainstSchema(42, { type: "number" })).toEqual({ valid: true, errors: [] })
  })

  it("./sdk/print-mode: selectOutputMode", () => {
    expect(selectOutputMode({ isTTY: true, jsonFlag: true })).toBe("json")
  })

  it("./sdk/tool-filter: applyToolNamePolicy", () => {
    const tools = [{ name: "a" }, { name: "b" }]
    expect(applyToolNamePolicy(tools, { kind: "allow-list", tools: ["b"] })).toEqual([
      { name: "b" },
    ])
  })

  it("./sdk/tool-lifecycle: makeToolDidInvokePayload", () => {
    const payload = makeToolDidInvokePayload({ tool: "Bash", input: {}, cwd: "/", ok: true })
    expect(payload).toEqual({
      tool: "Bash",
      input: {},
      cwd: "/",
      ok: true,
      findings: [],
      notes: [],
    })
  })

  it("./sdk/messages: Message + ContentBlock types", () => {
    const block: ContentBlock = { type: "text", text: "hi" }
    const message: Message = { role: "user", content: [block] }
    expect(message.role).toBe("user")
  })

  it("./sdk/provider: ValidationResult + PreflightIssue types", () => {
    const result: ValidationResult = { ok: true, errors: [] }
    const issue: PreflightIssue = { code: "c", title: "t", detail: "d", options: [] }
    expect(result.ok).toBe(true)
    expect(issue.code).toBe("c")
  })

  it("./sdk/transport-types: normalizeModelForAPI + has1mContext + ModelInfo type", () => {
    expect(normalizeModelForAPI("model-x[1m]")).toBe("model-x")
    expect(has1mContext("model-x[1m]")).toBe(true)
    const _typeOnly: Pick<ModelInfo, "id"> = { id: "model-x" }
    expect(_typeOnly.id).toBe("model-x")
  })
})
