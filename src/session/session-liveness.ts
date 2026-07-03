/**
 * Session liveness — answer "is an agent currently attached to this session?"
 *
 * Why this exists: a `pid` written to disk is not enough on its own. PIDs
 * get reused by the OS after death. Clean-shutdown markers can be missing
 * (SIGKILL, panic, power loss). And session files may live on a network
 * share / sync'd folder where pids from another host are meaningless.
 *
 * Correctness comes from probing the live OS, NOT from trusting the log:
 *
 *   1. Read the latest unmatched AttachRecord from the JSONL log.
 *   2. If hostname differs from ours → "unknown:remote-host" (decline to
 *      claim either way; the pid is meaningless to us).
 *   3. `kill(pid, 0)` — ESRCH ⇒ "dead:pid-gone".
 *   4. Compare `ps -o lstart=` for that pid against the recorded
 *      `startTime`. Mismatch ⇒ "dead:pid-reused".
 *   5. All checks pass ⇒ "live".
 *
 * The log only narrows the search; the OS adjudicates. We never return
 * `live` based on the log alone.
 */

import { readFileSync } from "node:fs"
import { hostname as osHostname } from "node:os"

import {
  type AttachRecord,
  parseLines,
  readProcessStartTime,
  sessionFilePath,
} from "./session-store.ts"

export type Liveness =
  | {
      status: "live"
      pid: number
      startTime: string
      since: string
      hostname: string
      agentVersion: string
    }
  | {
      status: "dead"
      reason: "no-attach" | "clean-detach" | "pid-gone" | "pid-reused"
      /** Latest pid we saw, for diagnostics (when applicable). */
      pid?: number
    }
  | {
      status: "unknown"
      reason: "remote-host" | "ps-unavailable" | "permission-denied"
      pid: number
      hostname: string
    }

export interface LivenessDeps {
  /** Probe whether a pid is alive on this host. Default: `process.kill(pid, 0)`. */
  probe?: (pid: number) => "alive" | "dead" | "permission-denied"
  /** Read a process's wall-clock start time. Default: `readProcessStartTime`. */
  readStart?: (pid: number) => string | null
  /** Our hostname. Default: `os.hostname()`. */
  hostname?: () => string
}

/**
 * Default kill(0) probe. Returns:
 *   - "alive": signal-0 succeeded (process exists and we own it).
 *   - "dead": ESRCH (no such process).
 *   - "permission-denied": EPERM (process exists but we don't own it; rare
 *     for our case since the agent process is always run as the same user
 *     who owns the session file).
 */
function defaultProbe(pid: number): "alive" | "dead" | "permission-denied" {
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    if (code === "ESRCH") return "dead"
    if (code === "EPERM") return "permission-denied"
    return "dead"
  }
}

/**
 * Determine liveness from already-parsed records (the data-only entry
 * point). Useful when the caller already has the records in hand.
 */
export function livenessFromRecords(
  records: ReturnType<typeof parseLines>["records"],
  deps: LivenessDeps = {},
): Liveness {
  const probe = deps.probe ?? defaultProbe
  const readStart = deps.readStart ?? readProcessStartTime
  const ourHost = (deps.hostname ?? osHostname)()

  // Find the latest attach not followed by a matching detach (by pid).
  let attach: AttachRecord | null = null
  for (const r of records) {
    if (r.kind === "attach") {
      attach = r
    } else if (r.kind === "detach" && attach && r.pid === attach.pid) {
      attach = null
    }
  }
  if (!attach) {
    // Distinguish "never attached" from "cleanly detached" if any detach
    // appeared in the log at all.
    const sawDetach = records.some((r) => r.kind === "detach")
    return { status: "dead", reason: sawDetach ? "clean-detach" : "no-attach" }
  }

  if (attach.hostname !== ourHost) {
    return {
      status: "unknown",
      reason: "remote-host",
      pid: attach.pid,
      hostname: attach.hostname,
    }
  }

  const probeResult = probe(attach.pid)
  if (probeResult === "dead") {
    return { status: "dead", reason: "pid-gone", pid: attach.pid }
  }
  if (probeResult === "permission-denied") {
    // Process exists but isn't ours. Combined with start-time match this
    // is still "dead, pid reused by some other user's process". Without
    // the start time we can't be sure — surface as unknown.
    const live = readStart(attach.pid)
    if (live == null) {
      return {
        status: "unknown",
        reason: "permission-denied",
        pid: attach.pid,
        hostname: attach.hostname,
      }
    }
    if (live !== attach.startTime) {
      return { status: "dead", reason: "pid-reused", pid: attach.pid }
    }
    // Same start-time AND not ours? Extremely unlikely (would require
    // someone to setuid into the same pid+lstart). Treat as live.
    return {
      status: "live",
      pid: attach.pid,
      startTime: attach.startTime,
      since: attach.ts,
      hostname: attach.hostname,
      agentVersion: attach.agentVersion,
    }
  }

  // probeResult === "alive": pid exists and we own it. Pin with start-time.
  const live = readStart(attach.pid)
  if (live == null) {
    // ps unavailable — trust kill(0). PID exists, ours, treat as live but
    // mark unknown so callers can decide how strict to be.
    return {
      status: "unknown",
      reason: "ps-unavailable",
      pid: attach.pid,
      hostname: attach.hostname,
    }
  }
  if (live !== attach.startTime) {
    return { status: "dead", reason: "pid-reused", pid: attach.pid }
  }
  return {
    status: "live",
    pid: attach.pid,
    startTime: attach.startTime,
    since: attach.ts,
    hostname: attach.hostname,
    agentVersion: attach.agentVersion,
  }
}

/**
 * Convenience wrapper: read the JSONL file at `<dir>/<sid>.jsonl`, parse,
 * and run liveness. Missing/empty file → "dead:no-attach". I/O errors
 * other than ENOENT propagate.
 */
export function getSessionLiveness(
  sid: string,
  opts: { dir?: string } & LivenessDeps = {},
): Liveness {
  const path = sessionFilePath(sid, opts.dir)
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { status: "dead", reason: "no-attach" }
    }
    throw e
  }
  const { records } = parseLines(text)
  return livenessFromRecords(records, opts)
}
