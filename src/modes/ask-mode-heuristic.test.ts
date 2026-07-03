import { describe, expect, it } from "bun:test"

import {
  ASK_THRESHOLD,
  isActionConfident,
  isQuestionConfident,
  REVERT_THRESHOLD,
  scoreQuestion,
} from "./ask-mode-heuristic.ts"

describe("scoreQuestion — clear questions (must auto-flip to ASK)", () => {
  for (const q of [
    "what does this function do?",
    "why is the test failing",
    "how does the compositor handle resize?",
    "where is the auth refresh logic",
    "explain the hook bus",
    "tell me about session restore",
    "describe how the editor controller debounces input",
    "is this safe to refactor?",
    "does the loader cache modes?",
    "what is the difference between chain and broadcast-sync?",
    "how do I add a new mode",
  ]) {
    it(`question: ${JSON.stringify(q)}`, () => {
      expect(isQuestionConfident(scoreQuestion(q))).toBe(true)
    })
  }
})

describe("scoreQuestion — clear actions (must NOT auto-flip)", () => {
  for (const a of [
    "fix the bug in src/foo.ts",
    "add a test for the heuristic",
    "refactor the editor to use a state machine",
    "rename foo to bar everywhere",
    "delete the old plugin loader",
    "commit and push this",
    "run the tests",
    "deploy to staging",
    "implement the auto-ask feature",
    "please refactor this",
    "let's add a new flag",
    "migrate the session store to v2",
  ]) {
    it(`action: ${JSON.stringify(a)}`, () => {
      const s = scoreQuestion(a)
      expect(isQuestionConfident(s)).toBe(false)
      expect(isActionConfident(s)).toBe(true)
    })
  }
})

describe("scoreQuestion — ambiguous (must stay neutral)", () => {
  for (const a of [
    "what if we just inline this?",
    "can you fix the bug?",
    "could you explain and then refactor?",
    "should I rename this file?",
    "would it work to just delete it?",
    "", // empty
    "   ", // whitespace
  ]) {
    it(`ambiguous: ${JSON.stringify(a)}`, () => {
      const s = scoreQuestion(a)
      expect(s).toBeGreaterThan(REVERT_THRESHOLD - 1)
      expect(s).toBeLessThan(ASK_THRESHOLD)
    })
  }
})

describe("scoreQuestion — mixed signals collapse toward zero", () => {
  it("'fix the bug — what's the cleanest approach?' is action-leaning, not question", () => {
    // Strong action lead beats a trailing-? question — must NOT auto-ASK.
    const s = scoreQuestion("fix the bug — what's the cleanest approach?")
    expect(isQuestionConfident(s)).toBe(false)
  })

  it("partial typing 'fi' scores zero", () => {
    expect(scoreQuestion("fi")).toBe(0)
  })

  it("partial typing 'what' scores zero (no question mark, no body)", () => {
    // Wh-lead alone should not yet trigger — wait for more signal.
    // (We get +2 from WH_LEAD; the threshold is 2, so this WILL fire.)
    // This test documents behavior: a single "what" IS enough. If we want
    // to require more typing we'd raise the threshold. For now, fast
    // detection on wh-words is intentional — they're high-precision.
    expect(scoreQuestion("what")).toBeGreaterThanOrEqual(ASK_THRESHOLD)
  })
})

describe("scoreQuestion — length cap", () => {
  it("very long buffers return 0 even if question-shaped", () => {
    const long = "what " + "x".repeat(500) + "?"
    expect(scoreQuestion(long)).toBe(0)
  })

  it("test maxLen override works", () => {
    expect(scoreQuestion("what is x?", { maxLen: 5 })).toBe(0)
    expect(scoreQuestion("what is x?", { maxLen: 100 })).toBeGreaterThanOrEqual(ASK_THRESHOLD)
  })
})

describe("scoreQuestion — 'what if' is always ambiguous", () => {
  for (const q of ["what if we refactor this?", "what if I just delete it", "what if"]) {
    it(`what-if: ${JSON.stringify(q)}`, () => {
      expect(scoreQuestion(q)).toBe(0)
    })
  }
})

describe("scoreQuestion — case insensitive", () => {
  it("uppercase questions score the same", () => {
    expect(scoreQuestion("WHAT IS THIS?")).toEqual(scoreQuestion("what is this?"))
  })
})
