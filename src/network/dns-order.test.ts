import { getDefaultResultOrder, setDefaultResultOrder } from "node:dns"

import { afterEach, describe, expect, it } from "bun:test"

import { applyPreferredDnsResultOrder } from "./dns-order.ts"

describe("applyPreferredDnsResultOrder", () => {
  const previous = getDefaultResultOrder()

  afterEach(() => {
    setDefaultResultOrder(previous)
  })

  it("defaults to ipv4first so WSL AAAA blackholes do not stall connects", () => {
    expect(applyPreferredDnsResultOrder({})).toBe("ipv4first")
    expect(getDefaultResultOrder()).toBe("ipv4first")
  })

  it("honors MINIMAL_AGENT_DNS_RESULT_ORDER when valid", () => {
    expect(applyPreferredDnsResultOrder({ MINIMAL_AGENT_DNS_RESULT_ORDER: "verbatim" })).toBe(
      "verbatim",
    )
    expect(getDefaultResultOrder()).toBe("verbatim")
    expect(applyPreferredDnsResultOrder({ MINIMAL_AGENT_DNS_RESULT_ORDER: "ipv6first" })).toBe(
      "ipv6first",
    )
    expect(getDefaultResultOrder()).toBe("ipv6first")
  })

  it("falls back to ipv4first on unknown or blank values", () => {
    expect(applyPreferredDnsResultOrder({ MINIMAL_AGENT_DNS_RESULT_ORDER: "bogus" })).toBe(
      "ipv4first",
    )
    expect(applyPreferredDnsResultOrder({ MINIMAL_AGENT_DNS_RESULT_ORDER: "  " })).toBe("ipv4first")
  })
})
