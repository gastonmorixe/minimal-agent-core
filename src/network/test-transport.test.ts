import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { readTestResponseText } from "./test-transport.ts"

const DIR = mkdtempSync(join(tmpdir(), "ma-test-transport-"))

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe("readTestResponseText", () => {
  it("returns PONG when no env value is set", () => {
    expect(readTestResponseText({})).toBe("PONG")
  })

  it("returns MINIMAL_AGENT_TEST_RESPONSE", () => {
    expect(readTestResponseText({ MINIMAL_AGENT_TEST_RESPONSE: "hi" })).toBe("hi")
  })

  it("reads MINIMAL_AGENT_TEST_RESPONSE_FILE, and the file wins over the env text", () => {
    // Larger than the Linux 128 KiB cap on one env string.
    const text = "\x01".repeat(200 * 1024)
    const file = join(DIR, "response.txt")
    writeFileSync(file, text)
    expect(
      readTestResponseText({
        MINIMAL_AGENT_TEST_RESPONSE: "hi",
        MINIMAL_AGENT_TEST_RESPONSE_FILE: file,
      }),
    ).toBe(text)
  })
})
