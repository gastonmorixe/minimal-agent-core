import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { buildHolder, lockPathFor, serializeHolder } from "../infra/file-lock.ts"
import { executeToolRound, type ToolRoundContext } from "../loops/tool-round.ts"
import type { ModeManager } from "../modes/modes.ts"
import { allowDecision, denyDecision, NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { FileTrackingStore } from "../session/file-tracking-store.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { ToolFeedbackTracker } from "./feedback-tracker.ts"
import {
  _resetFileLockConfigForTests,
  executeTool as rawExecuteTool,
  TOOL_SPECS as TOOL_DEFINITIONS,
  type ToolExecOpts,
} from "./tools.ts"

// Text from the real text plugins, not a core fallback.
const TEXT = textFixturesPresent() ? fixtureSyntheticTextResolver() : undefined
/** `executeTool` with the fixture text resolver (an explicit `opts.text` wins). */
const executeTool = (name: string, input: Record<string, unknown>, opts: ToolExecOpts = {}) =>
  rawExecuteTool(name, input, { text: TEXT, ...opts })

let dir: string
let savedConfig: string | undefined
let savedDisabled: string | undefined

beforeEach(() => {
  const root = join(import.meta.dir, "../../tmp")
  mkdirSync(root, { recursive: true })
  dir = mkdtempSync(join(root, "tool-input-"))
  savedConfig = process.env.MINIMAL_AGENT_CONFIG
  savedDisabled = process.env.MINIMAL_AGENT_FILE_LOCK_DISABLED
  process.env.MINIMAL_AGENT_CONFIG = join(dir, "config.jsonc")
  delete process.env.MINIMAL_AGENT_FILE_LOCK_DISABLED
  writeFileSync(
    process.env.MINIMAL_AGENT_CONFIG,
    JSON.stringify({
      plugins: { "file-lock": { enabled: true, timeoutMs: 20, staleAfterMs: 60_000_000 } },
    }),
  )
  _resetFileLockConfigForTests()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedConfig === undefined) delete process.env.MINIMAL_AGENT_CONFIG
  else process.env.MINIMAL_AGENT_CONFIG = savedConfig
  if (savedDisabled === undefined) delete process.env.MINIMAL_AGENT_FILE_LOCK_DISABLED
  else process.env.MINIMAL_AGENT_FILE_LOCK_DISABLED = savedDisabled
  _resetFileLockConfigForTests()
})

function baseCtx(overrides: Partial<ToolRoundContext> = {}): ToolRoundContext {
  return {
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    ...overrides,
  }
}

