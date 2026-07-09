/**
 * Unit tests for {@link ModeProviderAdapter}: the AgentCore-facing mode surface
 * over a {@link ModeManager}. Delegation of activeModeId / promptPrefix /
 * consumePendingAttachment; filterTools is a deliberate pass-through (CLI
 * advertisement filtering is the SDK `toolFilter` port).
 */

import { describe, expect, it } from "bun:test"

import type { ContentBlock } from "../../llm/messages.ts"
import type { ModeManager } from "../../modes/modes.ts"
import type { ToolDefinition } from "../../sdk/ports.ts"

import { ModeProviderAdapter } from "./mode-provider-adapter.ts"

/** A minimal ModeManager stub recording delegation. */
function managerStub(over: Partial<Record<string, unknown>>): ModeManager {
  return over as unknown as ModeManager
}

describe("ModeProviderAdapter", () => {
  it("delegates activeModeId", () => {
    const adapter = new ModeProviderAdapter(managerStub({ activeId: () => "ask" }))
    expect(adapter.activeModeId()).toBe("ask")
  })

  it("delegates promptPrefix with the base arrow", () => {
    let seen: string | undefined
    const adapter = new ModeProviderAdapter(
      managerStub({
        promptPrefix: (arrow: string) => {
          seen = arrow
          return `ASK ${arrow}`
        },
      }),
    )
    expect(adapter.promptPrefix("❯")).toBe("ASK ❯")
    expect(seen).toBe("❯")
  })

  it("filterTools is a pass-through (advertisement uses toolFilter port)", () => {
    const adapter = new ModeProviderAdapter(managerStub({}))
    const tools: ToolDefinition[] = [
      { name: "Bash", description: "b", input_schema: {} },
      { name: "Edit", description: "e", input_schema: {} },
    ]
    expect(adapter.filterTools(tools)).toBe(tools)
  })

  it("delegates consumePendingAttachment (mode-change signal)", () => {
    const block: ContentBlock = {
      type: "text",
      text: '<ma::agent::mode-change from="default" to="ask" at="t" />',
    }
    let calls = 0
    const adapter = new ModeProviderAdapter(
      managerStub({
        consumePendingAttachment: () => {
          calls++
          return calls === 1 ? block : null
        },
      }),
    )
    expect(adapter.consumePendingAttachment()).toBe(block)
    // Second call: nothing pending (manager tracks last-advertised itself).
    expect(adapter.consumePendingAttachment()).toBeNull()
  })
})
