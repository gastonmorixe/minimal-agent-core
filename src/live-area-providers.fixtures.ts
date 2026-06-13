/**
 * Shared test fixtures for the `LiveAreaScheduler` test files
 * (`live-area-providers.test.ts`, `live-area-providers.diagnostics.test.ts`).
 * Not a test file itself.
 */

import type { LiveAreaSink } from "./live-area-providers.ts"
import type {
  LiveAreaHandlerContext,
  ManifestLiveAreaSlot,
  ResolvedLiveAreaSlot,
} from "./plugins/types.ts"

// ----------------------------- fake timer ---------------------------------

/**
 * Fake `setTimeout`/`clearTimeout` pair: a tiny min-heap of `{when, fn}`
 * entries that `tick(ms)` advances deterministically; cancellation removes
 * by id.
 */
export class FakeClock {
  private now = 0
  private nextId = 1
  private q: Array<{ id: number; when: number; fn: () => void; cancelled: boolean }> = []

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++
    this.q.push({ id, when: this.now + ms, fn, cancelled: false })
    this.q.sort((a, b) => a.when - b.when)
    return { id } as unknown
  }

  clearTimeout = (handle: unknown): void => {
    const t = (handle as { id?: number })?.id
    for (const e of this.q) if (e.id === t) e.cancelled = true
  }

  /**
   * Advance virtual time by `ms` ms, firing any due (non-cancelled)
   * timers in order. After firing each timer we also let microtasks
   * settle — handlers commonly resolve a Promise, and the scheduler's
   * `.then(handle)` continuation is a microtask.
   *
   * We drain microtasks BEFORE looking for the next due timer (so a
   * just-fired handler that calls `scheduleNext` is observable on this
   * iteration), and once more at the end (so the caller can assert on
   * post-resolve state without a manual `await Promise.resolve()`
   * after every tick).
   */
  async tick(ms: number): Promise<void> {
    const target = this.now + ms
    // Drain microtasks at entry so any handlers that resolved between
    // ticks have already run before we sample the queue.
    await this.drainMicrotasks()
    while (true) {
      const next = this.q.find((e) => !e.cancelled)
      if (!next || next.when > target) break
      this.now = next.when
      next.cancelled = true
      next.fn()
      await this.drainMicrotasks()
    }
    this.now = target
    await this.drainMicrotasks()
  }

  private async drainMicrotasks(): Promise<void> {
    // 16 turns is plenty for `Promise.resolve().then().then()` chains and
    // for an async-function body with a couple of awaits.
    for (let i = 0; i < 16; i++) await Promise.resolve()
  }

  pendingCount(): number {
    return this.q.filter((e) => !e.cancelled).length
  }
}

// -------------------------------- helpers ---------------------------------

export interface SlotSpec {
  id: string
  position?: "header" | "footer"
  refreshMs?: number
  timeoutMs?: number
  invoke: (ctx: LiveAreaHandlerContext) => Promise<string | null>
}

/** Hand-construct a {@link ResolvedLiveAreaSlot} fixture from a {@link SlotSpec}. */
export function makeSlot(spec: SlotSpec): ResolvedLiveAreaSlot {
  const definition: ManifestLiveAreaSlot = {
    id: spec.id,
    handler: { type: "module", path: "./fake.ts" },
    position: spec.position ?? "footer",
    refreshMs: spec.refreshMs ?? 60_000,
    timeoutMs: spec.timeoutMs ?? 5000,
  }
  return {
    definition,
    pluginId: "fake-plugin",
    packageDir: "/tmp/fake",
    entryAbsolute: "/tmp/fake/handler.ts",
    invoke: spec.invoke,
  }
}

/** A recording {@link LiveAreaSink} that captures every footer/decoration paint. */
export function makeSink(): LiveAreaSink & {
  footerCalls: string[][]
  decorationCalls: string[][]
} {
  const footerCalls: string[][] = []
  const decorationCalls: string[][] = []
  return {
    footerCalls,
    decorationCalls,
    setFooterLines(lines) {
      footerCalls.push([...lines])
    },
    setDecorationLines(lines) {
      decorationCalls.push([...lines])
    },
  }
}
