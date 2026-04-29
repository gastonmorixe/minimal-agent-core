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

  it("rejects empty tuis array", () => {
    const bad = { ...valid, tuis: [] }
    expect(() => parseManifest(bad, "/x")).toThrow(/tuis/i)
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
    expect(() =>
      parseManifest({ ...base, hooks: [{ ...goodHook, weird: 1 }] }, "/x"),
    ).toThrow(/unknown hook subscription key/)
  })

  it("rejects duplicate hook ids", () => {
    expect(() =>
      parseManifest({ ...base, hooks: [goodHook, goodHook] }, "/x"),
    ).toThrow(/duplicate/)
  })

  it("rejects negative timeoutMs", () => {
    expect(() =>
      parseManifest({ ...base, hooks: [{ ...goodHook, timeoutMs: -1 }] }, "/x"),
    ).toThrow(/non-negative/)
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
    expect(() =>
      parseManifest({ ...base, hooks: [goodHook], permissions: [42] }, "/x"),
    ).toThrow(/permissions/)
  })
})
