import { describe, it, expect } from "bun:test"
import { parseManifest, ManifestError } from "./manifest.ts"

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
    expect(m.tuis!).toHaveLength(1)
    expect(m.tuis![0].trigger.type).toBe("tool")
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
      const tool = (m.tuis![0].trigger as { type: "tool"; tool: { aliases?: string[] } }).tool
      expect(tool.aliases).toEqual(["legacy_diff", "old_diff"])
    })

    it("treats omitted aliases field as undefined (not empty array)", () => {
      const m = parseManifest(valid, "/x")
      const tool = (m.tuis![0].trigger as { type: "tool"; tool: { aliases?: string[] } }).tool
      expect(tool.aliases).toBeUndefined()
    })

    it("treats empty aliases array as undefined", () => {
      const m = parseManifest(withAliases([]), "/x")
      const tool = (m.tuis![0].trigger as { type: "tool"; tool: { aliases?: string[] } }).tool
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
    expect(m.tuis![0].trigger).toEqual({ type: "inline_tag", tag: "diff" })
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
    if (m.tuis![0].handler.type !== "subprocess") throw new Error("wrong type")
    expect(m.tuis![0].handler.command).toEqual(["./bin/render"])
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

describe("parseManifest / liveAreaSlots", () => {
  // Minimal manifest shell: no tools/modes/events. `liveAreaSlots`
  // alone is a valid contribution shape.
  //
  // Note: the validator no longer enforces "at least one contribution"
  // (that gate moved to the loader, which has filesystem visibility for
  // the implicit PROMPT.md). See `parseManifest / no declared contributions`
  // below.
  const base = {
    id: "quota-status",
    name: "Quota Status",
    version: "0.1.0",
    description: "tests",
  }

  const goodSlot = {
    id: "quota",
    handler: { type: "module", path: "./handler.ts", export: "default" },
    position: "footer",
    refreshMs: 60_000,
    timeoutMs: 4_000,
  }

  it("parses a minimal liveAreaSlots-only manifest", () => {
    const m = parseManifest({ ...base, liveAreaSlots: [goodSlot] }, "/x")
    expect(m.liveAreaSlots).toHaveLength(1)
    expect(m.liveAreaSlots![0]!.id).toBe("quota")
    expect(m.liveAreaSlots![0]!.position).toBe("footer")
    expect(m.liveAreaSlots![0]!.refreshMs).toBe(60_000)
    expect(m.liveAreaSlots![0]!.timeoutMs).toBe(4_000)
  })

  it("accepts a manifest with NO tuis/modes/events/hooks/promptFragments when liveAreaSlots is non-empty", () => {
    expect(() => parseManifest({ ...base, liveAreaSlots: [goodSlot] }, "/x")).not.toThrow()
  })

  it("rejects liveAreaSlots that isn't an array", () => {
    expect(() => parseManifest({ ...base, liveAreaSlots: { wrong: "shape" } }, "/x")).toThrow(
      /liveAreaSlots must be an array/,
    )
  })

  it("rejects duplicate slot ids within one package", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [goodSlot, { ...goodSlot }] }, "/x"),
    ).toThrow(/duplicate live-area slot id: quota/)
  })

  it("rejects slot id with invalid characters", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...goodSlot, id: "Bad ID!" }] }, "/x"),
    ).toThrow(/live-area slot id must match/)
  })

  it("rejects unknown position values", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...goodSlot, position: "sidebar" }] }, "/x"),
    ).toThrow(/position must be "header" or "footer"/)
  })

  it("accepts position omitted (will default at resolve time)", () => {
    const slot = { ...goodSlot } as Record<string, unknown>
    delete slot.position
    const m = parseManifest({ ...base, liveAreaSlots: [slot] }, "/x")
    expect(m.liveAreaSlots![0]!.position).toBeUndefined()
  })

  it("rejects negative or non-finite refreshMs", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...goodSlot, refreshMs: -1 }] }, "/x"),
    ).toThrow(/refreshMs must be a non-negative number/)
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...goodSlot, refreshMs: "soon" }] }, "/x"),
    ).toThrow(/refreshMs/)
  })

  it("rejects negative or non-finite timeoutMs", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...goodSlot, timeoutMs: -1 }] }, "/x"),
    ).toThrow(/timeoutMs must be a non-negative number/)
  })

  it("rejects unknown keys on a slot entry", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...goodSlot, color: "red" }] }, "/x"),
    ).toThrow(/unknown live-area slot key/)
  })

  it("rejects missing handler", () => {
    const noHandler: Record<string, unknown> = { ...goodSlot }
    delete noHandler.handler
    expect(() => parseManifest({ ...base, liveAreaSlots: [noHandler] }, "/x")).toThrow()
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
          liveAreaSlots: [],
        },
        "/x",
      ),
    ).not.toThrow()
  })
})

describe("parseManifest / liveAreaSlots: placeholder + refreshOn", () => {
  const base = {
    id: "p",
    name: "p",
    version: "0.1.0",
    description: "t",
  }
  const slot = {
    id: "x",
    handler: { type: "module", path: "./h.ts", export: "default" },
  }

  it("parses placeholder when present", () => {
    const m = parseManifest(
      { ...base, liveAreaSlots: [{ ...slot, placeholder: "loading…" }] },
      "/x",
    )
    expect(m.liveAreaSlots![0]!.placeholder).toBe("loading…")
  })

  it("rejects non-string placeholder", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...slot, placeholder: 42 }] }, "/x"),
    ).toThrow(/placeholder must be a string/)
  })

  it("accepts empty-string placeholder (caller-supplied opt-out)", () => {
    const m = parseManifest({ ...base, liveAreaSlots: [{ ...slot, placeholder: "" }] }, "/x")
    expect(m.liveAreaSlots![0]!.placeholder).toBe("")
  })

  it("parses refreshOn array of event names", () => {
    const m = parseManifest(
      { ...base, liveAreaSlots: [{ ...slot, refreshOn: ["a.b", "c.d"] }] },
      "/x",
    )
    expect(m.liveAreaSlots![0]!.refreshOn).toEqual(["a.b", "c.d"])
  })

  it("rejects refreshOn that isn't an array", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...slot, refreshOn: "single" }] }, "/x"),
    ).toThrow(/refreshOn must be an array/)
  })

  it("rejects empty-string event names", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...slot, refreshOn: [""] }] }, "/x"),
    ).toThrow(/non-empty string event name/)
  })

  it("rejects event names with whitespace", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...slot, refreshOn: ["evt with space"] }] }, "/x"),
    ).toThrow(/must not contain whitespace/)
  })

  it("rejects duplicate event names within refreshOn", () => {
    expect(() =>
      parseManifest({ ...base, liveAreaSlots: [{ ...slot, refreshOn: ["a", "a"] }] }, "/x"),
    ).toThrow(/duplicate event name/)
  })

  it("accepts empty refreshOn array (== timer-only)", () => {
    const m = parseManifest({ ...base, liveAreaSlots: [{ ...slot, refreshOn: [] }] }, "/x")
    expect(m.liveAreaSlots![0]!.refreshOn).toEqual([])
  })
})
