# WSL OAuth login hang

`ma login` printed the device-code URL then sat on `Waiting for sign-in to finish…`
forever on Windows WSL Ubuntu 24. Same flow worked on macOS and Raspberry Pi Ubuntu.

Author: Debra (`442480e7`). Date: 2026-09-15. Plugin poll timeouts: Nancy (`a31b4425`).

## The symptom

Device-code OAuth (Cursor, OpenAI, Grok, Muse, ClinePass) is not a localhost
callback. The host prints the verification URL, then awaits
`provider.deviceCode.complete()`. That poll is HTTPS to a public API. On WSL
the poll request never returns, so expiry clocks never tick and SIGINT is the
only way out.

## The cause

Two missing timeouts, plus WSL IPv6:

1. Bun/Node DNS defaults to `verbatim` (often AAAA first). WSL2 IPv6 is a
   common blackhole. `fetch` / `node:http2` connect never completes.
2. Device-code polls never set `timeoutMs`. HTTP/2 connect has a 15s cap, but
   a connected stream with no response hangs forever. Cursor bypasses
   `NetworkClient` and uses raw `fetch` with only `ctx.signal`.
3. The host wait after "Waiting for sign-in…" had no deadline of its own, so
   even `expiresInMs` on the challenge could not unblock a hung `complete()`.

## The fix

- Prefer IPv4 at process start (`dns.setDefaultResultOrder("ipv4first")`),
  overridable with `MINIMAL_AGENT_DNS_RESULT_ORDER`.
- Host `runOAuthLogin` now races device-code `complete()` against
  `challenge.expiresInMs` (30 min fallback). A hung provider cannot stall the
  CLI past that cap.
- HTTP/3 `buildInit` honors `timeoutMs` the same way fetch/h2 already do.

No global `NetworkClient` timeout: LLM streams would die. Per-poll timeouts
live on the provider poll requests (Cursor raw fetch, OpenAI/Grok/Meta/ClinePass
`timeoutMs`).

`--debug` / `DEBUG=1` prints one host wait line with expiry, poll interval, DNS
order, and transport. It never prints verification URLs, user codes, verifiers,
or token bodies.
