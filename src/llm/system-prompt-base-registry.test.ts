import { afterEach, describe, expect, test } from "bun:test"

import { createSystemPromptBaseHolder } from "../plugins/system-prompt-base.ts"

import {
  clearSystemPromptBase,
  getSystemPromptBase,
  setSystemPromptBase,
} from "./system-prompt-base-registry.ts"

describe("system prompt base registry", () => {
  afterEach(() => clearSystemPromptBase())

  test("empty by default", () => {
    expect(getSystemPromptBase()).toBeUndefined()
  })

  test("set, get, clear", () => {
    const h = createSystemPromptBaseHolder()
    setSystemPromptBase(h)
    expect(getSystemPromptBase()).toBe(h)
    clearSystemPromptBase()
    expect(getSystemPromptBase()).toBeUndefined()
  })

  test("a newer set replaces the older holder", () => {
    const a = createSystemPromptBaseHolder()
    const b = createSystemPromptBaseHolder()
    setSystemPromptBase(a)
    setSystemPromptBase(b)
    expect(getSystemPromptBase()).toBe(b)
  })

  test("release of an older owner after a newer set does nothing", () => {
    const releaseA = setSystemPromptBase(createSystemPromptBaseHolder())
    const b = createSystemPromptBaseHolder()
    setSystemPromptBase(b)
    releaseA()
    expect(getSystemPromptBase()).toBe(b)
  })

  test("release of the current owner clears", () => {
    const release = setSystemPromptBase(createSystemPromptBaseHolder())
    release()
    expect(getSystemPromptBase()).toBeUndefined()
  })
})
