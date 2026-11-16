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

import { DEFAULT_REFLECTION_COOLDOWN_MS, DEFAULT_REFLECTION_INTERVAL } from "../agent/reflection.ts"
import { shortHash } from "../session/session-store.ts"

import type { Capabilities } from "./capabilities.ts"
import {
  buildInstructionsBlockText,
  buildLoopSafetyParagraph,
  buildToolOutputConventionsParagraph,
  DEFAULT_INSTRUCTIONS,
  renderInstructions,
} from "./instructions-block.ts"
import { clearModelRegistry, registerModel } from "./model-registry.ts"
import { clearProviderPlugins, registerProviderPlugin } from "./provider-plugin.ts"
import { type ResolveSystemPromptOptions, resolveSystemPromptForModel } from "./system-prompt.ts"
import type { SystemPromptOverrides } from "./system-prompt-overrides.ts"

const MODEL = "bytes-fixture-unregistered-model"
const DIR = join(import.meta.dir, "__fixtures__", "system-prompt-bytes")
// When this switch is on, the test writes each fixture from its own output and
// then compares the output with that file, so it compares the output with
// itself. A fixture changed this way must be reviewed by hand against the old bytes.
const UPDATE = process.env.UPDATE_SYSTEM_PROMPT_BYTES === "1"

// A fixed agent home, so the fixtures do not depend on MINIMAL_AGENT_HOME or $HOME.
const AGENT_HOME = "~/.minimal-agent"
const OFF = { reflectionInterval: 0, blobStoreEnabled: false, agentHome: AGENT_HOME } as const
const DEFAULTS = {
  reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
  reflectionCooldownMs: DEFAULT_REFLECTION_COOLDOWN_MS,
  agentHome: AGENT_HOME,
} as const
const EXTRAS = {
  afterInstructions: "AFTER-INSTRUCTIONS fixed text.",
  sessionContext: "SESSION-CONTEXT fixed text.",
} as const

const ALL_OVERRIDES: SystemPromptOverrides = {
  instructions: { kind: "replace", text: "OVERRIDE-INSTRUCTIONS" },
  loopSafety: { kind: "replace", text: "OVERRIDE-LOOP-SAFETY" },
  toolOutputConventions: { kind: "replace", text: "OVERRIDE-CONVENTIONS" },
}

const CASES: Record<string, ResolveSystemPromptOptions> = {
  "01-neutral-bare": { ...OFF, authKind: "api-key" },
  "02-neutral-blob": { ...OFF, blobStoreEnabled: true, authKind: "api-key" },
  "03-neutral-loop-safety": { ...DEFAULTS, blobStoreEnabled: false, authKind: "api-key" },
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
  "06b-override-loop-safety": {
    ...DEFAULTS,
    blobStoreEnabled: true,
    authKind: "api-key",
    overrides: { loopSafety: ALL_OVERRIDES.loopSafety },
  },
  "06c-override-conventions": {
    ...DEFAULTS,
    blobStoreEnabled: true,
    authKind: "api-key",
    overrides: { toolOutputConventions: ALL_OVERRIDES.toolOutputConventions },
  },
  "06d-override-all-three": {
    ...DEFAULTS,
    blobStoreEnabled: true,
    authKind: "api-key",
    overrides: ALL_OVERRIDES,
  },
  "08-reflection-zero-blob": {
    reflectionInterval: 0,
    reflectionCooldownMs: 0,
    blobStoreEnabled: true,
    authKind: "api-key",
    agentHome: AGENT_HOME,
  },
  "09-override-all-three-extras": {
    ...DEFAULTS,
    blobStoreEnabled: true,
    authKind: "api-key",
    ...EXTRAS,
    overrides: ALL_OVERRIDES,
  },
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

describe("system array bytes (current code)", () => {
  for (const [name, opts] of Object.entries(CASES)) {
    test(`case ${name}`, () => {
      const out = resolveSystemPromptForModel(MODEL, opts)
      check(`${name}.json.txt`, JSON.stringify(out, null, 2))
    })
  }
})

describe("registered provider plugin (stub, no real plugin loading)", () => {
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
    })
    check("10-registered-provider-ttl-1h.json.txt", JSON.stringify(out, null, 2))
  })
})

describe("instructions block parts (current code)", () => {
  test("part: default instructions", () => {
    check("part-instructions.txt", renderInstructions(DEFAULT_INSTRUCTIONS, AGENT_HOME))
  })
  test("part: loop safety (default interval and cooldown)", () => {
    check(
      "part-loop-safety.txt",
      buildLoopSafetyParagraph({
        reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
        reflectionCooldownMs: DEFAULT_REFLECTION_COOLDOWN_MS,
      }),
    )
  })
  test("part: loop safety (interval, no cooldown)", () => {
    check(
      "part-loop-safety-nocooldown.txt",
      buildLoopSafetyParagraph({
        reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
        reflectionCooldownMs: 0,
      }),
    )
  })
  test("part: tool output conventions", () => {
    check("part-conventions.txt", buildToolOutputConventionsParagraph({ blobStoreEnabled: true }))
  })
  test("part: joined block, all on", () => {
    check(
      "part-joined-all-on.txt",
      buildInstructionsBlockText({
        ...DEFAULTS,
        blobStoreEnabled: true,
      }),
    )
  })
  test("part: joined block, all off", () => {
    check("part-joined-all-off.txt", buildInstructionsBlockText({ ...OFF }))
  })
})

describe("startup hash of the system array", () => {
  // computeStartupHashes itself reads the blob store config from disk and the
  // plugin loader, so it is not a pure function of fixed inputs. The part that
  // is pure is shortHash(JSON.stringify(system array)). Pin that part.
  test("hash without extras and with extras", () => {
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
