import { readFileSync, renameSync, writeFileSync } from "node:fs"

import type { Message } from "../llm/messages.ts"

import { foldRecordsForModel, repairMessages } from "./session-restore.ts"
import {
  defaultSessionsDir,
  indexFilePath,
  type MetaRecord,
  parseLines,
  type SessionRecord,
  sessionFilePath,
} from "./session-store.ts"

export type HistoryEditResult<T> = { ok: true } & T
export type HistoryEditFailure = { ok: false; code: string; message: string }

export interface BeginHistoryEditInput {
  sid: string
  targetUserId: string
}

export interface CommitHistoryEditInput extends BeginHistoryEditInput {
  backupSid: string
}

/** Validated strict prefix prepared before the active transcript is rewritten. */
export interface PreparedHistoryEdit {
  ok: true
  targetRecordIndex: number
  targetUserId: string
  modelMessages: Message[]
}

/**
 * Validate an edit target and prepare the repaired model history strictly
 * before it, without mutating the active transcript.
 */
export function prepareHistoryEdit(
  input: BeginHistoryEditInput,
  deps: { dir?: string } = {},
): PreparedHistoryEdit | HistoryEditFailure {
  const dir = deps.dir ?? defaultSessionsDir()
  if (!safeSid(input.sid) || !safeSid(input.targetUserId))
    return invalid("invalid session or user id")
  const text = read(sessionFilePath(input.sid, dir))
  if (text === null) return failure("not_found", `session not found: ${input.sid}`)
  const { records } = parseLines(text)
  const targetRecordIndex = records.findIndex(
    (r) => r.kind === "user" && r.id === input.targetUserId,
  )
  if (targetRecordIndex < 0)
    return failure("target_not_found", "selected user prompt no longer exists")
  return {
    ok: true,
    targetRecordIndex,
    targetUserId: input.targetUserId,
    modelMessages: repairMessages(foldRecordsForModel(records.slice(0, targetRecordIndex))),
  }
}

/**
 * Host-owned, filesystem-only transaction for the first history-edit slice.
 * It creates a complete archival copy before the active JSONL gets an atomic
 * strict-prefix replacement. Pending-intent recovery is deliberately deferred.
 */
export function beginHistoryEdit(
  input: BeginHistoryEditInput,
  deps: { dir?: string; now?: () => Date } = {},
):
  | HistoryEditResult<{
      backupSid: string
      selectedText: string
      targetRecordIndex: number
      userPromptOrdinal: number
      totalUserPrompts: number
    }>
  | HistoryEditFailure {
  const dir = deps.dir ?? defaultSessionsDir()
  if (!safeSid(input.sid) || !safeSid(input.targetUserId))
    return invalid("invalid session or user id")
  const sourcePath = sessionFilePath(input.sid, dir)
  const sourceText = read(sourcePath)
  if (sourceText === null) return failure("not_found", `session not found: ${input.sid}`)
  const { records } = parseLines(sourceText)
  const targetRecordIndex = records.findIndex(
    (r) => r.kind === "user" && r.id === input.targetUserId,
  )
  if (targetRecordIndex < 0)
    return failure("target_not_found", "selected user prompt no longer exists")
  const target = records[targetRecordIndex]
  if (!target || target.kind !== "user")
    return failure("target_not_found", "selected record is not a user prompt")
  const users = records.filter(
    (r): r is Extract<SessionRecord, { kind: "user" }> => r.kind === "user",
  )
  const userPromptOrdinal = users.findIndex((r) => r.id === input.targetUserId) + 1
  const backupSid = nextBackupSid(input.sid, dir)
  const backupPath = sessionFilePath(backupSid, dir)
  const now = (deps.now ?? (() => new Date()))().toISOString()
  const backupText = makeBackupText(records, backupSid, input.sid, now)
  writeFileSync(backupPath, backupText, { flag: "wx" })
  appendBackupIndex(records, backupSid, input.sid, dir, now)
  // First slice guarantees the JSONL timeline only. Sidecars remain on the
  // active session and are intentionally not claimed as archival state yet.
  return {
    ok: true,
    backupSid,
    selectedText: textContent(target.content),
    targetRecordIndex,
    userPromptOrdinal,
    totalUserPrompts: users.length,
  }
}

