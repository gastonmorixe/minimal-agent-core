import { describe, expect, it } from "bun:test"

import { splitFlatManifest } from "../test-utils/split-manifest.ts"

import {
  ManifestError,
  type ParseManifestOptions,
  ProvidesEntryInvalidError,
  ProvidesNotArrayError,
  parseManifest as parseSplit,
  RequiredNotBooleanError,
  ReservedPluginIdError,
} from "./manifest.ts"

/** Parse a fixture written in the short flat form (see `splitFlatManifest`). */
const parseManifest = (raw: unknown, path: string, opts?: ParseManifestOptions) =>
  parseSplit(splitFlatManifest(raw), path, opts)

describe("parseManifest", () => {
  const valid = {
    id: "diff-view",
    name: "Diff Viewer",
    version: "0.1.0",
    description: "Renders diffs",
    tuis: [
      {
        id: "show_diff",
        trigger: {
          type: "tool",
          tool: {
            name: "show_diff",
            description: "Open the diff viewer",
            input_schema: { type: "object", properties: {} },
          },
        },
        handler: { type: "module", path: "./handlers/show_diff.ts" },
        interactive: true,
      },
    ],
  }

  it("parses a minimal valid manifest", () => {
    const m = parseManifest(valid, "/fake/diff-view/manifest.json")
    expect(m.id).toBe("diff-view")
    expect(m.tools!).toHaveLength(1)
    expect(m.tools![0].trigger.type).toBe("tool")
  })

  describe("capabilities", () => {
    it("defaults to [] when omitted", () => {
      const m = parseManifest(valid, "/fake/manifest.json")
      expect(m.capabilities).toEqual([])
    })

    it("accepts known capability tokens", () => {
      const m = parseManifest(
        { ...valid, capabilities: ["sessions:read", "blobs:read", "clock"] },
        "/fake/manifest.json",
      )
      expect(m.capabilities).toEqual(["sessions:read", "blobs:read", "clock"])
    })

    it("rejects unknown capability tokens", () => {
      expect(() =>
        parseManifest({ ...valid, capabilities: ["filesystem:write"] }, "/fake/manifest.json"),
      ).toThrow(ManifestError)
    })

    it("rejects duplicate capability tokens", () => {
      expect(() =>
        parseManifest(
          { ...valid, capabilities: ["sessions:read", "sessions:read"] },
          "/fake/manifest.json",
        ),
      ).toThrow(/duplicate capability/)
    })

    it("rejects non-array capabilities", () => {
      expect(() =>
        parseManifest({ ...valid, capabilities: "sessions:read" }, "/fake/manifest.json"),
      ).toThrow(ManifestError)
    })
  })

  it("rejects missing top-level id", () => {
    const bad = { ...valid, id: undefined }
    expect(() => parseManifest(bad, "/x")).toThrow(ManifestError)
  })

  it("rejects missing name, version, description", () => {
    for (const key of ["name", "version", "description"] as const) {
      const bad = { ...valid, [key]: undefined }
      expect(() => parseManifest(bad, "/x")).toThrow(ManifestError)
    }
  })

  it("rejects id with invalid characters", () => {
    const bad = { ...valid, id: "Diff View!" }
    expect(() => parseManifest(bad, "/x")).toThrow(/id/i)
  })

  it("accepts an empty tuis array (it's just a no-op contribution)", () => {
    // Previously this threw because the validator enforced "at least one
    // contribution". That gate moved to the loader (see
    // `parseManifest / no declared contributions`). An empty `tuis: []`
    // is now just an explicit "no TUI contributions" declaration; the
    // parser accepts it and the loader handles the dead-weight case.
    const ok = { ...valid, tuis: [] }
    expect(() => parseManifest(ok, "/x")).not.toThrow()
  })

  it("rejects duplicate handler ids within a package", () => {
    const bad = {
      ...valid,
      tuis: [
        valid.tuis[0],
        { ...valid.tuis[0] }, // same id "show_diff"
      ],
    }
    expect(() => parseManifest(bad, "/x")).toThrow(/duplicate/i)
  })

  describe("enabled (author opt-out)", () => {
    it("defaults to undefined when omitted (= ENABLED)", () => {
      const m = parseManifest(valid, "/x")
      expect(m.enabled).toBeUndefined()
    })

    it("normalizes enabled=true to undefined (= ENABLED)", () => {
      // We don't carry the explicit `true` through to ManifestFile because
      // that's the default; only `false` is meaningful in the output type.
      const m = parseManifest({ ...valid, enabled: true }, "/x")
      expect(m.enabled).toBeUndefined()
    })

    it("preserves enabled=false (= DISABLED by author)", () => {
      const m = parseManifest({ ...valid, enabled: false }, "/x")
      expect(m.enabled).toBe(false)
    })

    it("rejects non-boolean enabled", () => {
      expect(() => parseManifest({ ...valid, enabled: "yes" }, "/x")).toThrow(/boolean/i)
      expect(() => parseManifest({ ...valid, enabled: 1 }, "/x")).toThrow(/boolean/i)
      expect(() => parseManifest({ ...valid, enabled: null }, "/x")).not.toThrow()
    })
  })

  describe("embeddable", () => {
    it("is undefined when omitted", () => {
      expect(parseManifest(valid, "/x").embeddable).toBeUndefined()
    })

    it("keeps true and false", () => {
      expect(parseManifest({ ...valid, embeddable: true }, "/x").embeddable).toBe(true)
      expect(parseManifest({ ...valid, embeddable: false }, "/x").embeddable).toBe(false)
    })

    it("rejects a non-boolean value with a ManifestError", () => {
      for (const bad of ["yes", 1, null]) {
        expect(() => parseManifest({ ...valid, embeddable: bad }, "/x")).toThrow(ManifestError)
      }
    })
  })

  describe("platforms (whitelist)", () => {
    it("defaults to undefined when omitted (= all platforms)", () => {
      const m = parseManifest(valid, "/x")
      expect(m.platforms).toBeUndefined()
    })

    it("accepts a canonical platform whitelist", () => {
      const m = parseManifest({ ...valid, platforms: ["macos"] }, "/x")
      expect(m.platforms).toEqual(["macos"])
    })

    it("accepts all three canonical buckets", () => {
      const m = parseManifest({ ...valid, platforms: ["macos", "linux", "windows"] }, "/x")
      expect(m.platforms).toEqual(["macos", "linux", "windows"])
    })

    it("treats an empty array as undefined (= all platforms)", () => {
      const m = parseManifest({ ...valid, platforms: [] }, "/x")
      expect(m.platforms).toBeUndefined()
    })

    it("rejects a non-array platforms", () => {
      expect(() => parseManifest({ ...valid, platforms: "macos" }, "/x")).toThrow(/array/i)
    })

    it("rejects unknown platform names (aliases not allowed in manifests)", () => {
      expect(() => parseManifest({ ...valid, platforms: ["darwin"] }, "/x")).toThrow(ManifestError)
      expect(() => parseManifest({ ...valid, platforms: ["bsd"] }, "/x")).toThrow(/macos/i)
    })

    it("rejects duplicate platform entries", () => {
      expect(() => parseManifest({ ...valid, platforms: ["macos", "macos"] }, "/x")).toThrow(
        /duplicate/i,
      )
    })

    it("accepts a tool-level platforms whitelist", () => {
      const m = parseManifest(
        {
          ...valid,
          tuis: [{ ...valid.tuis[0], platforms: ["macos"] }],
        },
        "/x",
      )
      expect(m.tools![0].platforms).toEqual(["macos"])
    })

    it("rejects an unknown tool-level platform", () => {
      expect(() =>
        parseManifest({ ...valid, tuis: [{ ...valid.tuis[0], platforms: ["plan9"] }] }, "/x"),
      ).toThrow(ManifestError)
    })
  })

  it("rejects unknown trigger.type", () => {
    const bad = {
      ...valid,
      tuis: [
        {
          ...valid.tuis[0],
          trigger: { type: "webhook", url: "http://x" },
        },
      ],
    }
    expect(() => parseManifest(bad, "/x")).toThrow(/trigger/i)
  })

  it("rejects tool trigger without tool.name", () => {
    const bad = {
      ...valid,
      tuis: [
        {
          ...valid.tuis[0],
          trigger: {
            type: "tool",
            tool: { description: "nope", input_schema: {} },
          },
        },
      ],
    }
    expect(() => parseManifest(bad, "/x")).toThrow(/tool\.name/i)
  })

  describe("tool aliases", () => {
    function withAliases(aliases: unknown) {
      return {
        ...valid,
        tuis: [
          {
            ...valid.tuis[0],
            trigger: {
              type: "tool",
              tool: { ...valid.tuis[0].trigger.tool, aliases },
            },
          },
        ],
      }
    }

    it("parses a manifest with valid aliases", () => {
      const m = parseManifest(withAliases(["legacy_diff", "old_diff"]), "/x")
      const tool = (m.tools![0].trigger as { type: "tool"; tool: { aliases?: string[] } }).tool
      expect(tool.aliases).toEqual(["legacy_diff", "old_diff"])
    })

    it("treats omitted aliases field as undefined (not empty array)", () => {
      const m = parseManifest(valid, "/x")
      const tool = (m.tools![0].trigger as { type: "tool"; tool: { aliases?: string[] } }).tool
      expect(tool.aliases).toBeUndefined()
    })

    it("treats empty aliases array as undefined", () => {
      const m = parseManifest(withAliases([]), "/x")
      const tool = (m.tools![0].trigger as { type: "tool"; tool: { aliases?: string[] } }).tool
      expect(tool.aliases).toBeUndefined()
    })

    it("rejects non-array aliases", () => {
      expect(() => parseManifest(withAliases("legacy_diff"), "/x")).toThrow(
        /aliases must be an array/,
      )
    })

    it("rejects non-string alias entry", () => {
      expect(() => parseManifest(withAliases(["ok", 42]), "/x")).toThrow(
        /aliases\[1\].*non-empty string/,
      )
    })

    it("rejects empty-string alias entry", () => {
      expect(() => parseManifest(withAliases(["ok", ""]), "/x")).toThrow(
        /aliases\[1\].*non-empty string/,
      )
    })

    it("rejects alias equal to canonical tool name", () => {
      // canonical is "show_diff"
      expect(() => parseManifest(withAliases(["show_diff"]), "/x")).toThrow(/duplicates tool\.name/)
    })

    it("rejects duplicate aliases within the array", () => {
      expect(() => parseManifest(withAliases(["a", "b", "a"]), "/x")).toThrow(
        /aliases\[2\].*duplicated/,
      )
    })
  })

  describe("tool.mayReturnBinary", () => {
    it("parses true and surfaces on the tool trigger", () => {
      const raw = structuredClone(valid)
      ;(raw.tuis[0].trigger.tool as { mayReturnBinary?: boolean }).mayReturnBinary = true
      const m = parseManifest(raw, "/x")
      const tool = (m.tools![0].trigger as { type: "tool"; tool: { mayReturnBinary?: boolean } })
        .tool
      expect(tool.mayReturnBinary).toBe(true)
    })

    it("treats omitted field as undefined", () => {
      const m = parseManifest(valid, "/x")
      const tool = (m.tools![0].trigger as { type: "tool"; tool: { mayReturnBinary?: boolean } })
        .tool
      expect(tool.mayReturnBinary).toBeUndefined()
    })

    it("rejects non-boolean", () => {
      const raw = structuredClone(valid)
      ;(raw.tuis[0].trigger.tool as { mayReturnBinary?: unknown }).mayReturnBinary = "yes"
      expect(() => parseManifest(raw, "/x")).toThrow(/mayReturnBinary must be a boolean/)
    })
  })

  it("parses inline_tag trigger", () => {
    const m = parseManifest(
      {
        ...valid,
        tuis: [
          {
            id: "inline",
            trigger: { type: "inline_tag", tag: "diff" },
            handler: { type: "module", path: "./h.ts" },
            interactive: false,
          },
        ],
      },
      "/x",
    )
    expect(m.tools![0].trigger).toEqual({ type: "inline_tag", tag: "diff" })
  })

  it("rejects inline_tag with invalid tag name", () => {
    const bad = {
      ...valid,
      tuis: [
        {
          id: "inline",
          trigger: { type: "inline_tag", tag: "Bad Tag!" },
          handler: { type: "module", path: "./h.ts" },
          interactive: false,
        },
      ],
    }
    expect(() => parseManifest(bad, "/x")).toThrow(/tag/i)
  })

  it("rejects unknown handler.type", () => {
    const bad = {
      ...valid,
      tuis: [
        {
          ...valid.tuis[0],
          handler: { type: "magic", path: "./x" },
        },
      ],
    }
    expect(() => parseManifest(bad, "/x")).toThrow(/handler\.type/i)
  })

  it("rejects module handler without path", () => {
    const bad = {
      ...valid,
      tuis: [
        {
          ...valid.tuis[0],
          handler: { type: "module" },
        },
      ],
    }
    expect(() => parseManifest(bad, "/x")).toThrow(/path/i)
  })

  it("rejects subprocess handler without command", () => {
    const bad = {
      ...valid,
      tuis: [
        {
          ...valid.tuis[0],
          handler: { type: "subprocess", command: [] },
        },
      ],
    }
    expect(() => parseManifest(bad, "/x")).toThrow(/command/i)
  })

  it("accepts subprocess handler with command", () => {
    const m = parseManifest(
      {
        ...valid,
        tuis: [
          {
            ...valid.tuis[0],
            handler: { type: "subprocess", command: ["./bin/render"] },
          },
        ],
      },
      "/x",
    )
    if (m.tools![0].handler.type !== "subprocess") throw new Error("wrong type")
    expect(m.tools![0].handler.command).toEqual(["./bin/render"])
  })

  it("requires interactive to be a boolean", () => {
    const bad = {
      ...valid,
      tuis: [{ ...valid.tuis[0], interactive: "yes" }],
    }
    expect(() => parseManifest(bad, "/x")).toThrow(/interactive/i)
  })

  it("ManifestError exposes the manifest path", () => {
    try {
      parseManifest({ ...valid, id: undefined }, "/abs/path/manifest.json")
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError)
      expect((e as ManifestError).manifestPath).toBe("/abs/path/manifest.json")
    }
  })
})

