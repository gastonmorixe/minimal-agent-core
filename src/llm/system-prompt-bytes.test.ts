/**
 * Byte fixtures for the assembled system array (Phase 5 safety net).
 *
 * Each case serializes the output of `resolveSystemPromptForModel` with
 * `JSON.stringify(x, null, 2)` and compares it, byte for byte, to a file in
 * `__fixtures__/system-prompt-bytes/`. The inputs are fixed: no clock, no env,
 * no cwd, no version string. The model id is unregistered, so no provider
 * plugin applies (neutral prompt, core only).
 *
 * To recapture from current code: `UPDATE_SYSTEM_PROMPT_BYTES=1 bun test <this file>`.
 * Review the fixture diff by hand before you keep it.
 *
 * @module llm/system-prompt-bytes.test
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { shortHash } from "../session/session-store.ts"
import {
  fixtureSystemPromptBase,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import type { Capabilities } from "./capabilities.ts"
import {
  buildInstructionsBlockParts,
  buildInstructionsBlockText,
  type InstructionsBlockOptions,
  type InstructionsBlockPart,
} from "./instructions-block.ts"
import { clearModelRegistry, registerModel } from "./model-registry.ts"
import { clearProviderPlugins, registerProviderPlugin } from "./provider-plugin.ts"
import { type ResolveSystemPromptOptions, resolveSystemPromptForModel } from "./system-prompt.ts"
import type { SystemPromptOverrides } from "./system-prompt-overrides.ts"

const MODEL = "bytes-fixture-unregistered-model"
// The identity and the 2 base slots come from the real base prompt plugin
// (sibling checkout), not from a core fallback. Same bytes as the fixtures.
const BASE = textFixturesPresent() ? { systemPromptBase: fixtureSystemPromptBase() } : {}
const DIR = join(import.meta.dir, "__fixtures__", "system-prompt-bytes")
// When this switch is on, the test writes each fixture from its own output and
// then compares the output with that file, so it compares the output with
// itself. A fixture changed this way must be reviewed by hand against the old bytes.
const UPDATE = process.env.UPDATE_SYSTEM_PROMPT_BYTES === "1"

// A fixed agent home, so the fixtures do not depend on MINIMAL_AGENT_HOME or $HOME.
const AGENT_HOME = "~/.minimal-agent"
const OFF = { blobStoreEnabled: false, agentHome: AGENT_HOME } as const
const DEFAULTS = { agentHome: AGENT_HOME } as const
const EXTRAS = {
  afterInstructions: "AFTER-INSTRUCTIONS fixed text.",
  sessionContext: "SESSION-CONTEXT fixed text.",
} as const

const ALL_OVERRIDES: SystemPromptOverrides = {
  instructions: { kind: "replace", text: "OVERRIDE-INSTRUCTIONS" },
  toolOutputConventions: { kind: "replace", text: "OVERRIDE-CONVENTIONS" },
}

const RAW_CASES: Record<string, ResolveSystemPromptOptions> = {
  "01-neutral-bare": { ...OFF, authKind: "api-key" },
  "02-neutral-blob": { ...OFF, blobStoreEnabled: true, authKind: "api-key" },
  "04-neutral-all-on": { ...DEFAULTS, blobStoreEnabled: true, authKind: "api-key" },
  "05-neutral-all-on-extras": {
    ...DEFAULTS,
    blobStoreEnabled: true,
    authKind: "api-key",
    ...EXTRAS,
  },
  "06a-override-instructions": {
    ...DEFAULTS,
    blobStoreEnabled: true,
    authKind: "api-key",
    overrides: { instructions: ALL_OVERRIDES.instructions },
  },
  "06c-override-conventions": {
    ...DEFAULTS,
    blobStoreEnabled: true,
    authKind: "api-key",
    overrides: { toolOutputConventions: ALL_OVERRIDES.toolOutputConventions },
  },
  "06d-override-all": {
    ...DEFAULTS,
    blobStoreEnabled: true,
    authKind: "api-key",
    overrides: ALL_OVERRIDES,
  },
  "09-override-all-extras": {
    ...DEFAULTS,
    blobStoreEnabled: true,
    authKind: "api-key",
    ...EXTRAS,
    overrides: ALL_OVERRIDES,
  },
}

const CASES: Record<string, ResolveSystemPromptOptions> = Object.fromEntries(
  Object.entries(RAW_CASES).map(([name, opts]) => [name, { ...opts, ...BASE }]),
)

/** The text of one slot of the instructions block, built with the base provider. */
function slotText(slot: InstructionsBlockPart["slot"], opts: InstructionsBlockOptions): string {
  const part = buildInstructionsBlockParts({ ...opts, ...BASE }).find((p) => p.slot === slot)
  return part?.text ?? ""
}

