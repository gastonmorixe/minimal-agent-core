import { describe, expect, it } from "bun:test"

import { toEventUsage } from "./agent-core-helpers.ts"

describe("toEventUsage", () => {
  it("carries thinking tokens as reasoningTokens", () => {
    expect(
      toEventUsage({
        input_tokens: 2,
        output_tokens: 753,
        cache_read_input_tokens: 24778,
        cache_creation_input_tokens: 10023,
        output_tokens_details: { thinking_tokens: 315 },
      }),
    ).toEqual({
      inputTokens: 2,
      outputTokens: 753,
      cacheReadTokens: 24778,
      cacheCreationTokens: 10023,
      reasoningTokens: 315,
    })
  })

  it("leaves unreported counters absent and defaults the required ones to 0", () => {
    expect(toEventUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(toEventUsage({ input_tokens: 1, output_tokens: 2 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    })
  })
})