describe("parseManifest / hooks", () => {
  const base = {
    id: "p",
    name: "P",
    version: "1.0.0",
    description: "x",
  }
  const goodHook = {
    id: "h1",
    channel: "turn.didEnd",
    handler: { type: "module", path: "./hook.ts" },
  }

  it("accepts a manifest with only hooks", () => {
    const m = parseManifest({ ...base, hooks: [goodHook] }, "/x")
    expect(m.hooks).toEqual([
      {
        id: "h1",
        channel: "turn.didEnd",
        handler: { type: "module", path: "./hook.ts", export: "default" },
        priority: undefined,
        observeOnly: undefined,
        timeoutMs: undefined,
      },
    ])
  })

  it("requires hooks to be an array", () => {
    expect(() => parseManifest({ ...base, hooks: "x", tuis: [] }, "/x")).toThrow(/array/)
  })

  it("accepts failClosed: true on a hook", () => {
    const m = parseManifest({ ...base, hooks: [{ ...goodHook, failClosed: true }] }, "/x")
    expect(m.hooks?.[0]?.failClosed).toBe(true)
  })

  it("rejects a non-boolean failClosed", () => {
    expect(() =>
      parseManifest({ ...base, hooks: [{ ...goodHook, failClosed: "yes" }] }, "/x"),
    ).toThrow(/failClosed must be a boolean/)
  })

  it("rejects failClosed together with observeOnly", () => {
    expect(() =>
      parseManifest(
        { ...base, hooks: [{ ...goodHook, failClosed: true, observeOnly: true }] },
        "/x",
      ),
    ).toThrow(/failClosed/)
  })

  it("rejects unknown hook keys", () => {
    expect(() => parseManifest({ ...base, hooks: [{ ...goodHook, weird: 1 }] }, "/x")).toThrow(
      /unknown hook subscription key/,
    )
  })

  it("rejects duplicate hook ids", () => {
    expect(() => parseManifest({ ...base, hooks: [goodHook, goodHook] }, "/x")).toThrow(/duplicate/)
  })

  it("rejects negative timeoutMs", () => {
    expect(() => parseManifest({ ...base, hooks: [{ ...goodHook, timeoutMs: -1 }] }, "/x")).toThrow(
      /non-negative/,
    )
  })

  it("accepts permissions and requiresUnsafeHooks", () => {
    const m = parseManifest(
      {
        ...base,
        hooks: [goodHook],
        permissions: ["hooks:turn.*"],
        requiresUnsafeHooks: true,
      },
      "/x",
    )
    expect(m.permissions).toEqual(["hooks:turn.*"])
    expect(m.requiresUnsafeHooks).toBe(true)
  })

  it("rejects non-string permission entries", () => {
    expect(() => parseManifest({ ...base, hooks: [goodHook], permissions: [42] }, "/x")).toThrow(
      /permissions/,
    )
  })
})

