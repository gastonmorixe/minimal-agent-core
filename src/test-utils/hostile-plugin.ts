/**
 * Hostile-plugin fixtures for plugin boundary tests (W2 lead decision D1).
 *
 * Each factory returns a fresh value on each call. Use these values as a
 * stage result, an annotation, a field value or a hook return in a test,
 * and check that core fails open: it keeps the earlier value, records a
 * diagnostic, and does not throw.
 *
 * Test code only. The architecture scans skip `src/test-utils/`
 * (`diag-call-sites.ts`, `timer-inventory.ts`, `direct-write-scan.ts`).
 *
 * @module test-utils/hostile-plugin
 */

/** The error that the hostile fixtures throw. `trap` names the operation. */
export class HostileFixtureError extends Error {
  /** The trap or accessor that threw, for example `"get"` or `"then"`. */
  readonly trap: string

  /** Make an error for one trap. */
  constructor(trap: string) {
    super(`hostile fixture: ${trap}`)
    this.name = "HostileFixtureError"
    this.trap = trap
  }
}

/** All 13 Proxy handler traps. Each one throws {@link HostileFixtureError}. */
export const HOSTILE_PROXY_TRAPS = [
  "get",
  "has",
  "ownKeys",
  "getPrototypeOf",
  "setPrototypeOf",
  "getOwnPropertyDescriptor",
  "set",
  "defineProperty",
  "deleteProperty",
  "isExtensible",
  "preventExtensions",
  "apply",
  "construct",
] as const

/** A Proxy handler with each trap set to throw. */
function throwingHandler<T extends object>(): ProxyHandler<T> {
  const handler: ProxyHandler<T> = {}
  for (const trap of HOSTILE_PROXY_TRAPS) {
    Object.defineProperty(handler, trap, {
      value: () => {
        throw new HostileFixtureError(trap)
      },
      enumerable: true,
    })
  }
  return handler
}

/**
 * An object with one enumerable own getter that throws on read.
 * `Object.keys` works; a read of `key` throws {@link HostileFixtureError}.
 */
export function throwingGetter(key = "text"): Record<string, unknown> {
  const value: Record<string, unknown> = {}
  Object.defineProperty(value, key, {
    get() {
      throw new HostileFixtureError(`get ${key}`)
    },
    enumerable: true,
    configurable: true,
  })
  return value
}

/**
 * A Proxy over a plain object. Each trap throws {@link HostileFixtureError}:
 * read, `in`, `Object.keys`, `Object.getPrototypeOf`, descriptors, write,
 * define and delete. `typeof` gives `"object"` and does not throw.
 */
export function throwingProxy(): Record<string, unknown> {
  return new Proxy<Record<string, unknown>>({}, throwingHandler())
}

/**
 * A revoked Proxy. Each operation that reaches a trap throws `TypeError`.
 * `typeof` gives `"object"` and does not throw.
 */
export function revokedProxy(): Record<string, unknown> {
  const { proxy, revoke } = Proxy.revocable<Record<string, unknown>>({}, {})
  revoke()
  return proxy
}

/**
 * A Proxy over a function. `typeof` gives `"function"`. Each trap throws
 * {@link HostileFixtureError}, also a call (`apply`) and `new` (`construct`).
 */
export function throwingProxyFunction(): (...args: unknown[]) => unknown {
  return new Proxy<(...args: unknown[]) => unknown>(function hostile() {
    return undefined
  }, throwingHandler())
}

/**
 * A value from `JSON.parse` with an own `__proto__` key. The prototype of
 * the value is `Object.prototype`. A naive copy with `obj[key] = v` sets the
 * prototype of the copy; `Object.defineProperty` or a spread does not.
 */
export function jsonProtoKey(): Record<string, unknown> {
  return JSON.parse('{"text":"ok","__proto__":{"polluted":true}}') as Record<string, unknown>
}

/**
 * A thenable: an object with a `then` method. `await` on it gives `value`.
 * A stage that returns it looks like a promise.
 */
export function thenable<T>(value: T): PromiseLike<T> {
  return {
    // biome-ignore lint/suspicious/noThenProperty: the fixture must be a thenable.
    then<R1 = T, R2 = never>(
      onFulfilled?: ((v: T) => R1 | PromiseLike<R1>) | null,
      onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(value).then(onFulfilled, onRejected)
    },
  }
}

/**
 * A thenable whose `then` method throws {@link HostileFixtureError}.
 * `await` on it rejects with that error.
 */
export function throwingThenable(): PromiseLike<never> {
  return {
    // biome-ignore lint/suspicious/noThenProperty: the fixture must be a thenable.
    then(): never {
      throw new HostileFixtureError("then")
    },
  }
}

/**
 * A promise that never resolves and never rejects. It holds no timer, so it
 * does not keep the process alive. Use it with an abort signal or a timeout.
 */
export function neverSettlingPromise<T = never>(): Promise<T> {
  return new Promise<T>(() => {})
}
