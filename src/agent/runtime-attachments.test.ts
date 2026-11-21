import { describe, expect, it } from "bun:test"

import { NO_SIDEBAND } from "../sideband/api.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"

import { isRuntimeAttachmentBlock, isRuntimeAttachmentText } from "./runtime-attachments.ts"

// The codec owns the tag forms (design step 8): the real codec of the
// sibling plugins checkout reads them.
const SB = fixtureSidebandOrNone()
const TASKS_OPEN = '<ma::agent::tasks total="1">'
// An old kind that no plugin registers now (old session files).
const EMERGENCY = '<ma::agent::emergency-cap-triggered round="N" />'
const describeSb = describe.skipIf(!sidebandFixturePresent())

describe("no codec (NO_SIDEBAND)", () => {
  it("hides only a marked block", () => {
    expect(isRuntimeAttachmentText(TASKS_OPEN)).toBe(false)
    expect(isRuntimeAttachmentText(TASKS_OPEN, NO_SIDEBAND)).toBe(false)
    expect(isRuntimeAttachmentBlock({ type: "text", text: TASKS_OPEN })).toBe(false)
    expect(isRuntimeAttachmentBlock({ type: "text", text: "x", sideband: { kind: "tasks" } })).toBe(
      true,
    )
  })
})

describeSb("runtime attachment openers (codec)", () => {
  it("covers every canonical <ma::agent::*> attachment", () => {
    const matches = (text: string) => isRuntimeAttachmentText(text, SB)

    // Canonical ma::agent::* forms.
    expect(matches(TASKS_OPEN)).toBe(true)
    expect(matches("<ma::agent::short-term-memory>")).toBe(true)
    expect(matches('<ma::agent::memory-saved scope="p">')).toBe(true)
    expect(matches("<ma::agent::subagents>")).toBe(true)
    expect(matches('<ma::agent::mode-change from="a" to="b" />')).toBe(true)
    expect(matches('<ma::agent::mode-active id="ask" />')).toBe(true)
    expect(matches(EMERGENCY)).toBe(true)
    expect(matches("<ma::agent::turn-aborted />")).toBe(true)
    expect(matches("<ma::agent::session-resumed />")).toBe(true)
    expect(matches("<ma::agent::output-truncated />")).toBe(true)

    // Plugin schema.
    expect(matches('<ma::plugin::diagnostics count="1">')).toBe(true)
    expect(matches("<ma::plugins>")).toBe(true)
  })

  it("covers legacy bare forms for migration-window compat", () => {
    const matches = (text: string) => isRuntimeAttachmentText(text, SB)

    expect(matches('<mode-change from="a" to="b" />')).toBe(true)
    expect(matches('<ma::mode-active id="plan" />')).toBe(true)
    expect(matches("<short-term-memory>")).toBe(true)
    expect(matches('<memory-saved scope="g">')).toBe(true)
    expect(matches('<ma::tui-preview shown="10" total="20">')).toBe(true)
  })

  it("is case-insensitive on the XML prefix", () => {
    expect(isRuntimeAttachmentText('<MA::AGENT::TASKS total="1">', SB)).toBe(true)
    expect(isRuntimeAttachmentText('<Ma::Agent::Mode-Change from="a" to="b" />', SB)).toBe(true)
  })

  it("matches leading whitespace", () => {
    expect(isRuntimeAttachmentText(`  ${TASKS_OPEN}`, SB)).toBe(true)
    expect(isRuntimeAttachmentText(`\t${TASKS_OPEN}`, SB)).toBe(true)
  })

  it("does NOT match plain user text", () => {
    expect(isRuntimeAttachmentText("hello world", SB)).toBe(false)
    expect(isRuntimeAttachmentText("real user question here", SB)).toBe(false)
    expect(isRuntimeAttachmentText("  trimmed but not an attachment", SB)).toBe(false)
    expect(isRuntimeAttachmentText("", SB)).toBe(false)
    expect(isRuntimeAttachmentText("<unknown::tag>", SB)).toBe(false)
    expect(isRuntimeAttachmentText("ma::agent::tasks without the angle bracket", SB)).toBe(false)
  })

  it("does NOT match a user prompt with an unregistered from-model, v2 or other name", () => {
    // Each was hidden on replay and dropped from the pending draft.
    expect(
      isRuntimeAttachmentText("<ma::emit::note>hi</ma::emit::note> please test this", SB),
    ).toBe(false)
    expect(
      isRuntimeAttachmentText('<ma:root xmlns:ma="u">\n<ma:item/></ma:root> parse this', SB),
    ).toBe(false)
    expect(isRuntimeAttachmentText("<MA::Foo> hi", SB)).toBe(false)
    expect(isRuntimeAttachmentText("<MA::Foo>x</MA::Foo> hi", SB)).toBe(false)
    expect(isRuntimeAttachmentText("<MA::EMIT::INLINE-ACK x", SB)).toBe(false)
    expect(isRuntimeAttachmentText("<MA::PLUGIN::FOO::BAR> hello", SB)).toBe(false)
    // A registered from-model kind is not an attachment.
    expect(isRuntimeAttachmentText(SB.render("memory", { body: "x" }), SB)).toBe(false)
  })

  it("an unregistered kind at the level of a harness attachment still counts (old sessions)", () => {
    expect(isRuntimeAttachmentText(EMERGENCY, SB)).toBe(true)
    expect(
      isRuntimeAttachmentText("<MA::AGENT::RETIRED-KIND>x</MA::AGENT::RETIRED-KIND>", SB),
    ).toBe(true)
    // Without `name` and `kinds` (a bare reader slice), only registered kinds count.
    const slice = {
      ...SB,
      name: undefined,
      kinds: undefined,
    }
    expect(isRuntimeAttachmentText(EMERGENCY, slice)).toBe(false)
    expect(isRuntimeAttachmentText(TASKS_OPEN, slice)).toBe(true)
  })
})

describeSb("isRuntimeAttachmentBlock", () => {
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
    expect(isRuntimeAttachmentBlock({ type: "text", text: TASKS_OPEN }, SB)).toBe(true)
  })

  it("returns false for a text block with user content", () => {
    expect(isRuntimeAttachmentBlock({ type: "text", text: "hello" }, SB)).toBe(false)
  })
})
