/**
 * Tests for {@link LspClient} and its helpers. The client itself spawns a real
 * child process, so the full integration lives in the provider's integration
 * test. Here we test the pure `languageIdFor` mapping in isolation.
 */
import { describe, expect, it } from "bun:test"

import { languageIdFor } from "./lsp-client.ts"

describe("languageIdFor", () => {
  it("maps .swift to swift", () => {
    expect(languageIdFor("/project/Sources/App/ContentView.swift")).toBe("swift")
  })

  it("maps .h to objective-c", () => {
    expect(languageIdFor("/project/MyApp/MyView.h")).toBe("objective-c")
  })

  it("maps .m to objective-c", () => {
    expect(languageIdFor("/project/MyApp/MyView.m")).toBe("objective-c")
  })

  it("maps .mm to objective-cpp", () => {
    expect(languageIdFor("/project/MyApp/MyView.mm")).toBe("objective-cpp")
  })

  it("maps .ts to typescript", () => {
    expect(languageIdFor("/project/src/app.ts")).toBe("typescript")
  })

  it("maps .tsx to typescriptreact", () => {
    expect(languageIdFor("/project/src/app.tsx")).toBe("typescriptreact")
  })

  it("maps .js to javascript", () => {
    expect(languageIdFor("/project/src/app.js")).toBe("javascript")
  })

  it("maps .jsx to javascriptreact", () => {
    expect(languageIdFor("/project/src/app.jsx")).toBe("javascriptreact")
  })

  it("defaults unknown extensions to typescript", () => {
    expect(languageIdFor("/project/foo.css")).toBe("typescript")
  })
})
