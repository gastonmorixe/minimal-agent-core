/**
 * Design step 12c: core marks each harness text block that it inserts with
 * the block metadata `sideband: { kind }`. Each path gives a marked block,
 * also with no codec (the text has no tag then, but it is harness text). The
 * mark is metadata only: the request body bytes are equal with and without
 * it. Restore marks old history only when the codec reads a block as whole
 * tags of one known kind.
 */

import { describe, expect, it } from "bun:test"

import { stringifyWireBlock } from "../../plugin-api/src/llm/canonical-messages.ts"
import type { SyntheticKind } from "../../plugin-api/src/types/synthetic-text.ts"
import { buildLocalCompactMessages, buildTailCompactMessages } from "../agent/context-compact.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { checkToolDidBatch } from "../agent/tool-batch-gate.ts"
import { messageToCanonical } from "../llm/codec/message-codec.ts"
import type { ContentBlock, Message, TextBlock } from "../llm/messages.ts"
import { ModeManager } from "../modes/modes.ts"
import { loadSessionFromText, markRestoredSidebandBlocks } from "../session/session-restore.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"

import {
  buildInitialUserContent,
  markAttachmentBlock,
  nextRoundContent,
} from "./agent-core-helpers.ts"
import { planContinuation } from "./continuation.ts"
import { HOOK_CONTEXT_KIND } from "./hook-context.ts"
import { denyDecision } from "./lifecycle.ts"
import { SessionContextQueue, sessionTakeBlocks } from "./session-context.ts"
import { runTurnStopHook } from "./turn-stop-hook.ts"
import { wrapUpContent } from "./wrap-up.ts"

const SB = fixtureSidebandOrNone()
const codecTest = it.skipIf(!sidebandFixturePresent())

/** A resolver that answers a fixed text for each kind (no codec: no tag). */
const RESOLVER: SyntheticTextResolver = {
  resolve: (kind: SyntheticKind) => `text of ${kind}`,
}

const mark = (b: ContentBlock | undefined): string | undefined =>
  b?.type === "text" ? b.sideband?.kind : undefined

/** The block content of a message (a string content gives no block). */
const contentOf = (m: Message | undefined): ContentBlock[] =>
  Array.isArray(m?.content) ? m.content : []

const texts = (blocks: readonly ContentBlock[]): TextBlock[] =>
  blocks.filter((b): b is TextBlock => b.type === "text")

describe("hook context blocks have the policy mark", () => {
  for (const [name, sb] of [
    ["codec", SB],
    ["no codec", NO_SIDEBAND],
  ] as const) {
    it(`session context and turn context (${name})`, async () => {
      const q = new SessionContextQueue()
      q.add(["session note", { text: "early note", position: "before" }])
      const session = q.take(sb)
      for (const b of sessionTakeBlocks(session)) expect(mark(b)).toBe(HOOK_CONTEXT_KIND)
      const content = await buildInitialUserContent(
        { promptContributors: [], sideband: sb },
        {
          userText: "typed prompt",
          orphanRepair: [],
          turnMarker: null,
          session,
          turnContext: ["turn note", { text: "turn early", position: "before" }],
        },
      )
      const all = texts(content)
      expect(all.map((b) => b.text === "typed prompt")).toEqual([false, false, true, false, false])
      for (const b of all) {
        expect(mark(b)).toBe(b.text === "typed prompt" ? undefined : HOOK_CONTEXT_KIND)
      }
    })

    it(`tool.didBatch context and the turn-stop note (${name})`, async () => {
      const gate = await checkToolDidBatch(
        {
          afterToolBatch: async (p) => ({
            action: "allow",
            payload: p,
            additionalContext: ["first", "second"],
          }),
        },
        { toolBlocks: [], toolResults: [], round: 1 },
        sb,
      )
      expect(gate.halted).toBe(false)
      if (gate.halted) return
      // One block, two policy lines: the mark is the kind of the first tag.
      expect(gate.context.map(mark)).toEqual([HOOK_CONTEXT_KIND])
      const step = await runTurnStopHook(
        async (p) => denyDecision("keep going", p),
        { blocks: [], text: "", stopReason: "end_turn" } as never,
        0,
        8,
        {},
        undefined,
        RESOLVER,
        sb,
      )
      expect(step.kind).toBe("continue")
      if (step.kind === "continue") expect(step.content.map(mark)).toEqual([HOOK_CONTEXT_KIND])
    })

    it(`wrap-up note (${name})`, () => {
      const out = wrapUpContent(sb, { kind: "wrap_up", text: "finish now" })
      expect(out.map(mark)).toEqual(["wrap-up"])
    })

    it(`compaction checkpoints (${name})`, () => {
      const prev: Message[] = [{ role: "user", content: "a" }]
      expect(mark(buildTailCompactMessages(sb, prev, 1, RESOLVER)[0]?.content[0] as never)).toBe(
        "compaction",
      )
      const local = buildLocalCompactMessages(sb, { previous: prev, text: RESOLVER })
      expect(mark(local[0]?.content[0] as never)).toBe("compaction")
    })
  }
})

