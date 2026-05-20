/**
 * Unit tests for `FooterAggregator`.
 *
 * Merges two sources of footer lines:
 *
 *   1. `diagnosticSink()` — 0..2 lines from `TuiDiagnosticSurface`.
 *   2. `pluginSink()` — N lines from `LiveAreaScheduler` (quota row, etc).
 *
 * The merged ordering top-to-bottom is `[diagnostic..., plugin...]`. The
 * aggregator pushes the combined array to the editor's
 * `setFooterLines` on every change. Decoration lines (header band)
 * passthrough untouched via `setDecoration`.
 */

import { describe, expect, it } from "bun:test"
import { FooterAggregator } from "./log-aggregator.ts"

interface Tap {
  footer: string[][]
  decoration: string[][]
  push: (lines: string[]) => void
  decorate: (lines: string[]) => void
}

function tap(): Tap {
  const footer: string[][] = []
  const decoration: string[][] = []
  return {
    footer,
    decoration,
    push: (lines) => footer.push([...lines]),
    decorate: (lines) => decoration.push([...lines]),
  }
}

describe("FooterAggregator — single source", () => {
  it("renders only diagnostic lines when plugin sink is silent", () => {
    const t = tap()
    const agg = new FooterAggregator(t.push, t.decorate)
    agg.diagnosticSink().setDiagnosticLines(["⚠ warn 1"])
    expect(t.footer).toEqual([["⚠ warn 1"]])
  })

  it("renders only plugin lines when diagnostic sink is silent", () => {
    const t = tap()
    const agg = new FooterAggregator(t.push, t.decorate)
    const plug = agg.pluginSink()
    plug.setFooterLines?.(["5h 12% 7d 5%"])
    expect(t.footer).toEqual([["5h 12% 7d 5%"]])
  })
})

describe("FooterAggregator — merge order", () => {
  it("diagnostic lines come BEFORE plugin lines", () => {
    const t = tap()
    const agg = new FooterAggregator(t.push, t.decorate)
    agg.diagnosticSink().setDiagnosticLines(["⚠ a", "✗ b"])
    agg.pluginSink().setFooterLines?.(["q1", "q2"])
    expect(t.footer[t.footer.length - 1]).toEqual(["⚠ a", "✗ b", "q1", "q2"])
  })

  it("each setDiagnosticLines triggers a fresh push merging current plugin lines", () => {
    const t = tap()
    const agg = new FooterAggregator(t.push, t.decorate)
    agg.pluginSink().setFooterLines?.(["plugin row"])
    agg.diagnosticSink().setDiagnosticLines(["⚠ first"])
    agg.diagnosticSink().setDiagnosticLines(["⚠ second"])
    expect(t.footer[t.footer.length - 1]).toEqual(["⚠ second", "plugin row"])
  })

  it("each setFooterLines triggers a fresh push merging current diagnostic lines", () => {
    const t = tap()
    const agg = new FooterAggregator(t.push, t.decorate)
    agg.diagnosticSink().setDiagnosticLines(["⚠ warn"])
    agg.pluginSink().setFooterLines?.(["q1"])
    agg.pluginSink().setFooterLines?.(["q2"])
    expect(t.footer[t.footer.length - 1]).toEqual(["⚠ warn", "q2"])
  })
})

describe("FooterAggregator — empty array semantics", () => {
  it("clearing diagnostic to [] keeps plugin lines visible", () => {
    const t = tap()
    const agg = new FooterAggregator(t.push, t.decorate)
    agg.diagnosticSink().setDiagnosticLines(["⚠ warn"])
    agg.pluginSink().setFooterLines?.(["q"])
    agg.diagnosticSink().setDiagnosticLines([])
    expect(t.footer[t.footer.length - 1]).toEqual(["q"])
  })

  it("clearing plugin to [] keeps diagnostic lines visible", () => {
    const t = tap()
    const agg = new FooterAggregator(t.push, t.decorate)
    agg.diagnosticSink().setDiagnosticLines(["⚠ warn"])
    agg.pluginSink().setFooterLines?.(["q"])
    agg.pluginSink().setFooterLines?.([])
    expect(t.footer[t.footer.length - 1]).toEqual(["⚠ warn"])
  })

  it("both empty → push []", () => {
    const t = tap()
    const agg = new FooterAggregator(t.push, t.decorate)
    agg.diagnosticSink().setDiagnosticLines([])
    agg.pluginSink().setFooterLines?.([])
    expect(t.footer[t.footer.length - 1]).toEqual([])
  })
})

describe("FooterAggregator — decoration passthrough", () => {
  it("plugin sink's setDecorationLines forwards directly to the decorate hook", () => {
    const t = tap()
    const agg = new FooterAggregator(t.push, t.decorate)
    agg.pluginSink().setDecorationLines?.(["queue: x"])
    expect(t.decoration).toEqual([["queue: x"]])
    expect(t.footer).toEqual([]) // no footer push
  })
})

describe("FooterAggregator — initial state", () => {
  it("does not push until something is set", () => {
    const t = tap()
    // Construct without binding to a variable — the test only cares
    // about the constructor's side effects (it should NOT call either
    // sink). Bind to `_` to silence `eslint(no-new)`.
    const _agg = new FooterAggregator(t.push, t.decorate)
    expect(_agg).toBeDefined()
    expect(t.footer).toEqual([])
    expect(t.decoration).toEqual([])
  })
})
