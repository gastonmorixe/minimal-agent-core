/**
 * Consumer smoke test (v1 S32, adapted for spec v2's S47 entry point).
 *
 * v1's `consumer-smoke.test.ts` drove `openConversation` / `runTask`, both
 * gone in spec v2 (`public-closure.test.ts`'s module doc). This is its
 * replacement: `createRuntime` / `openSession` with a fake model
 * (transport), over the package's public root entry — imported by package
 * name, the way an external consumer installing core from git would,
 * never a relative `src/...` path — asserting on the events and
 * diagnostics the run produces.
 *
 * @module sdk/consumer-smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { createRuntime, type SessionEntry } from "@minimal-agent/core"

const AUTH = { type: "api-key" as const, token: "smoke-test-token" }

/** A fake model: fails once with a transient wire error, then answers. */
function fakeModel() {
  let calls = 0
  return async function* fakeTransport() {
    calls++
    if (calls === 1) {
      throw Object.assign(new Error("overloaded"), { errorClass: "transient" })
    }
    return {
      blocks: [{ type: "text" as const, text: "hello from the fake model" }],
      text: "hello from the fake model",
      stopReason: "end_turn" as const,
    }
  }
}

describe("consumer smoke test: createRuntime / openSession (public entry only)", () => {
  it("runs a turn and produces both event and diagnostic log entries", async () => {
    const runtime = createRuntime()
    const session = runtime.openSession({
      auth: AUTH,
      model: "fake-model",
      sendFn: fakeModel(),
    })

    const entries: SessionEntry[] = []
    for await (const entry of session.run("hello, agent")) entries.push(entry)

    // Both channels of the session event log are reachable through the
    // public entry alone.
    const events = entries.filter((e) => e.ch === "event")
    const diagnostics = entries.filter((e) => e.ch === "diag")
    expect(events.length).toBeGreaterThan(0)
    expect(diagnostics.length).toBeGreaterThan(0)

    // The run completed (the fake model's one failure was retried and
    // recovered, not treated as fatal), and every entry is stamped with
    // this session's id.
    const runFinished = events.find((e) => e.ch === "event" && e.data.type === "run_finished")
    expect(runFinished).toMatchObject({ sessionId: session.id, data: { outcome: "completed" } })
    for (const entry of entries) expect(entry.sessionId).toBe(session.id)

    // The model's reply reached the session's log as a plain text item.
    const textItem = events.find(
      (e) => e.ch === "event" && e.data.type === "item_completed" && e.data.itemType === "text",
    )
    expect(textItem).toBeDefined()

    // `seq` is monotonic from 0 for a fresh, unreplayed session, and
    // `subscribe` replays exactly what `run` already yielded.
    expect(entries[0]?.seq).toBe(0)
    for (let i = 1; i < entries.length; i++) expect(entries[i].seq).toBe(entries[i - 1].seq + 1)
    const replayed: SessionEntry[] = []
    session.subscribe((entry) => replayed.push(entry), { fromSeq: 0 })
    expect(replayed).toEqual(entries)

    runtime.close()
  })

  it("keeps runtime.diagnostics as a session-free, runtime-level handle", () => {
    const runtime = createRuntime()
    expect(runtime.diagnostics.sessionId).toBeUndefined()
    const session = runtime.openSession({ auth: AUTH, model: "fake-model" })
    // The session's own scope carries its id; the runtime handle still does not.
    expect(runtime.diagnostics.sessionId).toBeUndefined()
    session.close()
    runtime.close()
  })
})
