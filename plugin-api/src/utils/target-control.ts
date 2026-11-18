/**
 * The control channel that moves a RUNNING sub-agent to a new target
 * (credential, provider, model, effort) when its lead switches. The worker
 * keeps its process, its history and its work.
 *
 * The lead appends one signed line to `<sessionsDir>/<childSid>.control.jsonl`
 * for each switch. The worker polls its file, checks each new line, applies
 * the follow rule, and switches its own core. This module is the part both
 * sides share: the line format, the key derivation and the signature. It is
 * pure (no file I/O, no state), so a plugin and a host use the same bytes.
 * The file I/O and the `seq` state are in the sub-agents plugin (lead) and
 * in the CLI (worker). The follow rule is in the CLI: only a worker runs it.
 *
 * Security. A line can change the credential and the provider of a worker,
 * so a worker must accept a line only from its lead:
 *
 * - The lead has one secret, in memory only. Each worker gets its own key,
 *   `HMAC-SHA256(secret, childSid)`, in its environment at spawn. The worker
 *   reads it and removes it from its environment. The key is never in the
 *   file.
 * - Each line has a `mac` over every other field. A reader of the file
 *   cannot make a valid line.
 * - `seq` must be higher than the last accepted one, so an old line cannot
 *   be sent again, also after the file was cut.
 * - A line names only a credential and a provider. It never has a token, a
 *   key or an endpoint. The worker accepts only a credential that is
 *   already stored on the machine.
 *
 * Limit: a process of the same OS user can read the environment of another
 * process, and can edit the auth store. This channel stops a one-step
 * "append a line to this file" instruction. It does not stop an attacker
 * that already runs commands as the user.
 *
 * @experimental The line format can change until the feature is stable.
 *
 * @module plugin-api/utils/target-control
 */

import { createHmac, timingSafeEqual } from "node:crypto"

/** Env key: the path of the worker's control file. The worker removes it at boot. */
export const ENV_TARGET_CONTROL_FILE = "MINIMAL_AGENT_TARGET_CONTROL_FILE"
/** Env key: the worker's key (hex). The worker removes it at boot. */
export const ENV_TARGET_CONTROL_KEY = "MINIMAL_AGENT_TARGET_CONTROL_KEY"

/** Format version of a line. */
export const TARGET_CONTROL_VERSION = 1
/** The one line kind. A reader skips each other kind. */
export const SWITCH_TARGET_KIND = "switch_target"
/** Longest line a reader accepts, in bytes. */
export const MAX_CONTROL_LINE_BYTES = 8 * 1024
/** Most bytes a reader takes from the file in one poll. */
export const MAX_CONTROL_READ_BYTES = 256 * 1024

/** One target in a line. The same fields as a core `TargetSnapshot`. */
export interface ControlTarget {
  credentialName?: string
  providerId?: string
  model: string
  effort?: string
}

/** One line of the control file: the lead's target before and after one switch. */
export interface SwitchTargetLine {
  v: typeof TARGET_CONTROL_VERSION
  /** Goes up with each line of one lead process. */
  seq: number
  /** ISO time of the switch. */
  ts: string
  /** Session id of the lead that wrote the line. */
  lead: string
  kind: typeof SWITCH_TARGET_KIND
  from: ControlTarget
  to: ControlTarget
  /** HMAC-SHA256 (hex) of every field above, with the worker's key. */
  mac: string
}

/** Why a reader did not accept one line. Never has the line text. */
export type ControlReject =
  | "too_long"
  | "bad_json"
  | "bad_shape"
  | "unknown_kind"
  | "bad_mac"
  | "wrong_lead"
  | "old_seq"

/**
 * The control file of one worker.
 *
 * @throws Error when `childSid` is not a plain id (letters, digits, `-`, `_`, `.`,
 *   and not only dots), so the result is always a file of `sessionsDir`
 */
export function controlPathFor(sessionsDir: string, childSid: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(childSid) || /^\.+$/.test(childSid)) {
    throw new Error("target control: the worker id is not a plain id")
  }
  return `${sessionsDir}/${childSid}.control.jsonl`
}

/** The key of one worker, from the lead's secret. Hex. */
export function deriveControlKey(secret: string, childSid: string): string {
  return createHmac("sha256", secret).update(`control-key:${childSid}`).digest("hex")
}

/**
 * A short public id of a lead secret. A lead stores it with a worker record,
 * so a restarted lead (a new secret) knows that it cannot reach that worker.
 */
export function controlKeyId(secret: string): string {
  return createHmac("sha256", secret).update("control-key-id").digest("hex").slice(0, 16)
}

const targetFields = (t: ControlTarget): (string | null)[] => [
  t.credentialName ?? null,
  t.providerId ?? null,
  t.model,
  t.effort ?? null,
]

/**
 * The exact bytes the `mac` covers: JSON of one array in a fixed order.
 * JSON keeps each value apart, so no name can look like two fields.
 */
