import { describe, expect, it } from "bun:test"

import {
  isRuntimeAttachmentBlock,
  isRuntimeAttachmentText,
  RUNTIME_ATTACHMENT_OPENERS,
} from "./runtime-attachments.ts"

describe("RUNTIME_ATTACHMENT_OPENERS", () => {
  it("covers every canonical <ma::agent::*> attachment", () => {
    expect(RUNTIME_ATTACHMENT_OPENERS.length).toBeGreaterThanOrEqual(6)
    const matches = (text: string) => RUNTIME_ATTACHMENT_OPENERS.some((re) => re.test(text))

    // Canonical ma::agent::* forms.
    expect(matches('<ma::agent::tasks total="1">')).toBe(true)
    expect(matches("<ma::agent::short-term-memory>")).toBe(true)
    expect(matches('<ma::agent::memory-saved scope="p">')).toBe(true)
    expect(matches("<ma::agent::subagents>")).toBe(true)
    expect(matches('<ma::agent::mode-change from="a" to="b" />')).toBe(true)
    expect(matches('<ma::agent::mode-active id="ask" />')).toBe(true)
    expect(matches('<ma::agent::reflection-checkpoint round="50" />')).toBe(true)
    expect(matches('<ma::agent::emergency-cap-triggered round="N" />')).toBe(true)
    expect(matches("<ma::agent::turn-aborted />")).toBe(true)
    expect(matches("<ma::agent::session-resumed />")).toBe(true)
    expect(matches("<ma::agent::output-truncated />")).toBe(true)

    // Plugin schema.
    expect(matches('<ma::plugin::diagnostics count="1">')).toBe(true)
    expect(matches("<ma::plugins>")).toBe(true)
  })

  it("covers legacy bare forms for migration-window compat", () => {
    const matches = (text: string) => RUNTIME_ATTACHMENT_OPENERS.some((re) => re.test(text))

    expect(matches('<mode-change from="a" to="b" />')).toBe(true)
    expect(matches('<ma::mode-active id="plan" />')).toBe(true)
    expect(matches("<short-term-memory>")).toBe(true)
    expect(matches('<memory-saved scope="g">')).toBe(true)
    expect(matches('<ma::reflection-ack silence-for="1" />')).toBe(true)
    expect(matches('<ma::tui-preview shown="10" total="20">')).toBe(true)
  })

  it("is case-insensitive on the XML prefix", () => {
    expect(isRuntimeAttachmentText('<MA::AGENT::TASKS total="1">')).toBe(true)
    expect(isRuntimeAttachmentText('<Ma::Agent::Mode-Change from="a" to="b" />')).toBe(true)
  })

  it("matches leading whitespace", () => {
    expect(isRuntimeAttachmentText("  <ma::agent::tasks>")).toBe(true)
    expect(isRuntimeAttachmentText("\t<ma::agent::tasks>")).toBe(true)
  })

  it("does NOT match plain user text", () => {
    expect(isRuntimeAttachmentText("hello world")).toBe(false)
    expect(isRuntimeAttachmentText("real user question here")).toBe(false)
    expect(isRuntimeAttachmentText("  trimmed but not an attachment")).toBe(false)
    expect(isRuntimeAttachmentText("")).toBe(false)
    expect(isRuntimeAttachmentText("<unknown::tag>")).toBe(false)
    expect(isRuntimeAttachmentText("ma::agent::tasks without the angle bracket")).toBe(false)
  })
})

describe("isRuntimeAttachmentBlock", () => {
  it("returns false for non-text blocks", () => {
    expect(isRuntimeAttachmentBlock({ type: "thinking", thinking: "x", signature: "s" })).toBe(
      false,
    )
    expect(
      isRuntimeAttachmentBlock({
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: {},
      }),
    ).toBe(false)
    expect(
      isRuntimeAttachmentBlock({
        type: "tool_result",
        tool_use_id: "t1",
        content: "ok",
        is_error: false,
      }),
    ).toBe(false)
  })

  it("returns true for a text block matching the opener", () => {
    expect(isRuntimeAttachmentBlock({ type: "text", text: '<ma::agent::tasks total="1">' })).toBe(
      true,
    )
  })

  it("returns false for a text block with user content", () => {
    expect(isRuntimeAttachmentBlock({ type: "text", text: "hello" })).toBe(false)
  })
})
