import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { inspectSessionArtifacts } from "./session-artifacts.ts"

describe("inspectSessionArtifacts", () => {
  test("reports canonical artifacts and matching sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "ma-artifacts-"))
    const sid = "sid-123"
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, `${sid}.jsonl`), "{}\n")
    writeFileSync(join(root, `${sid}.tasks.jsonl`), "{}\n")
    writeFileSync(join(root, `${sid}.scratch.md`), "notes\n")
    writeFileSync(join(root, "other.jsonl"), "{}\n")
    mkdirSync(join(root, `${sid}.blobs`))

    const manifest = inspectSessionArtifacts(sid, {
      sessionsDir: root,
      netDbgDir: join(root, "net-dbg"),
    })
    expect(manifest.artifacts.slice(0, 3).map((a) => a.status)).toEqual([
      "present",
      "missing",
      "present",
    ])
    expect(manifest.artifacts.filter((a) => a.kind === "sidecar").map((a) => a.path)).toEqual([
      join(root, `${sid}.scratch.md`),
      join(root, `${sid}.tasks.jsonl`),
    ])
  })

  test("finds only immediate matching network captures", () => {
    const root = mkdtempSync(join(tmpdir(), "ma-artifacts-net-"))
    const net = join(root, "net-dbg")
    const sid = "sid-123"
    mkdirSync(net, { recursive: true })
    mkdirSync(join(net, `123-minimal-agent-${sid}`))
    mkdirSync(join(net, `456-minimal-agent-other`))
    writeFileSync(join(net, `789-minimal-agent-${sid}`), "not a directory")

    const manifest = inspectSessionArtifacts(sid, { sessionsDir: root, netDbgDir: net })
    expect(manifest.artifacts.filter((a) => a.kind === "network").map((a) => a.path)).toEqual([
      join(net, `123-minimal-agent-${sid}`),
    ])
  })

  test("rejects path traversal ids", () => {
    expect(() => inspectSessionArtifacts("../escape")).toThrow("invalid session id")
  })
})
