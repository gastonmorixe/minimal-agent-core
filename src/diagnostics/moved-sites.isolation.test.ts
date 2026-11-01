/**
 * Moved diagnostic sites keep runtimes and sessions apart (S20).
 *
 * Each site in this file used the global `diag` helpers before. Now it
 * reports through an injected {@link Diagnostics} handle. The test builds two
 * runtimes (or two hubs), each with its own bus, in one process. Each moved
 * path runs once per runtime with that runtime's session handle. Each bus
 * must get only the events of its own session, and the process bus must get
 * none of them.
 *
 * @module diagnostics/moved-sites.isolation.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { MediaResolverAdapter } from "../adapters/media-resolver-adapter.ts"
import type { AuthResult } from "../auth/auth.ts"
import { runOAuthLogin } from "../auth/oauth-login.ts"
import { provisionSetups } from "../binaries/provision.ts"
import { BinaryStore } from "../binaries/store.ts"
import {
  createDiagnosticBus,
  type DiagnosticBus,
  getDiagnosticBus,
  type LogEvent,
} from "../bus/diagnostic-bus.ts"
import { CacheAnomalyDetector } from "../cache/cache.ts"
import { loadUserConfig } from "../config/config.ts"
import type { CanonicalEvent } from "../llm/canonical-events.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  registerModel,
  registerProvider,
} from "../llm/model-registry.ts"
import { runPreflight } from "../llm/preflight.ts"
import type { OAuthLoginProvider } from "../llm/provider-plugin.ts"
import {
  clearProviderPlugins,
  findProviderPlugin,
  registerProviderPlugin,
} from "../llm/provider-plugin.ts"
import { debugRequestOptions } from "../llm/transport/debug.ts"
import type { StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { _resetLoggerErrorReportedForTest, warnLoggerErrorOnce } from "../logging/net-dbg.ts"
import { resolveUserTurnContent } from "../media/ingest.ts"
import { ModeManager } from "../modes/modes.ts"
import { createRuntime } from "../runtime/runtime.ts"
import { loadSessionFromText } from "../session/session-restore.ts"
import { sessionFilePath } from "../session/session-store.ts"

import { createDiagnosticsHub, type Diagnostics } from "./hub.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** One runtime-like side of the test: a private bus and a session handle on it. */
interface Side {
  readonly sessionId: string
  readonly bus: DiagnosticBus
  readonly events: LogEvent[]
  readonly diagnostics: Diagnostics
}

function makeSide(sessionId: string): Side {
  const bus = createDiagnosticBus()
  const events: LogEvent[] = []
  bus.on("*", (e) => events.push(e))
  const diagnostics = createDiagnosticsHub({ bus }).session(sessionId)
  return { sessionId, bus, events, diagnostics }
}

/** Every event on `side` carries its own session id, and one has `source`. */
function expectOwnEvents(side: Side, source: string): void {
  const hits = side.events.filter((e) => e.source === source)
  expect(hits.length).toBeGreaterThan(0)
  for (const e of side.events) expect(e.sessionId).toBe(side.sessionId)
}

/**
 * The moved paths. Each case runs once per side with that side's handle.
 * `reset` clears a once-per-process latch between the two runs.
 */
interface SiteCase {
  readonly source: string
  readonly run: (diagnostics: Diagnostics) => unknown
  readonly reset?: () => void
}

const LEGACY_MODE = {
  id: "legacy",
  label: "Legacy",
  systemPromptAppend: "<mode>legacy</mode>",
}

const DEVICE_PROVIDER: OAuthLoginProvider = {
  serviceId: "test-oauth",
  displayName: "Test OAuth",
  config: () => ({
    clientId: "c",
    authorizeUrl: "https://login.example.test/authorize",
    tokenUrl: "https://login.example.test/token",
    redirectUri: "https://login.example.test/callback",
    scopes: [],
  }),
  buildCredential: () => {
    throw new Error("not used")
  },
  deviceCode: {
    request: async () => ({
      verificationUrl: "https://login.example.test/device",
      userCode: "ABCD",
    }),
    complete: async () => {
      throw new Error("stop after the trace")
    },
  },
}

