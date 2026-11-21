/**
 * The catalog with a token count that is not known: a session with a turn
 * that has no billed usage and a model with no estimator. Such a summary is
 * not written to the sidecar, so an estimator that a plugin registers later
 * can give the count.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { defaultCapabilities } from "../llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import { makeCharRatioEstimator } from "../llm/token-estimate.ts"

import { defaultSessionCatalogIo, listSessions, type SessionCatalogIo } from "./session-catalog.ts"
import {
  type IndexSummaryRecord,
  indexFilePath,
  indexMetaFilePath,
  SessionStore,
  sessionFilePath,
} from "./session-store.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-session-catalog-unk-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const base = {
  model: "test-model",
  cwd: "/tmp/proj",
  systemHash: "",
  toolsHash: "",
  agentVersion: "test",
}

/** A fixed time in the past, so the no-attach rules do not depend on the clock. */
function iso(minute: number): string {
  return new Date(Date.UTC(2026, 0, 19, 0, minute)).toISOString()
}

/** Set the file mtime to its last record time, as in real use. */
function setMtime(sid: string, at: string): void {
  const t = new Date(at)
  utimesSync(sessionFilePath(sid, dir), t, t)
}

/** The JSON lines of one file; `[]` when it is missing. */
function jsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** The lines of `index.jsonl`, then the lines of the sidecar `index-meta.jsonl`. */
function indexLines(): Record<string, unknown>[] {
  return [...jsonLines(indexFilePath(dir)), ...jsonLines(indexMetaFilePath(dir))]
}

/** An io that counts the summary appends. */
function countingIo(): SessionCatalogIo & { appends: number } {
  const io = {
    ...defaultSessionCatalogIo,
    appends: 0,
    appendSummary(indexPath: string, line: IndexSummaryRecord): boolean {
      io.appends += 1
      return defaultSessionCatalogIo.appendSummary(indexPath, line)
    },
  }
  return io
}

describe("listSessions unknown token count (no estimator)", () => {
  afterEach(() => clearModelRegistry())

  /** A closed session with one assistant turn that has no billed usage. */
  function seedUnbilled(sid: string, minute: number): void {
    const store = SessionStore.open({
      ...base,
      model: "no-estimator-model",
      sid,
      dir,
      lineage: null,
      now: () => new Date(iso(minute)),
    })
    store.appendUser("count me", new Date(iso(minute)))
    store.appendAssistant(
      [{ type: "text", text: "a reply" }],
      "end_turn",
      undefined,
      new Date(iso(minute)),
    )
    store.appendDetach("exit", 0, new Date(iso(minute + 1)))
    setMtime(sid, iso(minute + 1))
  }

  test("an unknown count is not written to the sidecar, and a later estimator computes it", () => {
    seedUnbilled("unk-1", 0)
    // The store did not write a summary line on detach.
    expect(indexLines().some((l) => l.kind === "summary")).toBe(false)
    const io = countingIo()
    const out = listSessions({ dir, io })
    expect(out.rows[0].summarySource).toBe("computed")
    expect(out.rows[0].summary?.tokensUnknown).toBe(true)
    expect(out.rows[0].summary?.estimated).toBe(true)
    expect(io.appends).toBe(0)
    expect(indexLines().some((l) => l.kind === "summary")).toBe(false)

    // A plugin registers an estimator later: the next listing has a count.
    registerModel({
      id: "no-estimator-model",
      providerId: "cat-prov",
      surfaceId: "custom",
      displayName: "no-estimator-model",
      capabilities: defaultCapabilities(),
      pricing: {
        inputUSD: 0,
        outputUSD: 0,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
      estimateTokens: makeCharRatioEstimator(4),
    })
    const io2 = countingIo()
    const again = listSessions({ dir, io: io2 })
    expect(again.rows[0].summarySource).toBe("computed")
    expect(again.rows[0].summary?.tokensUnknown).toBeUndefined()
    expect(again.rows[0].summary?.tokens).toBeGreaterThan(0)
    expect(io2.appends).toBe(1)
    const line = indexLines().find((l) => l.kind === "summary")
    expect(line?.tokensUnknown).toBeUndefined()
  })

  test("an old sidecar line with an estimate of 0 tokens is computed again", () => {
    seedUnbilled("unk-2", 0)
    const old: IndexSummaryRecord = {
      kind: "summary",
      sid: "unk-2",
      v: 3,
      title: "count me",
      tokens: 0,
      estimated: true,
      turns: 1,
      endedAt: iso(1),
      status: "done",
    }
    writeFileSync(indexMetaFilePath(dir), `${JSON.stringify(old)}\n`)
    const out = listSessions({ dir })
    expect(out.rows[0].summarySource).toBe("computed")
    expect(out.rows[0].summary?.tokensUnknown).toBe(true)
  })
})
