/**
 * DNS address-family preference for outbound connects.
 *
 * Bun/Node default to `verbatim` (OS order, often AAAA first). On WSL2 the
 * IPv6 path is commonly a blackhole: `fetch` / `node:http2` connect never
 * returns, so OAuth device-code polls sit on "Waiting for sign-in to finish…"
 * until the user kills the process. Prefer IPv4 unless the operator pins
 * another order.
 *
 * This only affects Node-style `dns.lookup`. Bun's native `fetch` resolver
 * may still race AAAA. Pair with per-request `timeoutMs` / `AbortSignal`.
 *
 * @module network/dns-order
 */

import { setDefaultResultOrder } from "node:dns"

/** Values accepted by `dns.setDefaultResultOrder`. */
export type DnsResultOrder = "ipv4first" | "ipv6first" | "verbatim"

const VALID_ORDERS = new Set<DnsResultOrder>(["ipv4first", "ipv6first", "verbatim"])

/**
 * Apply the process-wide DNS result order.
 *
 * `MINIMAL_AGENT_DNS_RESULT_ORDER` may be `ipv4first` (default), `ipv6first`,
 * or `verbatim`. Unknown values fall back to `ipv4first`.
 */
export function applyPreferredDnsResultOrder(env: NodeJS.ProcessEnv = process.env): DnsResultOrder {
  const raw = env.MINIMAL_AGENT_DNS_RESULT_ORDER?.trim().toLowerCase()
  const order: DnsResultOrder = VALID_ORDERS.has(raw as DnsResultOrder)
    ? (raw as DnsResultOrder)
    : "ipv4first"
  setDefaultResultOrder(order)
  return order
}