describe("parseManifest / split form (S31)", () => {
  const base = { id: "split", name: "split", version: "0.1.0", description: "tests" }
  const tool = {
    id: "t",
    trigger: {
      type: "tool",
      tool: { name: "T", description: "t", input_schema: { type: "object", properties: {} } },
    },
    handler: { type: "module", path: "./t.ts", export: "default" },
    interactive: false,
  }

  it("reads tools from the headless block", () => {
    const m = parseManifest({ ...base, headless: { tools: [tool] } }, "/x")
    expect(m.tools?.map((t) => t.id)).toEqual(["t"])
  })

  it("ignores the ui block: no validation, nothing in the result", () => {
    const m = parseManifest(
      { ...base, headless: {}, ui: { liveAreaSlots: [{ not: "validated" }], anything: 1 } },
      "/x",
    )
    expect(m.tools).toEqual([])
    expect(m.declaresUi).toBe(true)
    expect(m).not.toHaveProperty("ui")
  })

  it("moves a legacy flat liveAreaSlots array to the ui part, unvalidated", () => {
    const m = parseManifest({ ...base, liveAreaSlots: [{ wrong: "shape" }] }, "/x")
    expect(m.declaresUi).toBe(true)
  })

  it("rejects flat contributions next to a headless block", () => {
    expect(() => parseManifest({ ...base, headless: {}, hooks: [] }, "/x")).toThrow(
      /flat manifest keys are not supported since S41: hooks/,
    )
  })

  it("rejects a flat manifest (S41)", () => {
    expect(() => parseSplit({ ...base, tuis: [] }, "/x")).toThrow(
      /flat manifest keys are not supported since S41: tuis/,
    )
    expect(() => parseSplit({ ...base, liveAreaSlots: [] }, "/x")).toThrow(
      /flat manifest keys are not supported since S41: liveAreaSlots/,
    )
  })

  it("rejects a headless or ui block that is not an object", () => {
    expect(() => parseManifest({ ...base, headless: [] }, "/x")).toThrow(
      /headless must be an object/,
    )
    expect(() => parseManifest({ ...base, ui: "x" }, "/x")).toThrow(/ui must be an object/)
  })

  it("reports a mode with both color and style through the warn option", () => {
    const warnings: string[] = []
    parseManifest(
      {
        ...base,
        headless: {
          modes: [{ id: "m", label: "M", color: "sky", style: { label: { fg: "sky" } } }],
        },
      },
      "/x",
      { warn: (msg) => warnings.push(msg) },
    )
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("`style` takes precedence")
  })
})

