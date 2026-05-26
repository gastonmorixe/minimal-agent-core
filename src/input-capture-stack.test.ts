/**
 * Unit tests for the {@link InputCaptureStack}.
 *
 * The stack is small but the contract has teeth: LIFO precedence,
 * out-of-order disposer release, throw absorption, dispatch-snapshot
 * stability. Each of those needs a guard so future refactors don't
 * silently regress the contract that EditorController + reflection
 * cooldown rely on.
 */
import { describe, expect, it } from "bun:test"

import { InputCaptureStack } from "./input-capture-stack.ts"

describe("InputCaptureStack — push + dispatch", () => {
  it("empty stack dispatch returns false (no claim)", () => {
    const s = new InputCaptureStack()
    expect(s.dispatch("Escape")).toBe(false)
    expect(s.depth()).toBe(0)
    expect(s.topId()).toBe(null)
  })

  it("single push: handler sees the key, claim propagates as `true`", () => {
    const s = new InputCaptureStack()
    const seen: string[] = []
    s.push("a", (key) => {
      seen.push(key)
      return true
    })
    expect(s.dispatch("Escape")).toBe(true)
    expect(seen).toEqual(["Escape"])
    expect(s.depth()).toBe(1)
    expect(s.topId()).toBe("a")
  })

  it("single push, handler returns false: dispatch returns false, stack intact", () => {
    const s = new InputCaptureStack()
    s.push("a", () => false)
    expect(s.dispatch("Escape")).toBe(false)
    expect(s.depth()).toBe(1)
  })

  it("non-boolean truthy from handler does NOT claim (strict ===true semantic)", () => {
    // The contract is `=== true`. Returning `1` or `"yes"` or `{}` is
    // not a claim — keeps the contract narrow and prevents accidental
    // claims from buggy handlers that compute and return a value.
    const s = new InputCaptureStack()
    s.push("a", (() => 1 as unknown as boolean) as never)
    s.push("b", (() => "yes" as unknown as boolean) as never)
    s.push("c", (() => ({}) as unknown as boolean) as never)
    expect(s.dispatch("Escape")).toBe(false)
  })
})

describe("InputCaptureStack — LIFO precedence (top wins)", () => {
  it("two pushes: most recent claims first", () => {
    const s = new InputCaptureStack()
    const calls: string[] = []
    s.push("bottom", (k) => {
      calls.push(`bottom:${k}`)
      return true
    })
    s.push("top", (k) => {
      calls.push(`top:${k}`)
      return true
    })
    expect(s.dispatch("Escape")).toBe(true)
    // Top claimed; bottom was NEVER consulted.
    expect(calls).toEqual(["top:Escape"])
  })

  it("top returns false, bottom claims: dispatch returns true, both saw the key", () => {
    const s = new InputCaptureStack()
    const calls: string[] = []
    s.push("bottom", (k) => {
      calls.push(`bottom:${k}`)
      return true
    })
    s.push("top", (k) => {
      calls.push(`top:${k}`)
      return false
    })
    expect(s.dispatch("Escape")).toBe(true)
    // Top first, then bottom (because top did not claim).
    expect(calls).toEqual(["top:Escape", "bottom:Escape"])
  })

  it("three pushes, all pass-through: all three handlers see the key, dispatch returns false", () => {
    const s = new InputCaptureStack()
    const calls: string[] = []
    s.push("a", (k) => {
      calls.push(`a:${k}`)
      return false
    })
    s.push("b", (k) => {
      calls.push(`b:${k}`)
      return false
    })
    s.push("c", (k) => {
      calls.push(`c:${k}`)
      return false
    })
    expect(s.dispatch("Escape")).toBe(false)
    // Walk order is top → bottom: c, b, a.
    expect(calls).toEqual(["c:Escape", "b:Escape", "a:Escape"])
  })

  it("topId reflects the most recently pushed entry", () => {
    const s = new InputCaptureStack()
    s.push("a", () => false)
    expect(s.topId()).toBe("a")
    s.push("b", () => false)
    expect(s.topId()).toBe("b")
    s.push("c", () => false)
    expect(s.topId()).toBe("c")
  })
})

