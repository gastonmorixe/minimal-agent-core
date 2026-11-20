/**
 * The wrap-up abort ends {@link withRetry} with a typed
 * {@link WrapUpAbortError}: during the backoff sleep, during an attempt
 * (a pre-headers stall), and through the full canonical stack. It never
 * sends a new attempt after the wrap-up.
 *
 * @module llm/transport/wrap-up-abort.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import {
  defaultAuthStore,
  resetDefaultAuthStoreForTests,
  type SecretBag,
} from "../../auth/auth-store.ts"
import { NetworkClient, type NetworkRequest, type NetworkResponse } from "../../network/index.ts"
import type { ApiKeyAuthProvider } from "../provider-plugin.ts"
import { registerTestProvider } from "../test-fixtures.ts"

import { canonicalSendFn } from "./canonical-send.ts"
import { withRetry } from "./retry.ts"
import type { RetryClock } from "./retry-policy.ts"
import type { StreamedResponse } from "./types.ts"
import { isWrapUpAbort, isWrapUpReason, WRAP_UP_REASON, WrapUpAbortError } from "./wrap-up-abort.ts"

function transient(): Error {
  return Object.assign(new Error("overloaded"), { streamErrorType: "overloaded_error" })
}

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<unknown> {
  try {
    while (!(await gen.next()).done) {
      /* discard */
    }
    return undefined
  } catch (err) {
    return err
  }
}

/** A clock whose sleep waits until the signal aborts. */
function blockingClock(onSleep: () => void): RetryClock {
  return {
    now: () => 0,
    sleep: (_ms, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        onSleep()
      }),
  }
}

/** A promise that rejects when `signal` aborts (a request with no headers). */
function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    if (signal?.aborted) fail()
    signal?.addEventListener("abort", fail, { once: true })
  })
}

describe("wrap-up reason", () => {
  it("tells a wrap-up abort from a user abort", () => {
    const user = new AbortController()
    user.abort()
    const wrap = new AbortController()
    wrap.abort({ ...WRAP_UP_REASON, tools: ["Report"] })
    expect(isWrapUpAbort(user.signal)).toBe(false)
    expect(isWrapUpAbort(wrap.signal)).toBe(true)
    expect(isWrapUpAbort(undefined)).toBe(false)
    expect(isWrapUpReason(new Error("x"))).toBe(false)
  })
})

describe("withRetry wrap-up", () => {
  it("ends the backoff sleep with WrapUpAbortError and sends no new attempt", async () => {
    const ac = new AbortController()
    let calls = 0
    const clock = blockingClock(() => ac.abort(WRAP_UP_REASON))
    const err = await drain(
      withRetry(
        // biome-ignore lint/correctness/useYield: the attempt only fails
        async function* () {
          calls++
          throw transient()
        },
        { signal: ac.signal, clock, random: () => 0 },
      ),
    )
    expect(err).toBeInstanceOf(WrapUpAbortError)
    expect(calls).toBe(1)
  })

  it("ends a pre-headers stall with WrapUpAbortError, not an error loop", async () => {
    const ac = new AbortController()
    let calls = 0
    const pending = drain(
      withRetry(
        // biome-ignore lint/correctness/useYield: the attempt hangs
        async function* () {
          calls++
          return await hang(ac.signal)
        },
        { signal: ac.signal, random: () => 0 },
      ),
    )
    await Promise.resolve()
    ac.abort(WRAP_UP_REASON)
    expect(await pending).toBeInstanceOf(WrapUpAbortError)
    expect(calls).toBe(1)
  })

  it("keeps a user abort as before (no WrapUpAbortError)", async () => {
    const ac = new AbortController()
    const pending = drain(
      withRetry(
        // biome-ignore lint/correctness/useYield: the attempt hangs
        async function* () {
          return await hang(ac.signal)
        },
        { signal: ac.signal },
      ),
    )
    await Promise.resolve()
    ac.abort()
    const err = await pending
    expect(err).not.toBeInstanceOf(WrapUpAbortError)
    expect((err as Error).name).toBe("AbortError")
  })
})

const apiKeyAuth: ApiKeyAuthProvider = {
  serviceId: "test-wrapup-api-key",
  displayName: "Test Wrap-up API Key",
  buildCredential(apiKey) {
    return {
      serviceId: this.serviceId,
      displayName: this.displayName,
      secrets: { api_key: apiKey },
    }
  },
  readApiKey(secrets) {
    const value = secrets.api_key
    return typeof value === "string" ? value : null
  },
}

describe("canonicalSendFn wrap-up", () => {
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
  let dir = ""

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "minimal-agent-wrapup-auth-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
    registerTestProvider({ id: "test-wrapup", models: [{ id: "test-model-wrapup" }], apiKeyAuth })
    const cred = apiKeyAuth.buildCredential("sk-test-wrapup")
    defaultAuthStore().set(cred.serviceId, cred.displayName, cred.secrets as SecretBag)
  })

  afterAll(() => {
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
    resetDefaultAuthStoreForTests()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("a wrap-up during a pre-headers stall ends the send at once", async () => {
    const ac = new AbortController()
    let calls = 0
    const networkClient = new NetworkClient({
      primary: {
        id: "fake",
        request: async (req: NetworkRequest): Promise<NetworkResponse> => {
          calls++
          setTimeout(() => ac.abort(WRAP_UP_REASON), 20)
          return hang(req.signal)
        },
      },
    })
    const auth: AuthResult = { type: "api-key", token: "sk-test-wrapup" }
    const started = Date.now()
    const err = await drain(
      canonicalSendFn({
        model: "test-model-wrapup",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        auth,
        networkClient,
        signal: ac.signal,
      }),
    )
    expect(err).toBeInstanceOf(WrapUpAbortError)
    expect(calls).toBe(1)
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 10_000)
})
