/*
 * Tests for the decoration-line suffix (shared mutable holder for an
 * LSP-status badge that rides on the intercom/roster decoration row).
 */

import { afterEach, describe, expect, it } from "bun:test"

import { getDecorationSuffix, setDecorationSuffix } from "./decoration-suffix.ts"

describe("decoration-suffix", () => {
  afterEach(() => setDecorationSuffix(""))

  it("starts empty", () => {
    expect(getDecorationSuffix()).toBe("")
  })

  it("returns the value after set", () => {
    setDecorationSuffix("· ♻ sk-lsp")
    expect(getDecorationSuffix()).toBe("· ♻ sk-lsp")
  })

  it("clears when set to empty", () => {
    setDecorationSuffix("test")
    setDecorationSuffix("")
    expect(getDecorationSuffix()).toBe("")
  })

  it("overwrites previous value", () => {
    setDecorationSuffix("first")
    setDecorationSuffix("second")
    expect(getDecorationSuffix()).toBe("second")
  })
})