/**
 * Atomically replace the active transcript with the strict prefix and a
 * durable history-edit audit record after a backup has been verified.
 */
export function commitHistoryEdit(
  input: CommitHistoryEditInput,
  deps: { dir?: string; now?: () => Date } = {},
): HistoryEditResult<{ droppedRecordCount: number }> | HistoryEditFailure {
  const dir = deps.dir ?? defaultSessionsDir()
  if (![input.sid, input.targetUserId, input.backupSid].every(safeSid))
    return invalid("invalid history edit input")
  const path = sessionFilePath(input.sid, dir)
  const text = read(path)
  if (text === null) return failure("not_found", `session not found: ${input.sid}`)
  const { records } = parseLines(text)
  const targetIndex = records.findIndex((r) => r.kind === "user" && r.id === input.targetUserId)
  if (targetIndex < 0) return failure("target_not_found", "selected user prompt no longer exists")
  if (read(sessionFilePath(input.backupSid, dir)) === null)
    return failure("backup_not_found", "history edit backup is missing")
  const prefix = records.slice(0, targetIndex)
  const droppedRecordCount = records.length - targetIndex
  const audit = {
    kind: "history_edit" as const,
    ts: (deps.now ?? (() => new Date()))().toISOString(),
    targetUserId: input.targetUserId,
    backupSid: input.backupSid,
    droppedRecordCount,
  }
  const replacement = `${[...prefix, audit].map((r) => JSON.stringify(r)).join("\n")}\n`
  const tmp = `${path}.history-edit-${process.pid}-${Date.now()}.tmp`
  try {
    writeFileSync(tmp, replacement, { flag: "wx" })
    renameSync(tmp, path)
  } catch (err) {
    return failure("write_failed", err instanceof Error ? err.message : String(err))
  }
  return { ok: true, droppedRecordCount }
}

function nextBackupSid(sid: string, dir: string): string {
  for (let n = 1; ; n++) {
    const candidate = `${sid}-backup-${String(n).padStart(2, "0")}`
    if (read(sessionFilePath(candidate, dir)) === null) return candidate
  }
}

function makeBackupText(
  records: SessionRecord[],
  backupSid: string,
  sourceSid: string,
  createdAt: string,
): string {
  return `${records
    .filter((r) => r.kind !== "meta" && r.kind !== "attach" && r.kind !== "detach")
    .reduce<string[]>((lines, r, index) => {
      if (index === 0) {
        const sourceMeta = records.find((x): x is MetaRecord => x.kind === "meta")
        if (!sourceMeta) throw new Error("session has no meta record")
        lines.push(
          JSON.stringify({
            ...sourceMeta,
            sid: backupSid,
            createdAt,
            backup: true,
            backupOfSid: sourceSid,
          }),
        )
      }
      lines.push(JSON.stringify(r))
      return lines
    }, [])
    .join("\n")}\n`
}

function appendBackupIndex(
  records: SessionRecord[],
  backupSid: string,
  sourceSid: string,
  dir: string,
  createdAt: string,
): void {
  const meta = records.find((r): r is MetaRecord => r.kind === "meta")
  if (!meta) throw new Error("session has no meta record")
  writeFileSync(
    indexFilePath(dir),
    `${JSON.stringify({ sid: backupSid, createdAt, cwd: meta.cwd, model: meta.model, backup: true, backupOfSid: sourceSid })}\n`,
    { flag: "a" },
  )
}

function textContent(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === "string"
    ? content
    : content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
function safeSid(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}
function invalid(message: string): HistoryEditFailure {
  return failure("invalid_input", message)
}
function failure(code: string, message: string): HistoryEditFailure {
  return { ok: false, code, message }
}
