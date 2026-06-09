/**
 * End-to-end handler test against the REAL repo tools. Writes a temp .ts file
 * with a type error into the repo (so detection + tsconfig apply), drives the
 * actual `tool.didInvoke` handler, and asserts the payload gets findings +
 * notes. Skipped when tsgo is absent.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import onToolDidInvoke from "./on_tool_did_invoke.ts"

const REPO = join(import.meta.dir, "..", "..", "..")
const tsgoBin = join(REPO, "node_modules", ".bin", "tsgo")

interface Payload {
  tool: string
  input: Record<string, unknown>
  cwd: string
  ok: boolean
  filePath?: string
  findings: unknown[]
  notes: string[]
}

function payloadFor(filePath: string): Payload {
  return {
    tool: "Edit",
    input: { file_path: filePath },
    cwd: REPO,
    ok: true,
    filePath,
    findings: [],
    notes: [],
  }
}

describe("on_tool_did_invoke handler (real tools)", () => {
  it.skipIf(!existsSync(tsgoBin))(
    "attaches type findings + notes for a file with a type error",
    async () => {
      const probe = join(REPO, "src", "__diag_handler_probe.ts")
      writeFileSync(probe, "export const x: number = 'not a number'\n")
      try {
        const payload = payloadFor(probe)
        const res = await onToolDidInvoke(payload, { cwd: REPO, env: {} })
        expect(res).toBeTruthy()
        expect(payload.findings.length).toBeGreaterThan(0)
        expect(payload.notes.some((n) => /TS\d/.test(n))).toBe(true)
      } finally {
        rmSync(probe, { force: true })
      }
    },
    20_000,
  )

  it.skipIf(!existsSync(tsgoBin))("returns nothing for a clean file", async () => {
    const probe = join(REPO, "src", "__diag_handler_clean.ts")
    writeFileSync(probe, "export const x: number = 42\n")
    try {
      const payload = payloadFor(probe)
      const res = await onToolDidInvoke(payload, { cwd: REPO, env: {} })
      // clean file → no findings, handler returns void
      expect(payload.findings).toEqual([])
      expect(res).toBeUndefined()
    } finally {
      rmSync(probe, { force: true })
    }
  })

  it("ignores non-file tools (e.g. Bash)", async () => {
    const payload: Payload = {
      tool: "Bash",
      input: { command: "ls" },
      cwd: REPO,
      ok: true,
      findings: [],
      notes: [],
    }
    const res = await onToolDidInvoke(payload, { cwd: REPO, env: {} })
    expect(res).toBeUndefined()
    expect(payload.findings).toEqual([])
  })

  it("ignores failed tool calls", async () => {
    const payload = payloadFor(join(REPO, "does-not-exist.ts"))
    payload.ok = false
    const res = await onToolDidInvoke(payload, { cwd: REPO, env: {} })
    expect(res).toBeUndefined()
  })
})
