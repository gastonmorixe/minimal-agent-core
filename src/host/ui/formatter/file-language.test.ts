import { describe, expect, it } from "bun:test"

import { resolveFileLanguage } from "./file-language.ts"

describe("resolveFileLanguage", () => {
  it("prefers exact filenames over generic extensions", () => {
    expect(resolveFileLanguage({ path: "/repo/Dockerfile" })).toBe("dockerfile")
    expect(resolveFileLanguage({ path: "C:\\repo\\CMakeLists.txt" })).toBe("cmake")
    expect(resolveFileLanguage({ path: "vite.config.ts" })).toBe("typescript")
    expect(resolveFileLanguage({ path: "package.json" })).toBe("json")
  })

  it("normalizes common source extensions to mdstream syntax tokens", () => {
    expect(resolveFileLanguage({ path: "component.tsx" })).toBe("typescript")
    expect(resolveFileLanguage({ path: "module.mjs" })).toBe("javascript")
    expect(resolveFileLanguage({ path: "main.cc" })).toBe("cpp")
    expect(resolveFileLanguage({ path: "schema.yml" })).toBe("yaml")
    expect(resolveFileLanguage({ path: "changes.patch" })).toBe("diff")
    expect(resolveFileLanguage({ path: "docs/CHANGELOG.md" })).toBe("markdown")
    expect(resolveFileLanguage({ path: "README.md" })).toBe("markdown")
    expect(resolveFileLanguage({ path: "guide.mdx" })).toBe("markdown")
  })

  it("returns null for ambiguous prose, logs, text, and unknown extensions", () => {
    for (const path of ["README", "notes.txt", "server.log", "data.csv", "x.zzz"]) {
      expect(resolveFileLanguage({ path })).toBeNull()
    }
  })

  it("uses a shebang only after filename and extension evidence", () => {
    expect(
      resolveFileLanguage({ path: "script", content: "#!/usr/bin/env python3\nprint(1)" }),
    ).toBe("python")
    expect(resolveFileLanguage({ content: "#!/usr/bin/env -S bun run\nconsole.log(1)" })).toBe(
      "typescript",
    )
    expect(resolveFileLanguage({ path: "program.rb", content: "#!/bin/sh\nexit 0" })).toBe("ruby")
  })

  it("recognizes only unambiguous bounded first-line signatures", () => {
    expect(resolveFileLanguage({ content: '<?xml version="1.0"?>\n<root />' })).toBe("xml")
    expect(resolveFileLanguage({ content: "<?php echo 1;" })).toBe("php")
    expect(resolveFileLanguage({ content: "@echo off\necho hi" })).toBe("bat")
    expect(resolveFileLanguage({ content: "const value = 1" })).toBeNull()
    expect(resolveFileLanguage({ content: '{"key":true}' })).toBeNull()
  })
})