describe("moved diagnostic sites keep two runtimes apart (S20)", () => {
  let tmp: string
  let processEvents: LogEvent[]
  let offProcess: () => void
  const savedEnv = { DEBUG: process.env.DEBUG, CONFIG: process.env.MINIMAL_AGENT_CONFIG }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ma-diag-moved-"))
    processEvents = []
    offProcess = getDiagnosticBus().on("*", (e) => processEvents.push(e))
  })

  afterEach(() => {
    offProcess()
    rmSync(tmp, { recursive: true, force: true })
    clearProviderPlugins()
    clearModelRegistry()
    clearProviderRegistry()
    _resetLoggerErrorReportedForTest()
    if (savedEnv.DEBUG === undefined) delete process.env.DEBUG
    else process.env.DEBUG = savedEnv.DEBUG
    if (savedEnv.CONFIG === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = savedEnv.CONFIG
  })

  const cases: SiteCase[] = [
    {
      source: "session-restore.rewind-unknown",
      run: (d) =>
        loadSessionFromText(
          `${JSON.stringify({ kind: "rewind", ts: "t", to: "nope", droppedCount: 0 })}\n`,
          { diagnostics: d },
        ),
    },
    {
      source: "preflight.adapter-threw",
      run: (d) => {
        registerModel({
          id: "pf-throw-model",
          providerId: "pf-throw-prov",
          surfaceId: "custom",
          displayName: "Preflight Throw Model",
          capabilities: defaultCapabilities(),
          pricing: {
            inputUSD: 0,
            outputUSD: 0,
            cacheWriteUSD: 0,
            cacheReadUSD: 0,
            webSearchPerCallUSD: 0,
          },
        })
        registerProvider({
          id: "pf-throw-prov",
          displayName: "Preflight Throw Provider",
          surfaces: ["custom"],
          validate: () => ({ ok: true, errors: [] }),
          async *run(): AsyncIterable<CanonicalEvent> {
            // Not used.
          },
          preflight: () => {
            throw new Error("buggy adapter")
          },
        })
        runPreflight({ modelId: "pf-throw-model", messages: [] }, d)
      },
      reset: () => {
        clearModelRegistry()
        clearProviderRegistry()
      },
    },
    {
      source: "media.missing",
      run: (d) => resolveUserTurnContent("see [Image #deadbee1]", { diagnostics: d }),
    },
    {
      source: "cache.anomaly",
      run: (d) =>
        new CacheAnomalyDetector({ diagnostics: d }).observe(
          {
            input_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          { breakpoints: 2, approxPrefixChars: 9000, model: "m" },
        ),
    },
    {
      source: "transport.request-dump",
      run: (d) => {
        process.env.DEBUG = "1"
        debugRequestOptions({ model: "m", messages: [], stream: true } as never, d)
      },
    },
    {
      source: "net-dbg.logger-failure",
      run: (d) => warnLoggerErrorOnce(new Error("disk full"), d),
      reset: _resetLoggerErrorReportedForTest,
    },
    {
      source: "binaries.halt",
      run: (d) =>
        provisionSetups(
          new BinaryStore(join(tmp, "bin")),
          [{ pluginId: "p", result: { haltIfMissing: ["no-such-binary"] } }],
          undefined,
          d,
        ),
    },
    {
      source: "config.parse-error",
      run: (d) => {
        const path = join(tmp, "config.jsonc")
        writeFileSync(path, "{ not json")
        process.env.MINIMAL_AGENT_CONFIG = path
        loadUserConfig(d)
      },
    },
    {
      source: "modes.deprecated-system-prompt-append",
      run: (d) => new ModeManager([LEGACY_MODE], "legacy").systemPromptAddition(d),
    },
    {
      source: "provider.renamed",
      run: (d) => {
        registerProviderPlugin({
          id: "renamed-for-test",
          displayName: "Renamed",
          shortCode: "rn",
          formerIds: ["former-for-test"],
          register() {},
        })
        findProviderPlugin("former-for-test", d)
      },
      reset: clearProviderPlugins,
    },
    {
      source: "auth.login",
      run: async (d) => {
        process.env.DEBUG = "1"
        await runOAuthLogin({
          provider: DEVICE_PROVIDER,
          readPaste: async () => "",
          diagnostics: d,
        }).catch(() => undefined)
      },
    },
  ]

  for (const c of cases) {
    it(`${c.source} goes to the caller's session handle only`, async () => {
      const a = makeSide("session-a")
      const b = makeSide("session-b")
      await c.run(a.diagnostics)
      c.reset?.()
      await c.run(b.diagnostics)
      expectOwnEvents(a, c.source)
      expectOwnEvents(b, c.source)
      expect(processEvents.filter((e) => e.source === c.source)).toEqual([])
    })
  }
})

describe("two runtimes in one process, end to end (S20)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-diag-runtimes-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const answer: TransportFn = async function* () {
    const done: StreamedResponse = {
      blocks: [{ type: "text", text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    }
    return done
  }

  function runtimeWithBus(): { events: LogEvent[]; runtime: ReturnType<typeof createRuntime> } {
    const bus = createDiagnosticBus()
    const events: LogEvent[] = []
    bus.on("*", (e) => events.push(e))
    return { events, runtime: createRuntime({ bus }) }
  }

  it("a turn's media warning names the session of its own runtime", async () => {
    const one = runtimeWithBus()
    const two = runtimeWithBus()
    const runs = [
      { side: one, id: "aaaaaaaa-0000-4000-8000-000000000001" },
      { side: two, id: "bbbbbbbb-0000-4000-8000-000000000002" },
    ]
    for (const { side, id } of runs) {
      const session = side.runtime.openSession({
        id,
        auth: AUTH,
        model: "m",
        sendFn: answer,
        mediaResolver: new MediaResolverAdapter("m"),
      })
      for await (const _ of session.run("see [Image #deadbee2]")) {
        // Drain the turn.
      }
    }
    for (const { side, id } of runs) {
      const missing = side.events.filter((e) => e.source === "media.missing")
      expect(missing.length).toBe(1)
      for (const e of side.events) expect(e.sessionId).toBe(id)
      side.runtime.close()
    }
  })

  it("resumeSession reports a restore warning with the resumed session id", () => {
    const one = runtimeWithBus()
    const two = runtimeWithBus()
    const ids = ["cccccccc-0000-4000-8000-000000000003", "dddddddd-0000-4000-8000-000000000004"]
    for (const id of ids) {
      const path = sessionFilePath(id, dir)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        path,
        `${JSON.stringify({ kind: "rewind", ts: "t", to: "nope", droppedCount: 0 })}\n`,
      )
    }
    one.runtime.resumeSession(ids[0], { auth: AUTH, persist: { dir } })
    two.runtime.resumeSession(ids[1], { auth: AUTH, persist: { dir } })
    for (const [side, id] of [
      [one, ids[0]],
      [two, ids[1]],
    ] as const) {
      const hits = side.events.filter((e) => e.source === "session-restore.rewind-unknown")
      expect(hits.length).toBeGreaterThan(0)
      for (const e of side.events) expect(e.sessionId).toBe(id)
      side.runtime.close()
    }
  })
})
