/**
 * Unit tests for the child registry with fake `kill` and `onExit` ports.
 */
import { describe, expect, it } from "bun:test"

import { type ChildSignal, createChildRegistry } from "./child-registry.ts"

function esrch(): Error {
  return Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
}

/** Fake OS: `live` holds the targets (pid or -pgid) that exist. */
function fakeOs(live: Set<number>) {
  const calls: Array<[number, ChildSignal]> = []
  const listeners: Array<() => void> = []
  return {
    calls,
    listeners,
    deps: {
      kill: (pid: number, signal: ChildSignal) => {
        calls.push([pid, signal])
        if (!live.has(pid)) throw esrch()
      },
      onExit: (fn: () => void) => {
        listeners.push(fn)
      },
    },
  }
}

describe("child registry", () => {
  it("register tracks the pid and unregister drops it", () => {
    const os = fakeOs(new Set([-100]))
    const reg = createChildRegistry(os.deps)
    const unregister = reg.register(100, { group: true })
    expect(reg.pids()).toEqual([100])
    unregister()
    expect(reg.pids()).toEqual([])
  })

  it("killAll sends the signal to -pgid for a group and to pid for a single child", () => {
    const os = fakeOs(new Set([-100, 200]))
    const reg = createChildRegistry(os.deps)
    reg.register(100, { group: true })
    reg.register(200, { group: false })
    os.calls.length = 0
    reg.killAll()
    expect(os.calls).toEqual([
      [-100, "SIGKILL"],
      [200, "SIGKILL"],
    ])
    expect(reg.pids()).toEqual([])
  })

  it("killAll ignores ESRCH and does not throw", () => {
    const live = new Set([-100, -300])
    const os = fakeOs(live)
    const reg = createChildRegistry(os.deps)
    reg.register(100, { group: true })
    reg.register(300, { group: true })
    // Group 100 exits before the kill: ESRCH, and no single-pid fallback.
    live.delete(-100)
    os.calls.length = 0
    expect(() => reg.killAll("SIGTERM")).not.toThrow()
    expect(os.calls).toEqual([
      [-100, "SIGTERM"],
      [-300, "SIGTERM"],
    ])
  })

  it("installs exactly one exit listener and the listener kills every entry", () => {
    const os = fakeOs(new Set([-100, -101, 102]))
    const reg = createChildRegistry(os.deps)
    reg.register(100, { group: true })
    reg.register(101, { group: true })
    reg.register(102, { group: false })
    expect(os.listeners.length).toBe(1)
    os.calls.length = 0
    os.listeners[0]()
    expect(os.calls).toEqual([
      [-100, "SIGKILL"],
      [-101, "SIGKILL"],
      [102, "SIGKILL"],
    ])
  })

  it("register prunes entries whose group is gone", () => {
    const live = new Set([-100, -101])
    const os = fakeOs(live)
    const reg = createChildRegistry(os.deps)
    reg.register(100, { group: true })
    reg.register(101, { group: true })
    live.delete(-100) // group 100 is gone
    reg.register(102, { group: false })
    expect(reg.pids().sort()).toEqual([101, 102])
  })

  it("releaseIfGone drops a gone group and keeps a live one", () => {
    const live = new Set([-100, -101])
    const reg = createChildRegistry(fakeOs(live).deps)
    reg.register(100, { group: true })
    reg.register(101, { group: true })
    live.delete(-100)
    expect(reg.releaseIfGone(100)).toBe(true)
    expect(reg.releaseIfGone(101)).toBe(false)
    expect(reg.pids()).toEqual([101])
  })

  it("ignores an invalid pid", () => {
    const os = fakeOs(new Set())
    const reg = createChildRegistry(os.deps)
    reg.register(0, { group: true })
    reg.register(Number.NaN, { group: false })
    expect(reg.pids()).toEqual([])
    expect(os.listeners.length).toBe(0)
  })

  it("rejects pid 1 and the own pid, so the exit listener never signals -1 or itself", () => {
    const os = fakeOs(new Set([-1, 1, process.pid, -process.pid]))
    const reg = createChildRegistry(os.deps)
    const un1 = reg.register(1, { group: true })
    const unSelf = reg.register(process.pid, { group: true })
    expect(reg.pids()).toEqual([])
    expect(os.listeners.length).toBe(0)
    expect(() => un1()).not.toThrow()
    expect(() => unSelf()).not.toThrow()
    reg.killAll()
    expect(os.calls).toEqual([])
  })

  it("drops an entry when the liveness probe gives EPERM (a reused id that is not ours)", () => {
    const eperm = Object.assign(new Error("kill EPERM"), { code: "EPERM" })
    let permDenied = false
    const reg = createChildRegistry({
      kill: (pid) => {
        if (pid === -100 && permDenied) throw eperm
        if (pid !== -100) throw esrch()
      },
      onExit: () => {},
    })
    reg.register(100, { group: true })
    expect(reg.releaseIfGone(100)).toBe(false)
    permDenied = true
    expect(reg.releaseIfGone(100)).toBe(true)
    expect(reg.pids()).toEqual([])
  })

  it("killAll falls back from -pgid to the single pid when the group call fails with EPERM", () => {
    const eperm = Object.assign(new Error("kill EPERM"), { code: "EPERM" })
    const calls: Array<[number, ChildSignal]> = []
    let failGroup = false
    const reg = createChildRegistry({
      kill: (pid, signal) => {
        calls.push([pid, signal])
        if (pid === -100 && failGroup) throw eperm
      },
      onExit: () => {},
    })
    reg.register(100, { group: true })
    failGroup = true
    calls.length = 0
    expect(() => reg.killAll()).not.toThrow()
    expect(calls).toEqual([
      [-100, "SIGKILL"],
      [100, "SIGKILL"],
    ])
    expect(reg.pids()).toEqual([])
  })
})
