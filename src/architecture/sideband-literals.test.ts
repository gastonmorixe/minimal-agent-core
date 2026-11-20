/**
 * Core gate of the sideband guard (design section 5, step 1).
 *
 * THE RATCHET: the count of hand-written tag literals, tag regexes, tag
 * searches and bracket notices in core cannot grow. Roots: `src`,
 * `plugin-api/src`, `scripts`. Non-test files count in the `code` baseline,
 * `*.test.ts` files in the `tests` baseline.
 *
 * - A count above its baseline entry FAILS (`grown`).
 * - With `SIDEBAND_BASELINE_TIGHT=1`, a count below its entry FAILS too
 *   (`stale`): lower the baseline.
 * - `UPDATE_SIDEBAND_BASELINE=1` writes `sideband-literals.baseline.json`
 *   again and throws if a count grew. Workers do not edit the baseline. The
 *   lead runs the update after each merge wave.
 *
 * @module architecture/sideband-literals.test
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  compareToBaseline,
  countSidebandFindings,
  DEFAULT_SBL_ALLOW,
  type SblBaseline,
  scanSidebandLiterals,
} from "./sideband-literal-scan.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..")
const BASELINE_PATH = join(import.meta.dirname, "sideband-literals.baseline.json")
const INCLUDE = ["src/**", "plugin-api/src/**", "scripts/**"]

/** The baseline file: one map for non-test files, one for `*.test.ts` files. */
interface BaselineFile {
  code: SblBaseline
  tests: SblBaseline
}

const isTest = (file: string): boolean => file.endsWith(".test.ts")

const found = scanSidebandLiterals({ root: REPO_ROOT, include: INCLUDE, allow: DEFAULT_SBL_ALLOW })
const groups = {
  code: found.filter((f) => !isTest(f.file)),
  tests: found.filter((f) => isTest(f.file)),
}

const readBaseline = (): BaselineFile =>
  existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile)
    : { code: {}, tests: {} }

if (process.env.UPDATE_SIDEBAND_BASELINE === "1") {
  // A first run with no file writes the start baseline.
  if (existsSync(BASELINE_PATH)) {
    const old = readBaseline()
    const grown = [
      ...compareToBaseline(groups.code, old.code).grown,
      ...compareToBaseline(groups.tests, old.tests).grown,
    ]
    if (grown.length > 0) {
      throw new Error(`sideband baseline: a count grew, fix the code first:\n${grown.join("\n")}`)
    }
  }
  const next: BaselineFile = {
    code: countSidebandFindings(groups.code),
    tests: countSidebandFindings(groups.tests),
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
}

const baseline = readBaseline()
const diff = {
  code: compareToBaseline(groups.code, baseline.code),
  tests: compareToBaseline(groups.tests, baseline.tests),
}

const tight = process.env.SIDEBAND_BASELINE_TIGHT === "1"

describe("sideband literal ratchet (core)", () => {
  it("has a baseline file", () => {
    expect(existsSync(BASELINE_PATH)).toBe(true)
  })

  for (const group of ["code", "tests"] as const) {
    it(`no ${group} count grows`, () => {
      const detail = groups[group]
        .filter((f) => diff[group].grown.some((g) => g.startsWith(`${f.file} ${f.rule}:`)))
        .map((f) => `${f.file}:${f.line} ${f.rule} ${f.text}`)
      expect({ grown: diff[group].grown, detail }).toEqual({ grown: [], detail: [] })
    })

    it.skipIf(!tight)(`no ${group} entry is stale (SIDEBAND_BASELINE_TIGHT=1)`, () => {
      expect(diff[group].stale).toEqual([])
    })
  }
})