describe("parseManifest / prompt field", () => {
  // The top-level `prompt` field is OPTIONAL and only used when a plugin
  // wants a non-default PROMPT.md path. The default (`./PROMPT.md`) is
  // resolved by the loader at load time without any manifest declaration.
  // A plugin whose entire value is a system-prompt fragment (writing-style
  // discipline, coding-conventions doc) just ships a `PROMPT.md` next to
  // its `manifest.json` and is done.
  const base = {
    id: "ma-agent-writing-style",
    name: "Agent Writing Style",
    version: "0.1.0",
    description: "tests",
  }

  it("accepts an explicit prompt path (e.g. when the file isn't named PROMPT.md)", () => {
    expect(() => parseManifest({ ...base, prompt: "./STYLE.md" }, "/x")).not.toThrow()
  })

  it("preserves the explicit prompt path on the parsed result", () => {
    const m = parseManifest({ ...base, prompt: "./STYLE.md" }, "/x")
    expect(m.prompt).toBe("./STYLE.md")
  })

  it("rejects an empty-string prompt", () => {
    expect(() => parseManifest({ ...base, prompt: "" }, "/x")).toThrow(/non-empty string/i)
  })

  it("rejects a whitespace-only prompt", () => {
    expect(() => parseManifest({ ...base, prompt: "   " }, "/x")).toThrow(/non-empty string/i)
  })

  it("rejects a non-string prompt", () => {
    expect(() => parseManifest({ ...base, prompt: 42 }, "/x")).toThrow(/prompt must be a string/i)
  })

  it("accepts a manifest with NO prompt field (the default ./PROMPT.md is implicit)", () => {
    const m = parseManifest({ ...base }, "/x")
    expect(m.prompt).toBeUndefined()
  })
})

