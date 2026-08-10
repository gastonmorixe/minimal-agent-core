import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"
import type { Subprocess } from "bun"

import {
  createMdstreamCodeHighlighter,
  isMdstreamFormatter,
  MdstreamCodeHighlighter,
  type MdstreamHighlightSpawn,
} from "./mdstream-code-highlighter.ts"

const FAKE_SERVER = join(import.meta.dir, "fake-mdstream-highlight-server.ts")

type HighlightProcess = Subprocess<"pipe", "pipe", "pipe">

function fakeSpawn(mode: string, starts?: string[]): MdstreamHighlightSpawn {
  return (argv) => {
    starts?.push(argv.join(" "))
    return Bun.spawn([process.execPath, FAKE_SERVER, mode], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }) as HighlightProcess
  }
}

describe("MdstreamCodeHighlighter", () => {
  it("can warm eagerly and appends --highlight-server to formatter argv", async () => {
    const starts: string[] = []
    const highlighter = new MdstreamCodeHighlighter(["/opt/bin/mdstream", "--theme", "mdstream"], {
      spawn: fakeSpawn("normal", starts),
      timeoutMs: 500,
    })

    expect(starts).toEqual([])
    expect(await highlighter.warmup()).toBe(true)
    expect(starts).toEqual(["/opt/bin/mdstream --theme mdstream --highlight-server"])
    expect(await highlighter.highlight({ language: "typescript", code: "const x = 1" })).toBe(
      "ANSI[typescript:const x = 1]",
    )
    expect(starts).toEqual(["/opt/bin/mdstream --theme mdstream --highlight-server"])
    await highlighter.close()
  })

  it("uses unified-diff mode only when protocol v2 advertises the capability", async () => {
    const starts: string[] = []
    const highlighter = new MdstreamCodeHighlighter(["mdstream"], {
      spawn: fakeSpawn("protocol-v2", starts),
      timeoutMs: 500,
    })

    expect(
      await highlighter.highlightUnifiedDiff({
        language: "typescript",
        code: "--- a/x.ts\n+++ b/x.ts\n-old()\n+newCall()",
        diffStyle: "marker-fg",
        colors: { inserted: "#00ff00", deleted: "#ff0000" },
      }),
    ).toBe("DIFF[typescript:marker-fg:#00ff00:#ff0000:--- a/x.ts\n+++ b/x.ts\n-old()\n+newCall()]")
    expect(starts).toEqual(["mdstream --highlight-server"])
    await highlighter.close()
  })

  it("rejects unbalanced native diff ANSI without disabling raw highlight", async () => {
    const highlighter = new MdstreamCodeHighlighter(["mdstream"], {
      spawn: fakeSpawn("protocol-unbalanced"),
      timeoutMs: 500,
    })

    expect(
      await highlighter.highlightUnifiedDiff({ language: "rust", code: "-old\n+new" }),
    ).toBeNull()
    expect(await highlighter.highlight({ language: "rust", code: "fn main() {}" })).toBe(
      "ANSI[rust:fn main() {}]",
    )
    await highlighter.close()
  })

  it("keeps the sidecar alive after a correlated unified-diff error", async () => {
    const highlighter = new MdstreamCodeHighlighter(["mdstream"], {
      spawn: fakeSpawn("protocol-error"),
      timeoutMs: 500,
    })

    expect(
      await highlighter.highlightUnifiedDiff({ language: "rust", code: "-old\n+new" }),
    ).toBeNull()
    expect(await highlighter.highlight({ language: "rust", code: "fn main() {}" })).toBe(
      "ANSI[rust:fn main() {}]",
    )
    await highlighter.close()
  })

  it("returns null for native unified diff on a v1 server without disabling raw highlight", async () => {
    const highlighter = new MdstreamCodeHighlighter(["mdstream"], {
      spawn: fakeSpawn("normal"),
      timeoutMs: 500,
    })

    expect(
      await highlighter.highlightUnifiedDiff({ language: "rust", code: "-old\n+new" }),
    ).toBeNull()
    expect(await highlighter.highlight({ language: "rust", code: "fn main() {}" })).toBe(
      "ANSI[rust:fn main() {}]",
    )
    await highlighter.close()
  })

  it("reassembles split handshake and response chunks", async () => {
    const highlighter = new MdstreamCodeHighlighter(["mdstream"], {
      spawn: fakeSpawn("split"),
      timeoutMs: 500,
    })

    expect(await highlighter.highlight({ language: "rust", code: "fn main() {}" })).toBe(
      "ANSI[rust:fn main() {}]",
    )
    await highlighter.close()
  })

  it("serializes concurrent calls and matches responses by id", async () => {
    const highlighter = new MdstreamCodeHighlighter(["mdstream"], {
      spawn: fakeSpawn("split"),
      timeoutMs: 500,
    })

    const results = await Promise.all([
      highlighter.highlight({ language: "python", code: "print(1)" }),
      highlighter.highlight({ language: "go", code: "package main" }),
      highlighter.highlight({ language: "sql", code: "select 1" }),
    ])

    expect(results).toEqual([
      "ANSI[python:print(1)]",
      "ANSI[go:package main]",
      "ANSI[sql:select 1]",
    ])
    await highlighter.close()
  })

  it("fails closed on timeout, malformed responses, bad handshake, and child exit", async () => {
    for (const mode of ["timeout", "malformed", "bad-ready", "exit"]) {
      const highlighter = new MdstreamCodeHighlighter(["mdstream"], {
        spawn: fakeSpawn(mode),
        timeoutMs: 30,
      })
      expect(await highlighter.highlight({ language: "javascript", code: "let x" })).toBeNull()
      expect(await highlighter.highlight({ language: "javascript", code: "let y" })).toBeNull()
      await highlighter.close()
    }
  })

  it("starts only when the executable basename is exactly mdstream", async () => {
    expect(isMdstreamFormatter(["mdstream"])).toBe(true)
    expect(isMdstreamFormatter(["/usr/local/bin/mdstream", "--theme", "dracula"])).toBe(true)
    expect(isMdstreamFormatter(["C:\\tools\\mdstream"])).toBe(true)
    expect(isMdstreamFormatter(["mdstream.exe"])).toBe(true)
    expect(isMdstreamFormatter(["bun", "mdstream.ts"])).toBe(false)
    expect(isMdstreamFormatter(["my-mdstream"])).toBe(false)
    expect(createMdstreamCodeHighlighter(["bat", "--color=always"])).toBeNull()

    let spawned = false
    const highlighter = new MdstreamCodeHighlighter(["bat"], {
      spawn: () => {
        spawned = true
        throw new Error("must not spawn")
      },
    })
    expect(await highlighter.highlight({ language: "typescript", code: "const x = 1" })).toBeNull()
    expect(spawned).toBe(false)
  })

  it("accepts a real executable whose basename is mdstream", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ma-highlight-"))
    const wrapper = join(dir, "mdstream")
    try {
      await copyFile(process.execPath, wrapper)
      await chmod(wrapper, 0o755)
      const starts: string[] = []
      const highlighter = new MdstreamCodeHighlighter([wrapper], {
        spawn: fakeSpawn("normal", starts),
        timeoutMs: 500,
      })
      expect(await highlighter.highlight({ language: "json", code: "{}" })).toBe("ANSI[json:{}]")
      expect(starts[0]).toEndWith("/mdstream --highlight-server")
      await highlighter.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
