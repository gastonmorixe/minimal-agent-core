import { describe, expect, test } from "bun:test"

import {
  collectFlagValues,
  parseCommaSeparatedIds,
  resolvePluginEnabledOverrides,
} from "./plugin-enable-resolution.ts"

describe("collectFlagValues", () => {
  test("returns empty for absent flag", () => {
    expect(collectFlagValues(["--model", "x"], "--disable-plugin")).toEqual([])
  })

  test("collects repeated --disable-plugin flags", () => {
    expect(
      collectFlagValues(
        ["--disable-plugin", "web-search", "--disable-plugin", "memory"],
        "--disable-plugin",
      ),
    ).toEqual(["web-search", "memory"])
  })

  test("collects --disable-plugin=id form", () => {
    expect(collectFlagValues(["--disable-plugin=web-search"], "--disable-plugin")).toEqual([
      "web-search",
    ])
  })

  test("splits comma-separated ids inside a value", () => {
    expect(
      collectFlagValues(["--disable-plugin", "web-search,memory"], "--disable-plugin"),
    ).toEqual(["web-search", "memory"])
  })

  test("trims whitespace and drops empty tokens", () => {
    expect(collectFlagValues(["--disable-plugin", " a , , b "], "--disable-plugin")).toEqual([
      "a",
      "b",
    ])
  })

  test("does not consume a following flag as the value", () => {
    expect(collectFlagValues(["--disable-plugin", "--enable-plugin"], "--disable-plugin")).toEqual(
      [],
    )
  })
})

describe("parseCommaSeparatedIds", () => {
  test("undefined or empty → []", () => {
    expect(parseCommaSeparatedIds(undefined)).toEqual([])
    expect(parseCommaSeparatedIds("")).toEqual([])
  })

  test("splits and trims", () => {
    expect(parseCommaSeparatedIds("web-search, memory ,tasks")).toEqual([
      "web-search",
      "memory",
      "tasks",
    ])
  })
})

describe("resolvePluginEnabledOverrides", () => {
  const empty = { forceDisabled: new Set<string>(), forceEnabled: new Set<string>() }

  test("config disable only", () => {
    const r = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(["web-search"]), forceEnabled: new Set() },
    })
    expect(r.forceDisabled).toEqual(new Set(["web-search"]))
    expect(r.forceEnabled).toEqual(new Set())
  })

  test("config enable + CLI disable → disabled (CLI wins)", () => {
    const r = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(), forceEnabled: new Set(["interleave-thinking"]) },
      cli: { disable: ["interleave-thinking"], enable: [] },
    })
    expect(r.forceDisabled).toEqual(new Set(["interleave-thinking"]))
    expect(r.forceEnabled).toEqual(new Set())
  })

  test("config disable + CLI enable → enabled (CLI wins)", () => {
    const r = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(["web-search"]), forceEnabled: new Set() },
      cli: { disable: [], enable: ["web-search"] },
    })
    expect(r.forceDisabled).toEqual(new Set())
    expect(r.forceEnabled).toEqual(new Set(["web-search"]))
  })

  test("env disable + CLI enable → enabled (CLI wins)", () => {
    const r = resolvePluginEnabledOverrides({
      config: empty,
      env: { disable: "memory", enable: undefined },
      cli: { disable: [], enable: ["memory"] },
    })
    expect(r.forceDisabled).toEqual(new Set())
    expect(r.forceEnabled).toEqual(new Set(["memory"]))
  })

  test("env enable + env disable same id → disabled (deny beats allow within env)", () => {
    const r = resolvePluginEnabledOverrides({
      config: empty,
      env: { enable: "tasks", disable: "tasks" },
    })
    expect(r.forceDisabled).toEqual(new Set(["tasks"]))
    expect(r.forceEnabled).toEqual(new Set())
  })

  test("CLI enable + CLI disable same id → disabled", () => {
    const r = resolvePluginEnabledOverrides({
      config: empty,
      cli: { enable: ["history"], disable: ["history"] },
    })
    expect(r.forceDisabled).toEqual(new Set(["history"]))
    expect(r.forceEnabled).toEqual(new Set())
  })

  test("env layer applied before CLI layer", () => {
    const r = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(["a"]), forceEnabled: new Set() },
      env: { enable: "a", disable: "b" },
      cli: { enable: ["b"], disable: [] },
    })
    expect(r.forceDisabled).toEqual(new Set())
    expect(r.forceEnabled).toEqual(new Set(["a", "b"]))
  })

  test("config deny beats config allow when both present (config walk order preserved)", () => {
    const r = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(["x"]), forceEnabled: new Set(["x"]) },
    })
    // loadPluginEnabledOverrides never produces both; resolution preserves sets as given.
    expect(r.forceDisabled).toEqual(new Set(["x"]))
    expect(r.forceEnabled).toEqual(new Set(["x"]))
  })

  test("loader semantics: disabled wins when both sets contain same id", () => {
    const r = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(["standoff"]), forceEnabled: new Set(["standoff"]) },
    })
    expect(r.forceDisabled.has("standoff")).toBe(true)
    expect(r.forceEnabled.has("standoff")).toBe(true)
  })

  test("multiple env and cli ids merge", () => {
    const r = resolvePluginEnabledOverrides({
      config: empty,
      env: { disable: "web-search", enable: "interleave-thinking" },
      cli: { disable: ["memory"], enable: [] },
    })
    expect(r.forceDisabled).toEqual(new Set(["web-search", "memory"]))
    expect(r.forceEnabled).toEqual(new Set(["interleave-thinking"]))
  })
})