function macInput(line: Omit<SwitchTargetLine, "mac">): string {
  return JSON.stringify([
    line.v,
    line.seq,
    line.ts,
    line.lead,
    line.kind,
    targetFields(line.from),
    targetFields(line.to),
  ])
}

function macOf(key: string, line: Omit<SwitchTargetLine, "mac">): string {
  return createHmac("sha256", key).update(macInput(line)).digest("hex")
}

/** Build one signed line. The result is one JSON object: write it with a `\n`. */
export function signSwitchLine(
  key: string,
  fields: { seq: number; ts: string; lead: string; from: ControlTarget; to: ControlTarget },
): SwitchTargetLine {
  const body: Omit<SwitchTargetLine, "mac"> = {
    v: TARGET_CONTROL_VERSION,
    seq: fields.seq,
    ts: fields.ts,
    lead: fields.lead,
    kind: SWITCH_TARGET_KIND,
    from: cleanTarget(fields.from),
    to: cleanTarget(fields.to),
  }
  return { ...body, mac: macOf(key, body) }
}

/** Only the four known fields, with no `undefined` value. */
function cleanTarget(t: ControlTarget): ControlTarget {
  return {
    ...(t.credentialName !== undefined ? { credentialName: t.credentialName } : {}),
    ...(t.providerId !== undefined ? { providerId: t.providerId } : {}),
    model: t.model,
    ...(t.effort !== undefined ? { effort: t.effort } : {}),
  }
}

const optionalString = (v: unknown): v is string | undefined =>
  v === undefined || typeof v === "string"

function asTarget(v: unknown): ControlTarget | null {
  if (v === null || typeof v !== "object") return null
  const t = v as Record<string, unknown>
  if (typeof t.model !== "string" || t.model.length === 0) return null
  if (!optionalString(t.credentialName) || !optionalString(t.providerId)) return null
  if (!optionalString(t.effort)) return null
  return cleanTarget(t as unknown as ControlTarget)
}

/** What {@link readSwitchLines} needs to accept a line. */
export interface ControlReadOptions {
  /** The worker's key (hex). */
  key: string
  /** The session id of the worker's lead. */
  lead: string
  /** The last accepted `seq`. A line must be higher. */
  afterSeq: number
}

/** The lines a reader accepted, in file order, and why it skipped the others. */
export interface ControlReadResult {
  lines: SwitchTargetLine[]
  rejects: ControlReject[]
  /** The highest accepted `seq`, or `afterSeq` when no line was accepted. */
  lastSeq: number
}

/**
 * Check complete lines of a control file. `text` must end at a line end:
 * the caller keeps a partial last line for its next read. A line that fails
 * a check is skipped, and the next lines are still read.
 */
export function readSwitchLines(text: string, opts: ControlReadOptions): ControlReadResult {
  const lines: SwitchTargetLine[] = []
  const rejects: ControlReject[] = []
  let lastSeq = opts.afterSeq
  for (const raw of text.split("\n")) {
    if (raw.trim().length === 0) continue
    const checked = checkLine(raw, opts.key, opts.lead, lastSeq)
    if (typeof checked === "string") {
      rejects.push(checked)
      continue
    }
    lines.push(checked)
    lastSeq = checked.seq
  }
  return { lines, rejects, lastSeq }
}

function checkLine(
  raw: string,
  key: string,
  lead: string,
  afterSeq: number,
): SwitchTargetLine | ControlReject {
  if (Buffer.byteLength(raw, "utf8") > MAX_CONTROL_LINE_BYTES) return "too_long"
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return "bad_json"
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "bad_shape"
  const o = parsed as Record<string, unknown>
  if (o.v !== TARGET_CONTROL_VERSION || o.kind !== SWITCH_TARGET_KIND) {
    return typeof o.kind === "string" && typeof o.v === "number" ? "unknown_kind" : "bad_shape"
  }
  const from = asTarget(o.from)
  const to = asTarget(o.to)
  if (!from || !to) return "bad_shape"
  if (typeof o.seq !== "number" || !Number.isSafeInteger(o.seq)) return "bad_shape"
  if (typeof o.ts !== "string" || typeof o.lead !== "string") return "bad_shape"
  if (typeof o.mac !== "string") return "bad_shape"
  const body: Omit<SwitchTargetLine, "mac"> = {
    v: TARGET_CONTROL_VERSION,
    seq: o.seq,
    ts: o.ts,
    lead: o.lead,
    kind: SWITCH_TARGET_KIND,
    from,
    to,
  }
  // The mac before the lead and seq checks: an unsigned line with a correct
  // shape must not tell which of those two it would fail.
  const want = Buffer.from(macOf(key, body), "hex")
  const got = Buffer.from(o.mac, "hex")
  if (got.length !== want.length || !timingSafeEqual(got, want)) return "bad_mac"
  if (body.lead !== lead) return "wrong_lead"
  if (body.seq <= afterSeq) return "old_seq"
  return { ...body, mac: o.mac }
}
