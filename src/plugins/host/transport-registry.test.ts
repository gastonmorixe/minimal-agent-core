import { afterEach, describe, expect, it } from "bun:test"

import { buildPluginHost } from "./factory.ts"
import {
  __resetTransportRegistryForTests,
  createTransportRegistryApi,
  type RegisteredTransport,
} from "./transport-registry.ts"

afterEach(() => __resetTransportRegistryForTests())

const t = (id: string): RegisteredTransport => ({ id })

describe("transport-registry store", () => {
  it("register + list round-trips in insertion order", () => {
    const api = createTransportRegistryApi()
    api.register(t("local-fs"))
    api.register(t("cloud-ws"))
    expect(api.list().map((x) => x.id)).toEqual(["local-fs", "cloud-ws"])
  })

  it("register is last-write-wins per id (idempotent reconnect)", () => {
    const api = createTransportRegistryApi()
    const first = { id: "cloud-ws", gen: 1 }
    const second = { id: "cloud-ws", gen: 2 }
    api.register(first)
    api.register(second)
    expect(api.list()).toHaveLength(1)
    expect((api.list()[0] as unknown as { gen: number }).gen).toBe(2)
  })

  it("unregister removes by id and is a no-op when absent", () => {
    const api = createTransportRegistryApi()
    api.register(t("cloud-ws"))
    api.unregister("cloud-ws")
    api.unregister("never-there") // no throw
    expect(api.list()).toEqual([])
  })

  it("rejects a transport without a usable string id", () => {
    const api = createTransportRegistryApi()
    expect(() => api.register({ id: "" })).toThrow()
    expect(() => api.register({} as RegisteredTransport)).toThrow()
    expect(() => api.register(null as unknown as RegisteredTransport)).toThrow()
  })

  it("is a PROCESS-WIDE store: a provider's register is visible to a separate consumer view", () => {
    // Two distinct API objects (like two different plugins' frozen hosts), one
    // shared store: the whole point of the decoupled injection seam.
    const provider = createTransportRegistryApi()
    const consumer = createTransportRegistryApi()
    expect(provider).not.toBe(consumer)
    provider.register(t("cloud-ws"))
    expect(consumer.list().map((x) => x.id)).toEqual(["cloud-ws"])
  })
})

describe("buildPluginHost — transport:registry grant", () => {
  it("populates transportRegistry only when granted (deny-by-default)", () => {
    const denied = buildPluginHost({ capabilities: ["sessions:read"], sessionsDir: "/tmp" })
    expect(denied.transportRegistry).toBeUndefined()

    const granted = buildPluginHost({ capabilities: ["transport:registry"] })
    expect(granted.transportRegistry).toBeDefined()
    expect(Object.isFrozen(granted.transportRegistry)).toBe(true)
  })

  it("separate granted hosts share the same backing store (decoupled provider→consumer)", () => {
    const cloud = buildPluginHost({ capabilities: ["transport:registry"] })
    const intercom = buildPluginHost({ capabilities: ["transport:registry"] })
    cloud.transportRegistry?.register(t("cloud-ws"))
    expect(intercom.transportRegistry?.list().map((x) => x.id)).toEqual(["cloud-ws"])
  })
})
