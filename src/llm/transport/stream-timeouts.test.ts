/**
 * Tests for the watchdog limits and their env overrides.
 *
 * @module llm/transport/stream-timeouts.test
 */

import { beforeEach, describe, expect, it } from "bun:test"

import type { Diagnostics } from "../../diagnostics/hub.ts"

import {
  grownPreStreamBudget,
  HEADERS_WAIT_BODY_TIMEOUT_MS,
  isLocalEndpoint,
  isLocalHost,
  KEEPALIVE_SILENT_BLOCK_IDLE_TIMEOUT_MS,
  LOCAL_RESPONSE_HEADERS_TIMEOUT_MS,
  MAX_RESPONSE_HEADERS_TIMEOUT_MS,
  parseTimeoutEnv,
  REMOTE_RESPONSE_HEADERS_TIMEOUT_MS,
  RESPONSE_HEADERS_TIMEOUT_ENV,
  resetStreamTimeoutEnvReports,
  resolveStreamTimeouts,
  SILENT_BLOCK_IDLE_TIMEOUT_ENV,
  STREAM_IDLE_TIMEOUT_ENV,
} from "./stream-timeouts.ts"
import { DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./watchdog.ts"

/** Diagnostics fake that records `warn` calls only. */
function recordingDiagnostics(sessionId?: string): { diagnostics: Diagnostics; warns: string[] } {
  const warns: string[] = []
  const noop = (): void => {}
  const diagnostics = {
    sessionId,
    emit: noop,
    emergency: noop,
    alert: noop,
    critical: noop,
    error: noop,
    warn: (_source: string, message: string) => warns.push(message),
    notice: noop,
    info: noop,
    debug: noop,
  } as unknown as Diagnostics
  return { diagnostics, warns }
}

const REMOTE = "https://api.example.com/v1/messages"
const LOCAL = "http://localhost:11434/api/chat"

beforeEach(() => resetStreamTimeoutEnvReports())

describe("stream timeout defaults", () => {
  it("has the measured constants", () => {
    expect(KEEPALIVE_SILENT_BLOCK_IDLE_TIMEOUT_MS).toBe(90_000)
    expect(DEFAULT_SILENT_BLOCK_IDLE_TIMEOUT_MS).toBe(300_000)
    expect(REMOTE_RESPONSE_HEADERS_TIMEOUT_MS).toBe(60_000)
    expect(LOCAL_RESPONSE_HEADERS_TIMEOUT_MS).toBe(120_000)
    expect(HEADERS_WAIT_BODY_TIMEOUT_MS).toBe(120_000)
    expect(MAX_RESPONSE_HEADERS_TIMEOUT_MS).toBe(240_000)
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(30_000)
  })

  it("uses 90 s silent-block idle after a keepalive ping, else 300 s", () => {
    const t = resolveStreamTimeouts({ explicit: {}, env: {} })
    expect(t.keepaliveSilentBlockIdleTimeoutMs).toBe(90_000)
    expect(t.silentBlockIdleTimeoutMs).toBe(300_000)
  })

  it("uses 60 s pre-headers for a remote URL and 120 s for a local URL", () => {
    const t = resolveStreamTimeouts({ explicit: {}, env: {} })
    expect(t.responseHeadersTimeoutMs({ url: REMOTE })).toBe(60_000)
    expect(t.responseHeadersTimeoutMs({ url: "https://chat.example.com/v1/responses" })).toBe(
      60_000,
    )
    expect(t.responseHeadersTimeoutMs({ url: LOCAL })).toBe(120_000)
    // Before the URL is known, and for a bad URL: the remote budget.
    expect(t.responseHeadersTimeoutMs()).toBe(60_000)
    expect(t.responseHeadersTimeoutMs({ url: "not a url" })).toBe(60_000)
    expect(isLocalEndpoint(undefined)).toBe(false)
    expect(isLocalEndpoint("https://LOCALHOST/x")).toBe(true)
  })

  it("uses 120 s after the headers arrived, for remote and local", () => {
    const t = resolveStreamTimeouts({ explicit: {}, env: {} })
    expect(t.headersWaitBodyTimeoutMs()).toBe(120_000)
    expect(t.headersWaitBodyTimeoutMs({ url: REMOTE })).toBe(120_000)
    expect(t.headersWaitBodyTimeoutMs({ url: LOCAL })).toBe(120_000)
    // Never shorter than the grown pre-headers budget.
    expect(t.headersWaitBodyTimeoutMs({ url: REMOTE, retries: 2 })).toBe(240_000)
  })
})

describe("pre-stream budget grows for each pre-stream retry", () => {
  it("doubles the remote budget up to 240 s (60 → 120 → 240 s)", () => {
    const t = resolveStreamTimeouts({ explicit: {}, env: {} })
    const at = (retries: number): number => t.responseHeadersTimeoutMs({ url: REMOTE, retries })
    expect([0, 1, 2, 3, 10].map(at)).toEqual([60_000, 120_000, 240_000, 240_000, 240_000])
    expect(t.responseHeadersTimeoutMs({ url: LOCAL, retries: 1 })).toBe(240_000)
  })

  it("grows an env base the same way", () => {
    const t = resolveStreamTimeouts({
      explicit: {},
      env: { [RESPONSE_HEADERS_TIMEOUT_ENV]: "30000" },
    })
    const at = (retries: number): number => t.responseHeadersTimeoutMs({ url: REMOTE, retries })
    expect([0, 1, 2, 3, 4].map(at)).toEqual([30_000, 60_000, 120_000, 240_000, 240_000])
    // An env base above the cap stays as it is.
    const big = resolveStreamTimeouts({
      explicit: {},
      env: { [RESPONSE_HEADERS_TIMEOUT_ENV]: "600000" },
    })
    expect(big.responseHeadersTimeoutMs({ retries: 3 })).toBe(600_000)
  })

  it("keeps an explicit SendOptions value (wrap-up) fixed", () => {
    const t = resolveStreamTimeouts({ explicit: { responseHeadersTimeoutMs: 10_000 }, env: {} })
    expect(t.responseHeadersTimeoutMs({ url: REMOTE, retries: 3 })).toBe(10_000)
    expect(t.headersWaitBodyTimeoutMs({ url: REMOTE, retries: 3 })).toBe(10_000)
    expect(t.headersWaitBodyTimeoutMs({ url: LOCAL })).toBe(10_000)
  })

  it("grownPreStreamBudget clamps odd retry counts", () => {
    expect(grownPreStreamBudget(60_000, -1)).toBe(60_000)
    expect(grownPreStreamBudget(60_000, 1.7)).toBe(120_000)
    expect(grownPreStreamBudget(60_000, 1e9)).toBe(240_000)
  })
})

describe("local host detection", () => {
  const LOCAL_HOSTS = [
    "localhost",
    "LOCALHOST",
    "localhost.",
    "foo.localhost",
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.254",
    "0.0.0.0",
    "[::1]",
    "::1",
    "[::]",
    "[::ffff:127.0.0.1]",
    // The URL parser gives the hex form of a mapped address.
    "[::ffff:7f00:1]",
    "[::ffff:c0a8:105]",
    "10.0.0.2",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.5",
    "169.254.10.20",
    "100.64.0.1",
    "100.101.1.2",
    "100.127.255.255",
    "[fc00::1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "[febf::1]",
    "host.docker.internal",
    "db.corp.internal",
    "studio.local",
    "nas.lan",
    "gpu.example.internal",
    "gpu-box",
  ]
  const REMOTE_HOSTS = [
    "api.example.com",
    "example.com.",
    "8.8.8.8",
    "126.0.0.1",
    "11.0.0.1",
    "172.15.0.1",
    "172.32.0.1",
    "192.169.1.1",
    "169.253.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "[2001:db8::1]",
    "[fec0::1]",
    "[::ffff:8.8.8.8]",
    "[::ffff:808:808]",
    "localhost.example.com",
  ]

  for (const host of LOCAL_HOSTS) {
    it(`${host} is local`, () => {
      expect(isLocalHost(host)).toBe(true)
    })
  }
  for (const host of REMOTE_HOSTS) {
    it(`${host} is remote`, () => {
      expect(isLocalHost(host)).toBe(false)
    })
  }

  it("decides from URLs as the transport sees them", () => {
    for (const url of [
      "http://127.0.0.2/",
      "http://0.0.0.0:1234/",
      "http://[::ffff:127.0.0.1]/",
      "http://localhost.:8080/",
      "http://foo.localhost/",
      "http://192.168.1.5:1234/",
      "http://10.0.0.2/",
      "http://100.101.1.2/",
      "http://[fe80::1]/",
      "http://host.docker.internal:11434/",
      "http://gpu-box/v1",
    ]) {
      expect(isLocalEndpoint(url)).toBe(true)
    }
    expect(isLocalEndpoint("https://api.example.com/v1")).toBe(false)
    expect(isLocalEndpoint("https://[2001:db8::1]/v1")).toBe(false)
  })
})

describe("stream timeout env overrides", () => {
  it("uses a good env value over the default", () => {
    const t = resolveStreamTimeouts({
      explicit: {},
      env: {
        [STREAM_IDLE_TIMEOUT_ENV]: "45000",
        [SILENT_BLOCK_IDLE_TIMEOUT_ENV]: "120000",
        [RESPONSE_HEADERS_TIMEOUT_ENV]: " 30000 ",
      },
    })
    expect(t.streamIdleTimeoutMs).toBe(45_000)
    expect(t.silentBlockIdleTimeoutMs).toBe(120_000)
    expect(t.keepaliveSilentBlockIdleTimeoutMs).toBe(120_000)
    expect(t.responseHeadersTimeoutMs({ url: "http://localhost:1/x" })).toBe(30_000)
    expect(t.responseHeadersTimeoutMs({ url: REMOTE })).toBe(30_000)
  })

  it("ignores a bad env value with one diagnostic and keeps the default", () => {
    const { diagnostics, warns } = recordingDiagnostics()
    const env = {
      [STREAM_IDLE_TIMEOUT_ENV]: "abc",
      [SILENT_BLOCK_IDLE_TIMEOUT_ENV]: "0",
      [RESPONSE_HEADERS_TIMEOUT_ENV]: "-5",
    }
    const t = resolveStreamTimeouts({ explicit: {}, env, diagnostics })
    expect(t.streamIdleTimeoutMs).toBe(30_000)
    expect(t.silentBlockIdleTimeoutMs).toBe(300_000)
    expect(t.keepaliveSilentBlockIdleTimeoutMs).toBe(90_000)
    expect(t.responseHeadersTimeoutMs({ url: REMOTE })).toBe(60_000)
    expect(warns).toHaveLength(3)
    expect(warns[0]).toContain(STREAM_IDLE_TIMEOUT_ENV)
    expect(warns[1]).toContain(SILENT_BLOCK_IDLE_TIMEOUT_ENV)
    expect(warns[2]).toContain(RESPONSE_HEADERS_TIMEOUT_ENV)
    // Each bad key/value is reported once per session, not on each send.
    resolveStreamTimeouts({ explicit: {}, env, diagnostics })
    expect(warns).toHaveLength(3)
  })

  it("reports a bad env value one time in each session log", () => {
    const a = recordingDiagnostics("session-a")
    const b = recordingDiagnostics("session-b")
    const env = { [STREAM_IDLE_TIMEOUT_ENV]: "abc" }
    resolveStreamTimeouts({ explicit: {}, env, diagnostics: a.diagnostics })
    resolveStreamTimeouts({ explicit: {}, env, diagnostics: a.diagnostics })
    resolveStreamTimeouts({ explicit: {}, env, diagnostics: b.diagnostics })
    expect(a.warns).toHaveLength(1)
    expect(b.warns).toHaveLength(1)
  })

  it("raises a value under the floor, with one diagnostic", () => {
    for (const raw of ["1", "999"]) {
      resetStreamTimeoutEnvReports()
      const { diagnostics, warns } = recordingDiagnostics()
      const env = {
        [STREAM_IDLE_TIMEOUT_ENV]: raw,
        [SILENT_BLOCK_IDLE_TIMEOUT_ENV]: raw,
        [RESPONSE_HEADERS_TIMEOUT_ENV]: raw,
      }
      const t = resolveStreamTimeouts({ explicit: {}, env, diagnostics })
      expect(t.streamIdleTimeoutMs).toBe(1000)
      expect(t.silentBlockIdleTimeoutMs).toBe(1000)
      expect(t.keepaliveSilentBlockIdleTimeoutMs).toBe(1000)
      // The pre-stream floor is higher.
      expect(t.responseHeadersTimeoutMs({ url: REMOTE })).toBe(5000)
      expect(warns).toHaveLength(3)
      expect(warns[0]).toContain("raised to 1000")
      expect(warns[2]).toContain("raised to 5000")
      resolveStreamTimeouts({ explicit: {}, env, diagnostics })
      expect(warns).toHaveLength(3)
    }
    // At the floor: accepted with no diagnostic.
    const { diagnostics, warns } = recordingDiagnostics()
    const t = resolveStreamTimeouts({
      explicit: {},
      env: { [STREAM_IDLE_TIMEOUT_ENV]: "1000", [RESPONSE_HEADERS_TIMEOUT_ENV]: "5000" },
      diagnostics,
    })
    expect(t.streamIdleTimeoutMs).toBe(1000)
    expect(t.responseHeadersTimeoutMs()).toBe(5000)
    expect(warns).toHaveLength(0)
  })

  it("treats an empty env value as not set (no diagnostic)", () => {
    const { diagnostics, warns } = recordingDiagnostics()
    const t = resolveStreamTimeouts({
      explicit: {},
      env: { [STREAM_IDLE_TIMEOUT_ENV]: "" },
      diagnostics,
    })
    expect(t.streamIdleTimeoutMs).toBe(30_000)
    expect(warns).toHaveLength(0)
  })

  it("parses only positive integers", () => {
    expect(parseTimeoutEnv("1")).toBe(1)
    expect(parseTimeoutEnv("60000")).toBe(60_000)
    for (const bad of [undefined, "", "0", "-1", "1.5", "1e3", "abc", "99999999999999999999"]) {
      expect(parseTimeoutEnv(bad)).toBeUndefined()
    }
  })
})

describe("stream timeout precedence", () => {
  it("explicit SendOptions (wrap-up) values win over env and defaults", () => {
    const t = resolveStreamTimeouts({
      explicit: { streamIdleTimeoutMs: 10_000, responseHeadersTimeoutMs: 10_000 },
      env: {
        [STREAM_IDLE_TIMEOUT_ENV]: "45000",
        [RESPONSE_HEADERS_TIMEOUT_ENV]: "30000",
      },
    })
    expect(t.streamIdleTimeoutMs).toBe(10_000)
    expect(t.responseHeadersTimeoutMs()).toBe(10_000)
    expect(t.responseHeadersTimeoutMs({ url: LOCAL })).toBe(10_000)
  })
})
