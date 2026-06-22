/**
 * Unit coverage for recoverable model/request error parsing.
 *
 * These predicates stay intentionally tiny and string-based because the
 * provider errors reach the REPL as rendered messages, not typed error
 * objects. The important behavior is stable recognition of known provider
 * failure shapes without false positives.
 */

import { describe, expect, it } from "bun:test"

import {
  contextLengthExceededAdvice,
  parseContextLengthExceededError,
  parseModelNotFoundError,
  parseModelUnavailableError,
} from "./model-error.ts"

describe("parseModelNotFoundError", () => {
  it("extracts the unavailable model id", () => {
    expect(
      parseModelNotFoundError(
        'API 404: {"type":"error","error":{"type":"not_found_error","message":"model: model-x"}}',
      ),
    ).toBe("model-x")
  })

  it("returns null for unrelated errors", () => {
    expect(parseModelNotFoundError("plain failure")).toBeNull()
  })
})

describe("parseModelUnavailableError", () => {
  it("returns the current model for long-context access errors", () => {
    expect(
      parseModelUnavailableError(
        "The long context beta is not yet available for this subscription.",
        "model-x",
      ),
    ).toBe("model-x")
  })

  it("returns null without a current model", () => {
    expect(
      parseModelUnavailableError(
        "The long context beta is not yet available for this subscription.",
        undefined,
      ),
    ).toBeNull()
  })
})

describe("contextLengthExceededAdvice", () => {
  it("names the current model and warns against retrying the same resume", () => {
    const advice = contextLengthExceededAdvice("model-x")
    expect(advice).toContain("model-x")
    expect(advice).toContain("failed user turn was rolled back")
    expect(advice).toContain("Resuming the same oversized transcript will fail again")
  })
})

describe("parseContextLengthExceededError", () => {
  it("recognizes a code-tagged context_length_exceeded error", () => {
    expect(
      parseContextLengthExceededError(
        "context_length_exceeded - Your input exceeds the context window of this model. Please adjust your input and try again.",
      ),
    ).toBe(true)
  })

  it("recognizes JSON-shaped context_length_exceeded errors", () => {
    expect(
      parseContextLengthExceededError(
        'API 400: {"error":{"code":"context_length_exceeded","message":"Your input exceeds the context window"}}',
      ),
    ).toBe(true)
  })

  it("recognizes plain maximum-context wording", () => {
    expect(
      parseContextLengthExceededError(
        "This model's maximum context length is 128000 tokens. Reduce the length of the messages.",
      ),
    ).toBe(true)
  })

  it("returns false for unrelated errors", () => {
    expect(parseContextLengthExceededError("network socket closed")).toBe(false)
  })
})