describe("marker blocks have the kind of their tag", () => {
  it("turn-aborted and session-resumed markers", async () => {
    for (const [turnMarker, kind] of [
      ["aborted", "turn-aborted"],
      ["resumed", "session-resumed"],
    ] as const) {
      const out = await buildInitialUserContent(
        { promptContributors: [], text: RESOLVER },
        { userText: "", orphanRepair: [], turnMarker },
      )
      expect(out.map(mark)).toEqual([kind])
    }
  })

  it("the salvage attachment and the continue nudges", async () => {
    const out = await nextRoundContent({ promptContributors: [], text: RESOLVER }, [], true, {})
    expect(out.content.map(mark)).toEqual(["stream-interrupted"])
    const max = planContinuation(RESOLVER, true, true)
    expect(max.kind).toBe("continue")
    if (max.kind !== "continue") return
    expect(max.nudge.map(mark)).toEqual(["max-tokens-continue"])
    // The assistant placeholder is not harness tag text: no mark.
    expect(max.placeholder?.map(mark)).toEqual([undefined])
    const cut = planContinuation(RESOLVER, false, false)
    if (cut.kind === "continue") expect(cut.nudge.map(mark)).toEqual(["stream-interrupted"])
  })

  it("the mode-change attachment", () => {
    const m = new ModeManager([{ id: "ask", label: "ASK" }], null)
    m.bindSyntheticText(RESOLVER)
    m.setMode("ask")
    expect(mark(m.consumePendingAttachment() ?? undefined)).toBe("mode-change")
  })
})

describe.skipIf(!sidebandFixturePresent())("turn attachments get the kind of their tag", () => {
  const tasks = SB.render("tasks", { attrs: { total: 1 }, body: "1 x" })

  it("a producer block and a save echo are marked; typed text is not", async () => {
    const echo = SB.render("memory-saved", { attrs: { scope: "project", id: "a" }, body: "b" })
    const out = await buildInitialUserContent(
      {
        promptContributors: [
          {
            turnAttachments: () => [{ type: "text", text: tasks }],
            saveEchoes: () => [{ type: "text", text: echo }],
          },
        ],
        sideband: SB,
      },
      { userText: "typed", orphanRepair: [], turnMarker: null },
    )
    expect(out.map(mark)).toEqual(["tasks", "memory-saved", undefined])
    // The bytes do not change.
    expect(texts(out).map((b) => b.text)).toEqual([tasks, echo, "typed"])
  })

  it("no codec: no mark; a block with a mark keeps it", () => {
    expect(mark(markAttachmentBlock({ type: "text", text: tasks }, NO_SIDEBAND))).toBeUndefined()
    const own: ContentBlock = { type: "text", text: "x", sideband: { kind: "own" } }
    expect(markAttachmentBlock(own, SB)).toBe(own)
    expect(mark(markAttachmentBlock({ type: "text", text: "plain" }, SB))).toBeUndefined()
  })
})