function check(name: string, text: string): void {
  const actual = Buffer.from(text, "utf8")
  expect(actual.length).toBeGreaterThan(0)
  const file = join(DIR, name)
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(file, actual)
  }
  expect(existsSync(file)).toBe(true)
  const expected = readFileSync(file)
  expect(actual.equals(expected)).toBe(true)
}

describe.skipIf(!textFixturesPresent())("system array bytes (current code)", () => {
  for (const [name, opts] of Object.entries(CASES)) {
    test(`case ${name}`, () => {
      const out = resolveSystemPromptForModel(MODEL, opts)
      check(`${name}.json.txt`, JSON.stringify(out, null, 2))
    })
  }
})

describe.skipIf(!textFixturesPresent())(
  "registered provider plugin (stub, no real plugin loading)",
  () => {
    const REG_MODEL = "bytes-fixture-registered-model"
    afterEach(() => {
      clearProviderPlugins()
      clearModelRegistry()
    })
    test("case 10-registered-provider-ttl-1h", () => {
      registerModel({
        id: REG_MODEL,
        providerId: "bytesprov",
        surfaceId: "custom",
        displayName: REG_MODEL,
        capabilities: {
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
          maxOutputTokensBatch: null,
        } as Capabilities,
        pricing: {
          inputUSD: 1,
          outputUSD: 1,
          cacheWriteUSD: 0,
          cacheReadUSD: 0,
          webSearchPerCallUSD: 0,
        },
      })
      registerProviderPlugin({
        id: "bytesprov",
        displayName: "Bytes",
        shortCode: "by",
        register() {},
        resolveSystemPrompt(ctx) {
          return [{ type: "text", text: "STUB-PREAMBLE" }, ...ctx.body]
        },
      })
      const out = resolveSystemPromptForModel(REG_MODEL, {
        ...DEFAULTS,
        blobStoreEnabled: true,
        authKind: "api-key",
        providerId: "bytesprov",
        cacheTtl: "1h",
        ...EXTRAS,
        ...BASE,
      })
      check("10-registered-provider-ttl-1h.json.txt", JSON.stringify(out, null, 2))
    })
  },
)

describe.skipIf(!textFixturesPresent())("instructions block parts (current code)", () => {
  test("part: default instructions", () => {
    check("part-instructions.txt", slotText("instructions", { ...DEFAULTS }))
  })
  test("part: tool output conventions", () => {
    check(
      "part-conventions.txt",
      slotText("toolOutputConventions", { ...DEFAULTS, blobStoreEnabled: true }),
    )
  })
  test("part: joined block, all on", () => {
    check(
      "part-joined-all-on.txt",
      buildInstructionsBlockText({
        ...DEFAULTS,
        blobStoreEnabled: true,
        ...BASE,
      }),
    )
  })
  test("part: joined block, all off", () => {
    check("part-joined-all-off.txt", buildInstructionsBlockText({ ...OFF, ...BASE }))
  })
})

describe("startup hash of the system array", () => {
  // computeStartupHashes itself reads the blob store config from disk and the
  // plugin loader, so it is not a pure function of fixed inputs. The part that
  // is pure is shortHash(JSON.stringify(system array)). Pin that part.
  test.skipIf(!textFixturesPresent())("hash without extras and with extras", () => {
    const bare = JSON.stringify(resolveSystemPromptForModel(MODEL, CASES["04-neutral-all-on"]))
    const extras = JSON.stringify(
      resolveSystemPromptForModel(MODEL, CASES["05-neutral-all-on-extras"]),
    )
    const text = `${shortHash(bare)}\n${shortHash(extras)}\n`
    check("startup-hash.txt", text)
    expect(shortHash(bare)).not.toBe(shortHash(extras))
  })
  // computeStartupHashes hashes the empty string when there are no body extras
  // (`hasBodyExtras` false). That branch is inline there, not an exported helper.
  // Pin it with the same shortHash call on "".
  test("hash of the empty string (no extras)", () => {
    check("startup-hash-no-extras.txt", `${shortHash("")}\n`)
  })
})
