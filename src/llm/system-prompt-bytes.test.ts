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

import { describe, expect, test } from "bun:test"

import { DEFAULT_REFLECTION_COOLDOWN_MS, DEFAULT_REFLECTION_INTERVAL } from "../agent/reflection.ts"
import { shortHash } from "../session/session-store.ts"

import {
  buildInstructionsBlockText,
  buildLoopSafetyParagraph,
  buildToolOutputConventionsParagraph,
  DEFAULT_INSTRUCTIONS,
} from "./instructions-block.ts"
import { type ResolveSystemPromptOptions, resolveSystemPromptForModel } from "./system-prompt.ts"
import type { SystemPromptOverrides } from "./system-prompt-overrides.ts"

const MODEL = "bytes-fixture-unregistered-model"
const DIR = join(import.meta.dir, "__fixtures__", "system-prompt-bytes")
const UPDATE = process.env.UPDATE_SYSTEM_PROMPT_BYTES === "1"

const OFF = { reflectionInterval: 0, blobStoreEnabled: false } as const
const DEFAULTS = {
  reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
  reflectionCooldownMs: DEFAULT_REFLECTION_COOLDOWN_MS,
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
  "02-neutral-blob": { reflectionInterval: 0, blobStoreEnabled: true, authKind: "api-key" },
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
  "07-api-key-core-only": { ...DEFAULTS, blobStoreEnabled: true, authKind: "api-key", ...EXTRAS },
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

describe("instructions block parts (current code)", () => {
  test("part: default instructions", () => {
    check("part-instructions.txt", DEFAULT_INSTRUCTIONS)
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
})