describe.skipIf(!textFixturesPresent())("built-in tool input safety", () => {
  test("Read path alias records the canonical file in the tracker", async () => {
    const file = join(dir, "read.txt")
    writeFileSync(file, "before")
    const store = new FileTrackingStore({ sid: "tool-input", dir, cwd: dir })
    const read = await executeTool("Read", { path: file }, { fileTrackingStore: store })
    expect(read.is_error).toBeFalsy()
    expect(read.content).toContain("before")
    expect(store.lookup(file)?.path).toBe(file)
    const edit = await executeTool(
      "Edit",
      { path: file, old_string: "before", new_string: "after" },
      { fileTrackingStore: store },
    )
    expect(edit.is_error).toBeFalsy()
    expect(readFileSync(file, "utf8")).toBe("after")
  })

  for (const name of ["Write", "Edit"]) {
    test(`${name} path alias cannot skip a canonical file lock`, async () => {
      const file = join(dir, `${name}.txt`)
      writeFileSync(file, "before")
      writeFileSync(
        lockPathFor(file),
        serializeHolder(buildHolder({ sessionId: "peer", tool: name, filePath: file })),
      )
      const input =
        name === "Write"
          ? { path: file, contents: "after" }
          : { path: file, old_string: "before", new_string: "after" }
      const result = await executeTool(name, input)
      expect(result.is_error).toBe(true)
      expect(result.content).toContain("locked")
      expect(readFileSync(file, "utf8")).toBe("before")
      expect(existsSync(lockPathFor(file))).toBe(true)
    })
    test(`${name} invalid input does not make parent directories or locks`, async () => {
      const file = join(dir, "absent", "file.txt")
      const input =
        name === "Write"
          ? { file_path: file, content: 12 }
          : { file_path: file, old_string: "before", new_string: 12 }
      const result = await executeTool(name, input)
      expect(result.is_error).toBe(true)
      expect(existsSync(join(dir, "absent"))).toBe(false)
    })
  }

  for (const name of ["Read", "Write", "Edit"]) {
    for (const bad of [null, 42, false, [], {}]) {
      test(`${name} invalid canonical path never falls back to path alias (${JSON.stringify(bad)})`, async () => {
        const file = join(dir, "untouched.txt")
        writeFileSync(file, "before")
        const store = new FileTrackingStore({ sid: "invalid", dir, cwd: dir })
        const result = await executeTool(
          name,
          {
            file_path: bad,
            path: file,
            content: "after",
            old_string: "before",
            new_string: "after",
          },
          { fileTrackingStore: store },
        )
        expect(result.is_error).toBe(true)
        expect(store.lookup(file)).toBeUndefined()
        expect(readFileSync(file, "utf8")).toBe("before")
        expect(existsSync(lockPathFor(file))).toBe(false)
      })
    }
    test(`${name} canonical path wins over alias`, async () => {
      const canonical = join(dir, "canonical.txt")
      const alias = join(dir, "alias.txt")
      writeFileSync(canonical, "before")
      writeFileSync(alias, "alias")
      const result = await executeTool(name, {
        file_path: canonical,
        path: alias,
        content: "after",
        old_string: "before",
        new_string: "after",
      })
      expect(result.is_error).toBeFalsy()
      expect(readFileSync(alias, "utf8")).toBe("alias")
      if (name === "Read") expect(result.content).toContain("before")
      else expect(readFileSync(canonical, "utf8")).toBe("after")
    })
  }

  for (const definition of TOOL_DEFINITIONS) {
    const properties = definition.input_schema.properties as Record<string, { type: string }>
    const valid = Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => [
        key,
        schema.type === "string" ? "x" : schema.type === "boolean" ? false : 1,
      ]),
    )
    for (const required of (definition.input_schema.required ?? []) as string[]) {
      test(`${definition.name} rejects missing required ${required}`, async () => {
        const input = { ...valid }
        delete input[required]
        // Do not let a declared alias supply the omitted required value.
        delete input.path
        delete input.contents
        delete input.glob_pattern
        const result = await executeTool(definition.name, input)
        expect(result.is_error).toBe(true)
        expect(result.content).toContain(required)
      })
    }
    for (const [key, schema] of Object.entries(properties)) {
      if (["contents", "glob_pattern", "target_directory"].includes(key)) continue
      test(`${definition.name} rejects declared ${key} type before execution`, async () => {
        const bad = schema.type === "string" ? 12 : "wrong"
        const result = await executeTool(definition.name, { ...valid, [key]: bad })
        expect(result.is_error).toBe(true)
        expect(result.content).toContain(key)
      })
    }
  }

  test("normalization reaches mode and lifecycle checks before dispatch", async () => {
    const file = join(dir, "blocked.txt")
    let gateInput: unknown
    let hookInput: unknown
    const modeManager = {
      isToolAllowed: (_name: string, input: unknown) => {
        gateInput = input
        return { allowed: true }
      },
      activeId: () => null,
      buildActiveModeStamp: () => null,
    } as unknown as ModeManager
    const result = await executeToolRound(
      {
        type: "tool_use",
        id: "alias-policy",
        name: "Write",
        input: { path: file, contents: "blocked" },
      },
      baseCtx({
        modeManager,
        lifecycle: {
          ...NOOP_LIFECYCLE,
          beforeTool: async (payload) => {
            hookInput = payload.input
            return denyDecision("blocked")
          },
        },
      }),
    )
    expect(gateInput).toMatchObject({ file_path: file, content: "blocked" })
    expect(hookInput).toMatchObject({ file_path: file, content: "blocked" })
    expect(result.is_error).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  test("afterTool sees canonical path after lifecycle rewrites to an alias", async () => {
    const file = join(dir, "rewritten.txt")
    let seenPath: unknown
    const result = await executeToolRound(
      {
        type: "tool_use",
        id: "alias-rewrite",
        name: "Write",
        input: { file_path: join(dir, "original.txt"), content: "original" },
      },
      baseCtx({
        lifecycle: {
          ...NOOP_LIFECYCLE,
          beforeTool: async (payload) =>
            allowDecision({ ...payload, input: { path: file, contents: "rewritten" } }),
          afterTool: async (payload) => {
            seenPath = payload.filePath
            return payload
          },
        },
      }),
    )
    expect(result.is_error).toBeFalsy()
    expect(seenPath).toBe(file)
    expect(readFileSync(file, "utf8")).toBe("rewritten")
  })
})