describe("parseManifest / promptFragments placement", () => {
  const base = {
    id: "p",
    name: "p",
    version: "0.1.0",
    description: "t",
  }
  const handler = { type: "module", path: "./h.ts", export: "default" }

  it("defaults placement to undefined (sessionContext at runtime)", () => {
    const m = parseManifest({ ...base, promptFragments: [{ id: "f1", handler }] }, "/x")
    expect(m.promptFragments![0]!.placement).toBeUndefined()
  })

  it("accepts placement sessionContext and afterInstructions", () => {
    const m = parseManifest(
      {
        ...base,
        promptFragments: [
          { id: "a", handler, placement: "sessionContext" },
          { id: "b", handler, placement: "afterInstructions", order: 10 },
        ],
      },
      "/x",
    )
    expect(m.promptFragments![0]!.placement).toBe("sessionContext")
    expect(m.promptFragments![1]!.placement).toBe("afterInstructions")
    expect(m.promptFragments![1]!.order).toBe(10)
  })

  it("rejects unknown placement values", () => {
    expect(() =>
      parseManifest(
        {
          ...base,
          promptFragments: [{ id: "f1", handler, placement: "beforeIdentity" }],
        },
        "/x",
      ),
    ).toThrow(/placement must be "sessionContext" or "afterInstructions"/)
  })
})

