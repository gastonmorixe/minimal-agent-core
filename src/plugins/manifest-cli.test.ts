/**
 * Unit tests for the top-level `cli` manifest block (`manifest-cli.ts`),
 * direct and through the real {@link parseManifest} entry (SPEC-HELP V-15).
 *
 * @module plugins/manifest-cli.test
 */

import { describe, expect, it } from "bun:test"

import { CLI_CONTRACT_VERSION } from "../../plugin-api/src/types/cli-contract.ts"

import { parseManifest } from "./manifest.ts"
import { CLI_MAX_COMMANDS, CLI_MAX_SUMMARY, parseCli } from "./manifest-cli.ts"

const PATH = "/fake/manifest.json"
const BASE = { id: "sched", name: "Sched", version: "0.1.0", description: "Schedules" }
const ESC = String.fromCodePoint(0x1b)

/** A full valid `cli` block: every field of every spec type. */
function validCli(): Record<string, unknown> {
  return {
    contractVersion: 1,
    commands: [
      {
        name: "schedule",
        summary: "Manage scheduled prompts",
        description: ["Run prompts on a timer.", ""],
        aliases: ["sched"],
        hidden: false,
        usage: ["schedule <sub>"],
        env: [
          {
            name: "MA_SCHED_DIR",
            summary: "Where tasks live",
            default: "",
            flag: "dir",
            hidden: true,
          },
        ],
        examples: [{ argv: "plugin schedule list", summary: "List tasks" }],
        seeAlso: [["schedule", "list"]],
        strict: true,
        commands: [
          {
            name: "list",
            summary: "List tasks",
            args: [
              { name: "filter", summary: "Text filter", required: false, choices: ["a", "b"] },
              { name: "rest", summary: "More", variadic: true },
            ],
            flags: [
              {
                name: "dir",
                short: "d",
                aliases: ["directory"],
                type: "string",
                value: "required",
                valueName: "path",
                choices: ["x"],
                default: "x",
                multiple: true,
                negatable: false,
                env: "MA_SCHED_DIR",
                summary: "Task dir",
                description: ["Long text."],
                group: "Storage",
                hidden: false,
                deprecated: "use --path",
              },
              { name: "json", type: "boolean", summary: "JSON output", default: false },
              { name: "limit", type: "number", value: "optional", summary: "Max rows", default: 5 },
            ],
            handler: { type: "module", path: "./cli/list.ts" },
          },
        ],
      },
    ],
    helpSections: [
      {
        id: "notes",
        title: "Scheduling notes",
        text: ["Times are local."],
        rows: [{ term: "cron", summary: "5-field cron" }],
      },
    ],
  }
}

/** Run `parseCli` and collect warnings. */
function run(raw: unknown) {
  const warnings: string[] = []
  const cli = parseCli(raw, PATH, (m) => warnings.push(m))
  return { cli, warnings }
}

/** A valid block with one root command replaced or patched. */
function withCommand(over: Record<string, unknown>): Record<string, unknown> {
  return {
    contractVersion: 1,
    commands: [{ name: "go", summary: "Go", ...over }],
  }
}

/** Expect the block to drop with one warning that matches `re`. */
function expectDropped(raw: unknown, re: RegExp) {
  const { cli, warnings } = run(raw)
  expect(cli).toBeUndefined()
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain(`${PATH}: cli block dropped (plugin still loads):`)
  expect(warnings[0]).toMatch(re)
}