describe("the mark never reaches the wire", () => {
  const unmarked = (blocks: readonly ContentBlock[]): ContentBlock[] =>
    blocks.map((b) => {
      if (b.type !== "text") return b
      const { sideband: _mark, ...rest } = b
      return rest
    })

  /**
   * The JSON wire text of a user message: each canonical block through
   * `wireBlock`, the copy that each JSON encoder sends (the encoders that
   * use it are pinned in plugin-api `sideband-block.test.ts`).
   */
  const wire = (content: ContentBlock[]): string =>
    `[${messageToCanonical({ role: "user", content }).content.map(stringifyWireBlock).join(",")}]`

  it("the request body bytes are equal with and without the marks", async () => {
    const q = new SessionContextQueue()
    q.add(["session note"])
    const content = await buildInitialUserContent(
      { promptContributors: [], sideband: SB, text: RESOLVER },
      {
        userText: "typed",
        orphanRepair: [],
        turnMarker: "aborted",
        session: q.take(SB),
        turnContext: ["turn note"],
      },
    )
    content.push(...wrapUpContent(SB, { kind: "wrap_up", text: "end" }))
    expect(content.filter((b) => mark(b) !== undefined).length).toBe(4)
    // The canonical blocks keep the mark (metadata for a provider plugin).
    const canon = messageToCanonical({ role: "user", content }).content
    expect(canon.filter((b) => b.type === "text" && b.sideband !== undefined).length).toBe(4)
    const marked = wire(content)
    expect(marked).not.toContain('"sideband"')
    expect(marked).toBe(wire(unmarked(content)))
  })
})

describe("restore: old history gets a mark only for whole known tags", () => {
  const user = (...t: string[]): Message => ({
    role: "user",
    content: t.map((text): ContentBlock => ({ type: "text", text })),
  })

  codecTest("whole tags of one known kind: mark; prose, mixed or typed text: no mark", () => {
    const policy = `${SB.render("policy", { body: "a" })}\n${SB.render("policy", { body: "b" })}`
    const tasks = SB.render("tasks", { attrs: { total: 1 }, body: "1 x" })
    const marker = `${SB.render("turn-aborted", {})}\nprose after the tag`
    const mixed = `${SB.render("policy", { body: "a" })} typed`
    const msgs = [user(policy, tasks, marker, mixed, "typed")]
    expect(markRestoredSidebandBlocks(msgs, SB)).toBe(2)
    expect(contentOf(msgs[0]).map(mark)).toEqual([
      "policy",
      "tasks",
      undefined,
      undefined,
      undefined,
    ])
    // The bytes do not change.
    expect(texts(contentOf(msgs[0])).map((b) => b.text)).toEqual([
      policy,
      tasks,
      marker,
      mixed,
      "typed",
    ])
  })

  codecTest("no codec: no mark", () => {
    const msgs = [user(SB.render("policy", { body: "a" }))]
    expect(markRestoredSidebandBlocks(msgs, NO_SIDEBAND)).toBe(0)
    expect(mark(contentOf(msgs[0])[0])).toBeUndefined()
  })

  codecTest("loadSessionFromText marks the model history, not the display history", () => {
    const policy = SB.render("policy", { body: "a" })
    const rec = (role: "user" | "assistant", content: ContentBlock[], i: number) =>
      JSON.stringify(
        role === "user"
          ? { kind: "user", ts: `2026-01-01T00:00:0${i}.000Z`, id: `u${i}`, content }
          : {
              kind: "assistant",
              ts: `2026-01-01T00:00:0${i}.000Z`,
              content,
              stopReason: "end_turn",
            },
      )
    const text = [
      rec(
        "user",
        [
          { type: "text", text: policy },
          { type: "text", text: "hi" },
        ],
        1,
      ),
      rec("assistant", [{ type: "text", text: "yo" }], 2),
    ].join("\n")
    const loaded = loadSessionFromText(text, { sideband: SB })
    expect(contentOf(loaded.messages[0]).map(mark)).toEqual(["policy", undefined])
    expect(contentOf(loaded.displayMessages[0]).map(mark)).toEqual([undefined, undefined])
  })
})