describe("InputCaptureStack — disposers", () => {
  it("dispose removes the entry from the stack", () => {
    const s = new InputCaptureStack()
    const off = s.push("a", () => true)
    expect(s.depth()).toBe(1)
    off()
    expect(s.depth()).toBe(0)
    expect(s.topId()).toBe(null)
  })

  it("dispose is idempotent: second call is a no-op", () => {
    const s = new InputCaptureStack()
    const off = s.push("a", () => true)
    off()
    off() // must not throw, must not affect anything
    expect(s.depth()).toBe(0)
    // Re-push to confirm the stack is functional after double-dispose.
    s.push("b", () => true)
    expect(s.depth()).toBe(1)
    expect(s.topId()).toBe("b")
  })

  it("out-of-order dispose: removing a mid-stack entry leaves the others intact", () => {
    // This mirrors the real scenario: slash-menu is BELOW the reflection
    // cooldown, the user presses Enter on the menu (closing it) BEFORE
    // the cooldown's timer elapses. The menu's disposer fires while
    // it's not at the top.
    const s = new InputCaptureStack()
    const calls: string[] = []
    const a = s.push("a", (k) => {
      calls.push(`a:${k}`)
      return true
    })
    s.push("b", (k) => {
      calls.push(`b:${k}`)
      return false
    })
    s.push("c", (k) => {
      calls.push(`c:${k}`)
      return false
    })
    expect(s.depth()).toBe(3)
    a()
    expect(s.depth()).toBe(2)
    // After removing the bottom 'a', dispatch should walk c → b only.
    expect(s.dispatch("Escape")).toBe(false)
    expect(calls).toEqual(["c:Escape", "b:Escape"])
  })

  it("duplicate ids: each push gets its own entry, its own disposer", () => {
    // Captures are tracked by an internal sequence, not by id. Pushing
    // the same id twice creates two independent entries; the disposer
    // returned from each push removes the SPECIFIC entry it created.
    const s = new InputCaptureStack()
    const calls: string[] = []
    const offFirst = s.push("dupe", (k) => {
      calls.push(`first:${k}`)
      return false
    })
    s.push("dupe", (k) => {
      calls.push(`second:${k}`)
      return false
    })
    expect(s.depth()).toBe(2)
    offFirst()
    expect(s.depth()).toBe(1)
    // Only the second handler remains. `has` reports true because at
    // least one entry with that id is still on the stack.
    expect(s.has("dupe")).toBe(true)
    s.dispatch("Escape")
    expect(calls).toEqual(["second:Escape"])
  })

  it("dispose called from inside the handler is safe (snapshot semantics)", () => {
    // A handler that releases its own capture mid-dispatch must not
    // corrupt the in-flight walk. The stack snapshots entries at
    // dispatch entry, so the iteration index stays valid even as the
    // live entries[] mutates.
    const s = new InputCaptureStack()
    const calls: string[] = []
    s.push("bottom", (k) => {
      calls.push(`bottom:${k}`)
      return true
    })
    let topDisposer: (() => void) | null = null
    topDisposer = s.push("top", (k) => {
      calls.push(`top:${k}`)
      topDisposer?.()
      // Did not claim → dispatch should continue to 'bottom'.
      return false
    })
    expect(s.dispatch("Escape")).toBe(true)
    expect(calls).toEqual(["top:Escape", "bottom:Escape"])
    // After the dispatch, only 'bottom' remains (top removed itself).
    expect(s.depth()).toBe(1)
    expect(s.topId()).toBe("bottom")
  })
})

describe("InputCaptureStack — handler error absorption", () => {
  it("a throwing handler is treated as 'did not claim'; walk continues", () => {
    const s = new InputCaptureStack()
    const calls: string[] = []
    // Silence the diagnostic write so test output stays clean.
    const origWrite = process.stderr.write.bind(process.stderr)
    ;(process.stderr.write as unknown) = () => true
    try {
      s.push("bottom", (k) => {
        calls.push(`bottom:${k}`)
        return true
      })
      s.push("throws", () => {
        throw new Error("boom")
      })
      // Dispatch must NOT throw; bottom claims after the throw is absorbed.
      expect(s.dispatch("Escape")).toBe(true)
      expect(calls).toEqual(["bottom:Escape"])
    } finally {
      ;(process.stderr.write as unknown) = origWrite
    }
  })

  it("a throwing handler does not corrupt the stack", () => {
    const s = new InputCaptureStack()
    const origWrite = process.stderr.write.bind(process.stderr)
    ;(process.stderr.write as unknown) = () => true
    try {
      s.push("a", () => true)
      s.push("throws", () => {
        throw new Error("boom")
      })
      s.push("c", () => false)
      const depthBefore = s.depth()
      s.dispatch("Escape") // c → throws → a; a claims
      expect(s.depth()).toBe(depthBefore)
    } finally {
      ;(process.stderr.write as unknown) = origWrite
    }
  })
})

describe("InputCaptureStack — diagnostics + lifecycle", () => {
  it("has(id) returns true while at least one matching entry is on the stack", () => {
    const s = new InputCaptureStack()
    const off = s.push("a", () => false)
    expect(s.has("a")).toBe(true)
    expect(s.has("b")).toBe(false)
    off()
    expect(s.has("a")).toBe(false)
  })

  it("clear() drops every entry without invoking disposers", () => {
    const s = new InputCaptureStack()
    const offs = [s.push("a", () => false), s.push("b", () => false), s.push("c", () => false)]
    expect(s.depth()).toBe(3)
    s.clear()
    expect(s.depth()).toBe(0)
    // Disposers from before clear() are now stale; calling them must
    // not throw and must not re-add anything.
    for (const off of offs) off()
    expect(s.depth()).toBe(0)
  })

  it("keys other than Escape are routed through the same machinery (key is opaque)", () => {
    // The stack doesn't know about keys; it just forwards. Callers
    // choose which keys to claim. This guards against a future
    // accidental restriction to Escape only.
    const s = new InputCaptureStack()
    const seen: string[] = []
    s.push("a", (k) => {
      seen.push(k)
      return k === "Enter"
    })
    expect(s.dispatch("Escape")).toBe(false)
    expect(s.dispatch("Enter")).toBe(true)
    expect(s.dispatch("Tab")).toBe(false)
    expect(seen).toEqual(["Escape", "Enter", "Tab"])
  })
})
