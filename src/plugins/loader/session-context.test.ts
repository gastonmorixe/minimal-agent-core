/**
 * `composeSessionContext` keeps the plugin text with no codec: each section
 * is its body with no wrapper (`renderCoreBody`), in the same order and with
 * the same separator. With the fixture codec the bytes are the role tags.
 *
 * @module plugins/loader/session-context.test
 */

import { describe, expect, it } from "bun:test"

import { createSidebandApi, NO_SIDEBAND } from "../../sideband/api.ts"
import { SIDEBAND_CORE_KIND_MISSING } from "../../sideband/core-render.ts"
import { createSidebandRegistry } from "../../sideband/registry.ts"
import type { SidebandApi } from "../../sideband/types.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../../test-utils/sideband-fixture.ts"
import { NO_PLUGIN_PROMPT_SUPPRESSION } from "../plugin-prompt-resolution.ts"
import type { LoadedPlugin } from "../types.ts"

import { composeSessionContext } from "./session-context.ts"

/** A plugin with a prompt and no tool: a `behavior` section (or `context` with fragments). */
function plugin(id: string, prompt: string): LoadedPlugin {
  return {
    manifest: { id, name: id, version: "0.1.0", description: "d" },
    packageDir: `/p/${id}`,
    prompt,
    handlers: [],
  } as unknown as LoadedPlugin
}

function compose(sb: Pick<SidebandApi, "render">, frags: Map<string, string[]> | null = null) {
  return composeSessionContext({
    plugins: [plugin("zz", "# Zeta\n\nZ body."), plugin("aa", "# Alpha\n\nA body.")],
    fragmentTexts: frags,
    pluginPrompts: NO_PLUGIN_PROMPT_SUPPRESSION,
    availability: {} as never,
    logger: () => {},
    sideband: sb,
  })
}

describe("composeSessionContext with no codec", () => {
  it("NO_SIDEBAND: each section is its body, sorted, joined with a blank line", () => {
    const r = compose(NO_SIDEBAND)
    expect(r.text).toBe("A body.\n\nZ body.")
    expect(r.sections.map((s) => [s.role, s.name, s.pluginId])).toEqual([
      ["behavior", "alpha", "aa"],
      ["behavior", "zeta", "zz"],
    ])
  })

  it("NO_SIDEBAND: a sessionContext fragment stays in its section", () => {
    const r = compose(NO_SIDEBAND, new Map([["aa", ["FRAG  "]]]))
    expect(r.text).toBe("A body.\n\nFRAG\n\nZ body.")
  })

  it("a codec with no role kind: the body, and one warning for each kind", () => {
    const warns: unknown[] = []
    const reg = createSidebandRegistry()
    reg.setCodec(
      () => ({
        id: "stub",
        render: () => "TAG",
        parse: () => [],
        scanner: () => ({ write() {}, end() {}, onText() {}, onNode() {} }),
        neutralize: (t: string) => t,
        example: () => "",
      }),
      "c",
    )
    const sb = createSidebandApi(reg, { diagnostics: { warn: (s, _m, d) => warns.push([s, d]) } })
    expect(compose(sb).text).toBe("A body.\n\nZ body.")
    expect(warns).toEqual([[SIDEBAND_CORE_KIND_MISSING, { kind: "behavior" }]])
  })
})

describe.skipIf(!sidebandFixturePresent())("composeSessionContext with the fixture codec", () => {
  it("the same bodies in the role tags (bytes unchanged)", () => {
    const sb = fixtureSidebandOrNone()
    const r = compose(sb)
    expect(r.text).toBe(
      [
        sb.render("behavior", { attrs: { name: "alpha" }, body: "A body." }),
        sb.render("behavior", { attrs: { name: "zeta" }, body: "Z body." }),
      ].join("\n\n"),
    )
    expect(r.text).toContain("A body.")
    expect(r.text).not.toBe("A body.\n\nZ body.")
  })
})
