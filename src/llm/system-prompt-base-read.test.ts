import { afterEach, describe, expect, test } from "bun:test"

import {
  createSystemPromptBaseHolder,
  registerSystemPromptBase,
} from "../plugins/system-prompt-base.ts"
import type { SystemPromptBaseProvider } from "../plugins/types.ts"
import {
  fixtureSystemPromptBase,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { type ResolveSystemPromptOptions, resolveSystemPromptForModel } from "./system-prompt.ts"
import { clearSystemPromptBase, setSystemPromptBase } from "./system-prompt-base-registry.ts"

const MODEL = "base-read-unregistered-model"

const DEFAULTS = {} as const
const EXTRAS = { afterInstructions: "AFTER", sessionContext: "SESSION" } as const
const A = { authKind: "api-key" } as const

const CASES: Record<string, ResolveSystemPromptOptions> = {
  "01": { ...A },
  "05": { ...DEFAULTS, ...A, ...EXTRAS },
  "06a": {
    ...DEFAULTS,
    ...A,
    overrides: { instructions: { kind: "replace", text: "OVERRIDE-INSTRUCTIONS" } },
  },
}

function stub(identity: string, instructions: string): SystemPromptBaseProvider {
  return {
    identity: () => identity,
    instructionParts: () => [{ slot: "instructions", text: instructions }],
  }
}

function setStub(identity: string, instructions: string): void {
  const holder = createSystemPromptBaseHolder()
  registerSystemPromptBase(holder, "stub", stub(identity, instructions))
  setSystemPromptBase(holder)
}

const bytes = (o: ResolveSystemPromptOptions) =>
  Buffer.from(JSON.stringify(resolveSystemPromptForModel(MODEL, o)), "utf8")

describe("system prompt reads the base registry", () => {
  afterEach(() => clearSystemPromptBase())

  // Core holds no base text: the registered holder (the real base prompt
  // plugin) gives the same bytes as the same holder passed as an option.
  for (const [name, opts] of Object.entries(CASES)) {
    test.skipIf(!textFixturesPresent())(
      `case ${name}: the registered base holder equals the option holder`,
      () => {
        const viaOption = bytes({ ...opts, systemPromptBase: fixtureSystemPromptBase() })
        setSystemPromptBase(fixtureSystemPromptBase())
        expect(bytes(opts).equals(viaOption)).toBe(true)
      },
    )
  }

  test("the empty registry sends no identity and no slot text", () => {
    expect(resolveSystemPromptForModel(MODEL, { ...DEFAULTS, ...A })).toEqual([])
  })

  test("different text from the holder reaches the output", () => {
    setStub("HOLDER-IDENTITY", "HOLDER-INSTRUCTIONS")
    const text = JSON.stringify(resolveSystemPromptForModel(MODEL, { ...DEFAULTS, ...A }))
    expect(text).toContain("HOLDER-IDENTITY")
    expect(text).toContain("HOLDER-INSTRUCTIONS")
  })

  test("host overrides and options still win over the holder", () => {
    setStub("HOLDER-IDENTITY", "HOLDER-INSTRUCTIONS")
    const over = JSON.stringify(
      resolveSystemPromptForModel(MODEL, {
        ...DEFAULTS,
        ...A,
        overrides: {
          instructions: { kind: "replace", text: "OVERRIDE-INSTRUCTIONS" },
          identity: { kind: "replace", text: "OVERRIDE-IDENTITY" },
        },
      }),
    )
    expect(over).toContain("OVERRIDE-INSTRUCTIONS")
    expect(over).toContain("OVERRIDE-IDENTITY")
    expect(over).not.toContain("HOLDER-")
    const opt = JSON.stringify(
      resolveSystemPromptForModel(MODEL, {
        ...DEFAULTS,
        ...A,
        identity: "OPT-IDENTITY",
        instructions: "OPT-INSTRUCTIONS",
      }),
    )
    expect(opt).toContain("OPT-IDENTITY")
    expect(opt).toContain("OPT-INSTRUCTIONS")
    expect(opt).not.toContain("HOLDER-")
  })
})
