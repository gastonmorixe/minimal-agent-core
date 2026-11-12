import { describe, expect, test } from "bun:test"

import type { PluginLoader } from "../plugins/loader.ts"
import {
  createSystemPromptBaseHolder,
  type SystemPromptBaseHolder,
} from "../plugins/system-prompt-base.ts"

import { PromptContributorAdapter } from "./prompt-contributor-adapter.ts"

function asLoader(stub: object): PluginLoader {
  return stub as unknown as PluginLoader
}

describe("PromptContributorAdapter.systemPromptBase", () => {
  test("returns the holder of the loader", async () => {
    const holder: SystemPromptBaseHolder = createSystemPromptBaseHolder()
    const adapter = await PromptContributorAdapter.create({
      loader: asLoader({ systemPromptBase: () => holder }),
    })
    expect(adapter.systemPromptBase()).toBe(holder)
  })

  test("returns the holder of the dep getter first", async () => {
    const fromDep = createSystemPromptBaseHolder()
    const fromLoader = createSystemPromptBaseHolder()
    const adapter = await PromptContributorAdapter.create({
      loader: asLoader({ systemPromptBase: () => fromLoader }),
      systemPromptBase: () => fromDep,
    })
    expect(adapter.systemPromptBase()).toBe(fromDep)
  })

  test("returns undefined when the loader has no such method", async () => {
    const adapter = await PromptContributorAdapter.create({ loader: asLoader({}) })
    expect(adapter.systemPromptBase()).toBeUndefined()
  })

  test("returns undefined with no loader", async () => {
    const adapter = await PromptContributorAdapter.create({})
    expect(adapter.systemPromptBase()).toBeUndefined()
    const none = await PromptContributorAdapter.create({ loader: null })
    expect(none.systemPromptBase()).toBeUndefined()
  })
})