describe("parseCli: valid blocks", () => {
  it("returns undefined with no warning when the block is absent", () => {
    expect(run(undefined)).toEqual({ cli: undefined, warnings: [] })
    expect(run(null)).toEqual({ cli: undefined, warnings: [] })
  })

  it("keeps a full valid block unchanged, handler normalized", () => {
    const { cli, warnings } = run(validCli())
    expect(warnings).toEqual([])
    const expected = validCli()
    const sub = (expected.commands as Record<string, unknown>[])[0]?.commands as Record<
      string,
      unknown
    >[]
    sub[0] = { ...sub[0], handler: { type: "module", path: "./cli/list.ts", export: "default" } }
    expect(cli as unknown).toEqual(expected)
  })

  it("accepts a block with only contractVersion", () => {
    expect(run({ contractVersion: CLI_CONTRACT_VERSION })).toEqual({
      cli: { contractVersion: 1 },
      warnings: [],
    })
  })

  it("ignores unknown keys and does not copy them", () => {
    const { cli, warnings } = run({
      contractVersion: 1,
      futureKey: true,
      commands: [{ name: "go", summary: "Go", futureField: 1 }],
    })
    expect(warnings).toEqual([])
    expect(cli).toEqual({ contractVersion: 1, commands: [{ name: "go", summary: "Go" }] })
  })

  it("allows `plugin` as a nested command name (only the root is reserved)", () => {
    const { cli } = run(withCommand({ commands: [{ name: "plugin", summary: "Nested" }] }))
    expect(cli?.commands?.[0]?.commands?.[0]?.name).toBe("plugin")
  })
})

