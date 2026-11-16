import { describe, expect, it } from "bun:test"

import { textFixturesRequired, textFixturesTrigger } from "./text-fixtures-required.ts"

describe("textFixturesRequired", () => {
  const cases: Array<[string, Record<string, string | undefined>, string | null]> = [
    ["CI unset", {}, null],
    ['CI=""', { CI: "" }, null],
    ['CI="0"', { CI: "0" }, null],
    ['CI="false"', { CI: "false" }, null],
    ['CI=" FALSE "', { CI: " FALSE " }, null],
    ['CI="true"', { CI: "true" }, "CI=true"],
    ['CI="1"', { CI: "1" }, "CI=1"],
    [
      "MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1",
      { MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES: "1" },
      "MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1",
    ],
    [
      "the flag wins over CI=false",
      { MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES: "1", CI: "false" },
      "MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1",
    ],
    ["MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=0", { MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES: "0" }, null],
  ]

  for (const [name, env, trigger] of cases) {
    it(`${name}: required is ${trigger !== null}, trigger ${String(trigger)}`, () => {
      expect(textFixturesTrigger(env)).toBe(trigger)
      expect(textFixturesRequired(env)).toBe(trigger !== null)
    })
  }
})
