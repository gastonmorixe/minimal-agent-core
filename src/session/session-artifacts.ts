/** Read-only inventory of filesystem artifacts associated with a saved session. */

import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { resolveNetDbgDir, resolveSessionsDir } from "../agent/agent-paths.ts"

import { sessionFilePath } from "./session-store.ts"

export type SessionArtifactKind = "transcript" | "index" | "sidecar" | "blobs" | "network"
export type SessionArtifactStatus = "present" | "missing" | "unavailable"

export interface SessionArtifact {
  kind: SessionArtifactKind
  path: string
  status: SessionArtifactStatus
  isDirectory: boolean
  bytes?: number
  mtimeMs?: number
  error?: string
}

export interface SessionArtifactsManifest {
  sid: string
  sessionsDir: string
  netDbgDir: string
  artifacts: SessionArtifact[]
}

const SAFE_SID = /^[A-Za-z0-9_-]+$/

function inspect(path: string, kind: SessionArtifactKind, isDirectory: boolean): SessionArtifact {
  try {
    const stat = statSync(path)
    const typeMatches = isDirectory ? stat.isDirectory() : stat.isFile()
    if (!typeMatches) return { kind, path, status: "missing", isDirectory }
    return { kind, path, status: "present", isDirectory, bytes: stat.size, mtimeMs: stat.mtimeMs }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code === "ENOENT") return { kind, path, status: "missing", isDirectory }
    return { kind, path, status: "unavailable", isDirectory, error: String(error) }
  }
}

/** Compute a best-effort, deterministic inventory without mutating the filesystem. */
export function inspectSessionArtifacts(
  sid: string,
  options: { sessionsDir?: string; netDbgDir?: string } = {},
): SessionArtifactsManifest {
  if (!SAFE_SID.test(sid)) throw new Error("invalid session id")
  const sessionsDir = options.sessionsDir ?? resolveSessionsDir()
  const netDbgDir = options.netDbgDir ?? resolveNetDbgDir()
  const artifacts: SessionArtifact[] = [
    inspect(sessionFilePath(sid, sessionsDir), "transcript", false),
    inspect(join(sessionsDir, "index.jsonl"), "index", false),
    inspect(join(sessionsDir, `${sid}.blobs`), "blobs", true),
  ]

  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.startsWith(`${sid}.`) || name === `${sid}.jsonl`) continue
      const path = join(sessionsDir, name)
      const item = inspect(path, "sidecar", false)
      if (item.status === "present") artifacts.push(item)
    }
  } catch (error) {
    artifacts.push({
      kind: "sidecar",
      path: sessionsDir,
      status: "unavailable",
      isDirectory: true,
      error: String(error),
    })
  }

  try {
    for (const name of readdirSync(netDbgDir).sort()) {
      if (!name.endsWith(`-minimal-agent-${sid}`)) continue
      const item = inspect(join(netDbgDir, name), "network", true)
      if (item.status === "present") artifacts.push(item)
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code !== "ENOENT") {
      artifacts.push({
        kind: "network",
        path: netDbgDir,
        status: "unavailable",
        isDirectory: true,
        error: String(error),
      })
    }
  }

  return { sid, sessionsDir, netDbgDir, artifacts }
}

/** Format the manifest for human-readable CLI output. */
export function formatSessionArtifacts(manifest: SessionArtifactsManifest): string {
  const lines = [`Session artifacts for ${manifest.sid}`]
  for (const artifact of manifest.artifacts) {
    const label = artifact.kind === "network" ? "network" : artifact.kind
    lines.push(`  ${label.padEnd(10)} ${artifact.status.padEnd(11)} ${artifact.path}`)
  }
  return `${lines.join("\n")}\n`
}