describe("parseManifest / no declared contributions", () => {
  // The validator no longer enforces "manifest must declare at least one
  // contribution". The reason: PROMPT.md is implicit (looked up by the
  // loader on disk) and the manifest can't see the filesystem. If a plugin
  // declares no fields AND ships no PROMPT.md, the LOADER warns at load
  // time. The validator's job is purely syntactic shape checking.
  const base = {
    id: "minimal",
    name: "minimal",
    version: "0.1.0",
    description: "tests",
  }

  it("accepts a manifest with no contribution fields whatsoever", () => {
    expect(() => parseManifest({ ...base }, "/x")).not.toThrow()
  })

  it("accepts a manifest with all contribution fields explicitly empty", () => {
    expect(() =>
      parseManifest(
        {
          ...base,
          tuis: [],
          modes: [],
          events: [],
          hooks: [],
          promptFragments: [],
        },
        "/x",
      ),
    ).not.toThrow()
  })
})

describe("parseManifest / reserved plugin id", () => {
  const base = { name: "P", version: "0.1.0", description: "tests" }

  it("rejects the reserved id `prompts`", () => {
    expect(() => parseManifest({ ...base, id: "prompts" }, "/fake/prompts/manifest.json")).toThrow(
      ManifestError,
    )
  })

  it("the reserved-id error explains the config key and names an alternative", () => {
    let caught: unknown
    try {
      parseManifest({ ...base, id: "prompts" }, "/fake/prompts/manifest.json")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ReservedPluginIdError)
    const err = caught as ReservedPluginIdError
    expect(err.reservedId).toBe("prompts")
    expect(err.name).toBe("ReservedPluginIdError")
    expect(err.manifestPath).toBe("/fake/prompts/manifest.json")
    expect(err.message).toContain("plugins.prompts")
    expect(err.message).toContain("reserved")
    expect(err.message).toContain("prompts-extra")
  })

  it("a normal id is unaffected", () => {
    expect(parseManifest({ ...base, id: "prompts-extra" }, "/fake/m.json").id).toBe("prompts-extra")
  })
})

