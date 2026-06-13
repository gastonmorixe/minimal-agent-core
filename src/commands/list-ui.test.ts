import { describe, expect, it } from "bun:test"

import { BETA_FLAGS_DETAILED } from "../headers.ts"
import { stripAnsi } from "../term-width.ts"
import { SPINNER_PRESETS } from "../ui/spinner/named-presets.ts"

import { runListFlagsCommand } from "./list-flags.ts"
import { runListSpinnersCommand } from "./list-spinners.ts"

function capture(run: (deps: { output: { write(s: string): unknown } }) => void): string {
  let out = ""
  run({ output: { write: (s) => (out += s) } })
  return stripAnsi(out)
}

describe("list UI commands", () => {
  it("renders spinner presets through injected output", () => {
    const out = capture(runListSpinnersCommand)
    expect(out).toContain("Spinner presets")
    expect(out).toContain(SPINNER_PRESETS[0]!.id)
    expect(out).toContain(`${SPINNER_PRESETS.length} presets total`)
  })

  it("renders beta flags through injected output", () => {
    const out = capture(runListFlagsCommand)
    expect(out).toContain("Beta feature flags")
    expect(out).toContain(BETA_FLAGS_DETAILED[0]!.id)
    expect(out).toContain(`${BETA_FLAGS_DETAILED.length} flags total`)
  })
})
