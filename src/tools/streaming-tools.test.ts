import { describe, expect, test } from "bun:test"

import { STREAMING_BUILTIN_TOOLS, toolStreamsOutput } from "./tools.ts"

describe("toolStreamsOutput", () => {
  test("built-in Bash streams", () => {
    expect(STREAMING_BUILTIN_TOOLS.has("Bash")).toBe(true)
    expect(toolStreamsOutput("Bash", false)).toBe(true)
  })

  test("non-streaming built-ins do not", () => {
    for (const name of ["Read", "Write", "Edit", "Grep", "Glob"]) {
      expect(toolStreamsOutput(name, false)).toBe(false)
    }
  })

  test("a plugin tool never streams, even with a built-in's name", () => {
    expect(toolStreamsOutput("Bash", true)).toBe(false)
    expect(toolStreamsOutput("Fetch", true)).toBe(false)
  })
})