describe("parseCli: dropped blocks", () => {
  it("drops a block that is not an object", () => {
    expectDropped([], /cli: must be an object/)
    expectDropped("x", /cli: must be an object/)
  })

  it("drops a missing or unknown contractVersion", () => {
    expectDropped({}, /cli\.contractVersion: unknown contract version undefined/)
    expectDropped({ contractVersion: 2 }, /unknown contract version 2 \(this core knows 1\)/)
    expectDropped({ contractVersion: "1" }, /unknown contract version "1"/)
  })

  it("drops a bad command name", () => {
    expectDropped(withCommand({ name: "Bad Name" }), /cli\.commands\[0\]\.name: must match/)
    expectDropped(withCommand({ name: "-x" }), /must match/)
    expectDropped(withCommand({ name: "" }), /must not be empty/)
    expectDropped(withCommand({ aliases: ["OK"] }), /cli\.commands\[0\]\.aliases\[0\]/)
  })

  it("drops a root command or alias named `plugin` (reserved root verb, Q-9)", () => {
    expectDropped(withCommand({ name: "plugin" }), /"plugin" is reserved/)
    expectDropped(withCommand({ aliases: ["plugin"] }), /"plugin" is reserved/)
  })

  it("drops duplicate command names and aliases", () => {
    expectDropped(
      {
        contractVersion: 1,
        commands: [
          { name: "go", summary: "a" },
          { name: "go", summary: "b" },
        ],
      },
      /duplicate command name or alias: "go"/,
    )
    expectDropped(
      {
        contractVersion: 1,
        commands: [
          { name: "go", summary: "a", aliases: ["run"] },
          { name: "run", summary: "b" },
        ],
      },
      /duplicate command name or alias: "run"/,
    )
  })

  it("drops a bad flag value mode and a bad flag type", () => {
    const flag = (over: Record<string, unknown>) =>
      withCommand({ flags: [{ name: "x", type: "string", summary: "X", ...over }] })
    expectDropped(
      flag({ value: "maybe" }),
      /flags\[0\]\.value: must be one of none, required, optional \(got: "maybe"\)/,
    )
    expectDropped(flag({ type: "int" }), /flags\[0\]\.type: must be one of boolean, string, number/)
    expectDropped(flag({ short: "ab" }), /flags\[0\]\.short: must match/)
    expectDropped(flag({ name: "--x" }), /flags\[0\]\.name: must match/)
    expectDropped(flag({ global: true }), /global is for built-in flags only/)
    expectDropped(flag({ default: {} }), /flags\[0\]\.default: must be a string/)
  })

  it("drops duplicate flags and short flags", () => {
    expectDropped(
      withCommand({
        flags: [
          { name: "a", short: "a", type: "boolean", summary: "A" },
          { name: "b", short: "a", type: "boolean", summary: "B" },
        ],
      }),
      /duplicate short flag: "a"/,
    )
    expectDropped(
      withCommand({
        flags: [
          { name: "a", type: "boolean", summary: "A" },
          { name: "a", type: "string", summary: "A2" },
        ],
      }),
      /flags: duplicate flag name or alias: "a"/,
    )
    expectDropped(
      withCommand({
        flags: [
          { name: "a", aliases: ["bee"], type: "boolean", summary: "A" },
          { name: "bee", type: "boolean", summary: "B" },
        ],
      }),
      /flags: duplicate flag name or alias: "bee"/,
    )
  })

  it("drops a flag name, alias, or short reserved for help (R-16)", () => {
    const flag = (over: Record<string, unknown>) =>
      withCommand({ flags: [{ name: "x", type: "boolean", summary: "X", ...over }] })
    expectDropped(flag({ name: "help" }), /flags\[0\]\.name: "help" is reserved for help/)
    expectDropped(flag({ short: "h" }), /flags\[0\]\.short: "h" is reserved for help/)
    expectDropped(flag({ aliases: ["help"] }), /flags\[0\]\.aliases: "help" is reserved for help/)
    // `H` and `helper` are not reserved.
    const { cli, warnings } = run(flag({ short: "H", aliases: ["helper"] }))
    expect(warnings).toEqual([])
    expect(cli?.commands?.[0]?.flags?.[0]?.short).toBe("H")
  })

  it("ignores an unknown key inside a flag and does not copy it", () => {
    const { cli, warnings } = run(
      withCommand({ flags: [{ name: "x", type: "boolean", summary: "X", futureKey: 1 }] }),
    )
    expect(warnings).toEqual([])
    expect(cli?.commands?.[0]?.flags).toEqual([{ name: "x", type: "boolean", summary: "X" }])
  })

  it("drops command names that collide after `_` maps to `-`", () => {
    expectDropped(
      {
        contractVersion: 1,
        commands: [
          { name: "my_cmd", summary: "a" },
          { name: "my-cmd", summary: "b" },
        ],
      },
      /duplicate command name or alias: "my-cmd" \(same as "my_cmd"\)/,
    )
    expectDropped(
      withCommand({
        commands: [
          { name: "a-b", summary: "a" },
          { name: "c", summary: "c", aliases: ["a_b"] },
        ],
      }),
      /commands\[0\]\.commands: duplicate command name or alias: "a_b" \(same as "a-b"\)/,
    )
    // The same name at two levels is fine.
    const { warnings } = run(
      withCommand({ name: "my_cmd", commands: [{ name: "my-cmd", summary: "x" }] }),
    )
    expect(warnings).toEqual([])
  })

  it("keeps group and global strict: null and false also drop (R-26)", () => {
    expectDropped(withCommand({ group: null }), /group is for built-in commands only/)
    expectDropped(
      withCommand({ flags: [{ name: "x", type: "boolean", summary: "X", global: false }] }),
      /global is for built-in flags only/,
    )
    expectDropped(
      withCommand({ flags: [{ name: "x", type: "boolean", summary: "X", global: null }] }),
      /global is for built-in flags only/,
    )
  })

  it("drops a bad handler entry", () => {
    expectDropped(
      withCommand({ handler: "./x.ts" }),
      /cli\.commands\[0\]\.handler: handler must be/,
    )
    expectDropped(
      withCommand({ handler: { type: "module" } }),
      /handler: path is required for module handler/,
    )
    expectDropped(
      withCommand({ handler: { type: "subprocess", command: ["node", "x.js"] } }),
      /handler: command handler must be type "module"/,
    )
  })

  it("drops ESC, other control characters, and over-long text (R-3)", () => {
    expectDropped(withCommand({ summary: `${ESC}[31mred` }), /summary: control or bidi characters/)
    expectDropped(
      withCommand({ description: ["a\nb"] }),
      /description\[0\]: control or bidi characters/,
    )
    expectDropped(
      withCommand({ summary: "x".repeat(CLI_MAX_SUMMARY + 1) }),
      new RegExp(`summary: longer than ${CLI_MAX_SUMMARY} characters`),
    )
  })

  it("drops DEL, C1 (8-bit CSI included), and bidi controls (R-3)", () => {
    const bad = (code: number) => withCommand({ summary: `a${String.fromCodePoint(code)}b` })
    // DEL.
    expectDropped(bad(0x7f), /summary: control or bidi characters/)
    // C1: first, 8-bit CSI, last.
    for (const c of [0x80, 0x9b, 0x9f]) expectDropped(bad(c), /summary: control or bidi/)
    // Bidi embeddings and overrides U+202A to U+202E.
    for (const c of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e]) {
      expectDropped(bad(c), /summary: control or bidi/)
    }
    // Bidi isolates U+2066 to U+2069.
    for (const c of [0x2066, 0x2067, 0x2068, 0x2069]) {
      expectDropped(bad(c), /summary: control or bidi/)
    }
    // Bidi marks LRM, RLM, ALM.
    for (const c of [0x200e, 0x200f, 0x061c]) expectDropped(bad(c), /summary: control or bidi/)
  })

  it("keeps printable text next to the banned ranges", () => {
    // U+007E (before DEL), U+00A0 (after C1), U+00E9, U+2030 are allowed.
    for (const c of [0x7e, 0xa0, 0xe9, 0x2030]) {
      const { cli, warnings } = run(withCommand({ summary: `a${String.fromCodePoint(c)}b` }))
      expect(warnings).toEqual([])
      expect(cli?.commands?.[0]?.summary).toBe(`a${String.fromCodePoint(c)}b`)
    }
  })

  it("drops a variadic arg that is not last, and a built-in-only group", () => {
    expectDropped(
      withCommand({
        args: [
          { name: "a", summary: "A", variadic: true },
          { name: "b", summary: "B" },
        ],
      }),
      /a variadic arg must be the last/,
    )
    expectDropped(withCommand({ group: "core" }), /group is for built-in commands only/)
  })

  it("drops a block with too many commands", () => {
    const commands = Array.from({ length: CLI_MAX_COMMANDS + 1 }, (_, i) => ({
      name: `c${i}`,
      summary: "C",
    }))
    expectDropped({ contractVersion: 1, commands }, new RegExp(`more than ${CLI_MAX_COMMANDS}`))
  })

  it("counts nested commands toward the cap", () => {
    const children = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `c${i}`, summary: "C" }))
    // 1 root + 199 children = 200: at the cap, kept.
    const ok = run(withCommand({ commands: children(CLI_MAX_COMMANDS - 1) }))
    expect(ok.warnings).toEqual([])
    expect(ok.cli?.commands?.[0]?.commands).toHaveLength(CLI_MAX_COMMANDS - 1)
    // 1 root + 200 children = 201: over the cap.
    expectDropped(
      withCommand({ commands: children(CLI_MAX_COMMANDS) }),
      new RegExp(
        `commands\\[0\\]\\.commands\\[${CLI_MAX_COMMANDS - 1}\\]: more than ${CLI_MAX_COMMANDS}`,
      ),
    )
  })

  it("drops bad help sections", () => {
    expectDropped(
      {
        contractVersion: 1,
        helpSections: [
          { id: "a", title: "A" },
          { id: "a", title: "B" },
        ],
      },
      /duplicate section id: "a"/,
    )
    expectDropped(
      { contractVersion: 1, helpSections: [{ id: "a", title: "A", rows: [{ term: "t" }] }] },
      /rows\[0\]\.summary: must be a string/,
    )
  })
})

describe("parseManifest: cli block", () => {
  it("stores a valid block on the parsed manifest", () => {
    const warnings: string[] = []
    const m = parseManifest({ ...BASE, cli: validCli() }, PATH, { warn: (s) => warnings.push(s) })
    expect(warnings).toEqual([])
    expect(m.cli?.contractVersion).toBe(1)
    expect(m.cli?.commands?.[0]?.name).toBe("schedule")
  })

  it("has no cli field when the block is absent", () => {
    const m = parseManifest(BASE, PATH, { warn: () => {} })
    expect("cli" in m).toBe(false)
  })

  it("drops a bad block with a warning and still returns the manifest", () => {
    const warnings: string[] = []
    const m = parseManifest({ ...BASE, cli: { contractVersion: 99 } }, PATH, {
      warn: (s) => warnings.push(s),
    })
    expect(m.id).toBe("sched")
    expect(m.cli).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/cli block dropped .*unknown contract version 99/)
  })
})
