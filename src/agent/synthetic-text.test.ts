import { describe, expect, it } from "bun:test"

import type {
  SyntheticKind,
  SyntheticTextProvider,
} from "../../plugin-api/src/types/synthetic-text.ts"
import { createDiagnosticBus, type LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { createSyntheticTextResolver, SyntheticTextEmptyError } from "./synthetic-text.ts"

function setup(providers: SyntheticTextProvider[]) {
  const events: LogEvent[] = []
  const bus = createDiagnosticBus()
  bus.on("*", (e) => events.push(e))
  const resolver = createSyntheticTextResolver(providers, createDiagnostics(bus))
  return { resolver, events }
}

function stub(kinds: SyntheticKind[], text: string | (() => string)): SyntheticTextProvider {
  return { kinds, text: () => (typeof text === "function" ? text() : text) }
}

describe("createSyntheticTextResolver", () => {
  it("returns the provider text for its kind", () => {
    const { resolver, events } = setup([stub(["continue.max_tokens"], "P")])
    expect(resolver.resolve("continue.max_tokens", {}, () => "F")).toBe("P")
    expect(events).toHaveLength(0)
  })

  it("calls the fallback once when no provider owns the kind", () => {
    const { resolver } = setup([stub(["continue.max_tokens"], "P")])
    let calls = 0
    const out = resolver.resolve("assistant.placeholder", {}, () => {
      calls++
      return "F"
    })
    expect(out).toBe("F")
    expect(calls).toBe(1)
  })

  it("does not ask a provider for another kind", () => {
    let asked = 0
    const { resolver } = setup([
      stub(["continue.stream_interrupted"], () => {
        asked++
        return "P"
      }),
    ])
    expect(resolver.resolve("continue.max_tokens", {}, () => "F")).toBe("F")
    expect(asked).toBe(0)
  })

  it("falls back and records synthetic.empty_text on an empty answer", () => {
    const { resolver, events } = setup([stub(["continue.max_tokens"], "")])
    expect(resolver.resolve("continue.max_tokens", {}, () => "F")).toBe("F")
    expect(events).toHaveLength(1)
    expect(events[0]?.source).toBe("synthetic.empty_text")
    expect(events[0]?.message).toBe("")
    expect(events[0]?.structuredData).toEqual({ kind: "continue.max_tokens" })
  })

  it("SyntheticTextEmptyError has an empty message and a typed field", () => {
    const e = new SyntheticTextEmptyError("assistant.placeholder")
    expect(e.message).toBe("")
    expect(e.syntheticKind).toBe("assistant.placeholder")
    expect(e.kind).toBe("SyntheticTextEmptyError")
    expect(e.name).toBe("SyntheticTextEmptyError")
    expect(SyntheticTextEmptyError.kind).toBe("SyntheticTextEmptyError")
    expect(e).toBeInstanceOf(Error)
  })

  it("first provider wins on a duplicate owner and records synthetic.duplicate_owner", () => {
    const { resolver, events } = setup([
      stub(["continue.max_tokens"], "A"),
      stub(["continue.max_tokens"], "B"),
    ])
    expect(resolver.resolve("continue.max_tokens", {}, () => "F")).toBe("A")
    const dup = events.filter((e) => e.source === "synthetic.duplicate_owner")
    expect(dup).toHaveLength(1)
    expect(dup[0]?.structuredData).toEqual({ kind: "continue.max_tokens" })
  })

  it("falls back and records synthetic.provider_failed when the provider throws", () => {
    const { resolver, events } = setup([
      stub(["continue.max_tokens"], () => {
        throw new Error("boom")
      }),
    ])
    expect(resolver.resolve("continue.max_tokens", {}, () => "F")).toBe("F")
    expect(events).toHaveLength(1)
    expect(events[0]?.source).toBe("synthetic.provider_failed")
    expect(events[0]?.message).toBe("")
    expect(events[0]?.structuredData).toEqual({ kind: "continue.max_tokens" })
  })
})
