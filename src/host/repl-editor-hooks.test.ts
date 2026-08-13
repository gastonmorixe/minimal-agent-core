import { describe, expect, test } from "bun:test"

import { registerEditorPluginHooks } from "./repl-editor-hooks.ts"

type Listener = (payload: unknown) => unknown

function makeHarness() {
  const listeners = new Map<string, Listener>()
  const footerCalls: Array<{ id: string; lines: string[]; priority?: number }> = []
  const cleared: string[] = []
  const prompts: Array<{ prompt: string; continuationPrompt?: string }> = []
  let overlayOwner: string | null = "history-edit"
  const loader = {
    hooks: () => ({
      on: (channel: string, listener: Listener) => listeners.set(channel, listener),
      emitChain: async <T>(_: string, payload: T) => ({ payload }),
    }),
  }
  registerEditorPluginHooks(
    loader,
    {
      isOverlayOwner: (owner) => owner === overlayOwner,
      setPrompt: (prompt, continuationPrompt) => prompts.push({ prompt, continuationPrompt }),
      setFooterLayer: (id, lines, opts) =>
        footerCalls.push({ id, lines, priority: opts?.priority }),
      clearFooterLayer: (id) => cleared.push(id),
    },
    () => ({ prompt: "ASK ❯ ", continuationPrompt: "  " }),
  )
  const emit = async (channel: string, payload: unknown) => {
    listeners.get(channel)?.(payload)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return {
    emit,
    footerCalls,
    cleared,
    prompts,
    setOverlayOwner: (owner: string | null) => {
      overlayOwner = owner
    },
  }
}

describe("editor.prompt hook protocol", () => {
  test("sets while owned then clears after overlay closes to the fresh base prompt", async () => {
    const h = makeHarness()
    await h.emit("editor.prompt.set", {
      owner: "history-edit",
      prompt: "ASK ↶ REWIND ❯ ",
      continuationPrompt: "  ",
    })
    expect(h.prompts).toEqual([{ prompt: "ASK ↶ REWIND ❯ ", continuationPrompt: "  " }])
    h.setOverlayOwner(null)
    await h.emit("editor.prompt.clear", { owner: "history-edit" })
    expect(h.prompts).toEqual([
      { prompt: "ASK ↶ REWIND ❯ ", continuationPrompt: "  " },
      { prompt: "ASK ❯ ", continuationPrompt: "  " },
    ])
  })

  test("rejects prompt writes from a non-owner", async () => {
    const h = makeHarness()
    h.setOverlayOwner("other")
    await h.emit("editor.prompt.set", { owner: "history-edit", prompt: "REWIND ❯ " })
    expect(h.prompts).toEqual([])
  })
})

describe("editor.picker hook protocol", () => {
  test("renders a host-owned picker frame and clears only its owner", async () => {
    const h = makeHarness()
    await h.emit("editor.picker.set", {
      owner: "history-edit",
      title: "Edit earlier prompt",
      rows: [
        { id: "u2", label: "Second prompt", hint: "newest" },
        { id: "u1", label: "First prompt" },
      ],
      selected: 1,
      footer: "↑↓ select · Enter edit · Esc cancel",
    })
    expect(h.footerCalls).toHaveLength(1)
    expect(h.footerCalls[0]?.lines.join("\n")).toContain("First prompt")
    // Picker's selected-row marker is a violet `▌`, matching the queue overlay
    // and the Picker primitive's rendering contract.
    expect(h.footerCalls[0]?.lines.join("\n")).toContain("▌")

    await h.emit("editor.picker.clear", { owner: "other" })
    expect(h.cleared).toEqual([])
    await h.emit("editor.picker.clear", { owner: "history-edit" })
    expect(h.cleared).toEqual(["overlay"])
  })

  test("rejects frames from a non-owner without painting", async () => {
    const h = makeHarness()
    h.setOverlayOwner("another-overlay")
    await h.emit("editor.picker.set", {
      owner: "history-edit",
      rows: [{ id: "u1", label: "prompt" }],
      selected: 0,
    })
    expect(h.footerCalls).toEqual([])
  })

  test("rejects malformed frames without painting", async () => {
    const h = makeHarness()
    await h.emit("editor.picker.set", {
      owner: "history-edit",
      rows: [{ id: "u1", label: "prompt" }],
      selected: "nope",
    })
    expect(h.footerCalls).toEqual([])
  })
})