describe("parseManifest / required and provides", () => {
  const base = { id: "p", name: "P", version: "0.1.0", description: "tests" }
  const path = "/fake/p/manifest.json"
  const catchErr = (raw: unknown): ManifestError => {
    try {
      parseManifest(raw, path)
    } catch (e) {
      return e as ManifestError
    }
    throw new Error("expected throw")
  }

  it("reads required true and provides", () => {
    const m = parseManifest({ ...base, required: true, provides: ["a.b"] }, path)
    expect(m.required).toBe(true)
    expect(m.provides).toEqual(["a.b"])
  })

  it("leaves required and provides undefined when absent or empty", () => {
    const m = parseManifest({ ...base, required: false, provides: [] }, path)
    expect(m.required).toBeUndefined()
    expect(m.provides).toBeUndefined()
  })

  it("required that is not a boolean throws RequiredNotBooleanError", () => {
    const e = catchErr({ ...base, required: "yes" })
    expect(e).toBeInstanceOf(RequiredNotBooleanError)
    expect(e.message).toBe("")
    expect((e as RequiredNotBooleanError).kind).toBe("RequiredNotBooleanError")
    expect(e.manifestPath).toBe(path)
  })

  it("provides that is not an array throws ProvidesNotArrayError", () => {
    const e = catchErr({ ...base, provides: "a.b" })
    expect(e).toBeInstanceOf(ProvidesNotArrayError)
    expect(e.message).toBe("")
    expect((e as ProvidesNotArrayError).kind).toBe("ProvidesNotArrayError")
  })

  it("a non-string or empty provides entry throws ProvidesEntryInvalidError", () => {
    for (const [bad, index] of [
      [[1], 0],
      [["ok", ""], 1],
    ] as const) {
      const e = catchErr({ ...base, provides: bad })
      expect(e).toBeInstanceOf(ProvidesEntryInvalidError)
      expect(e.message).toBe("")
      expect((e as ProvidesEntryInvalidError).kind).toBe("ProvidesEntryInvalidError")
      expect((e as ProvidesEntryInvalidError).index).toBe(index)
    }
  })
})
