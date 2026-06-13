/**
 * Model-facing plain-text for the tool results (the `content` field). Distinct
 * from the ANSI `display` chrome: this is what the LEAD model reads, so it is
 * compact, parseable, and bounded — never a worker's full transcript.
 *
 * @module sub-agents/lib/content
 */

import { fmtElapsed, fmtTokens } from "./style.ts"
import { fleetStats, type SubagentRecord, type SubagentStatus } from "./types.ts"

function statusText(s: SubagentStatus, nowMs: number): string {
  switch (s.kind) {
    case "queued":
      return "queued"
    case "running": {
      const el = fmtElapsed(nowMs - Date.parse(s.startedAt))
      return `running ${el} · ${s.progress.tools} tools · ${fmtTokens(s.progress.tokens)} tok${s.progress.lastTool ? ` · ${s.progress.lastTool}` : ""}`
    }
    case "done":
      return `done · ${fmtTokens(s.result.tokens)} tok · ${s.result.tools} tools`
    case "incomplete":
      return `incomplete · no deliverable (${s.reason}) · ${fmtTokens(s.tokens)} tok · ${s.tools} tools`
    case "failed":
      return `failed · ${s.error}`
    case "stopped":
      return `stopped${s.reason ? ` · ${s.reason}` : ""}`
    default: {
      throw new Error(`unhandled status kind: ${String(s satisfies never)}`)
    }
  }
}

/** One-line summary for a worker (for ListAgents / AgentStatus content). */
export function recordLine(r: SubagentRecord, nowMs: number): string {
  return `${r.id}  ${r.type.padEnd(10)}  ${statusText(r.status, nowMs)}`
}

/** The full fleet, as model-facing text. */
export function fleetText(records: readonly SubagentRecord[], nowMs: number): string {
  if (records.length === 0) {
    return "No sub-agents in this session. Use SpawnAgent to delegate a unit of work."
  }
  const s = fleetStats(records)
  const head = `Fleet: ${s.running} running · ${s.queued} queued · ${s.done} done · ${s.failed} failed · ${s.stopped} stopped · ${fmtTokens(s.tokens)} tok total`
  const rows = records.map((r) => recordLine(r, nowMs))
  const tail = s.done > 0 ? "\nPull a finished worker's deliverable with AgentResult <id>." : ""
  return `${head}\n\n${rows.join("\n")}${tail}`
}

/** One worker's detail (AgentStatus). */
export function statusDetail(r: SubagentRecord, nowMs: number): string {
  const lines = [
    `${r.id} (${r.type}) · model ${r.model} · isolation ${r.isolation} · depth ${r.depth}`,
    `status: ${statusText(r.status, nowMs)}`,
    `session: ${r.sid}`,
    `task: ${r.task}`,
  ]
  if (r.status.kind === "done") lines.push(`result: ${r.status.result.short}`)
  return lines.join("\n")
}

/** A finished worker's distilled deliverable (AgentResult). */
export function resultText(r: SubagentRecord): string {
  switch (r.status.kind) {
    case "done": {
      const res = r.status.result
      const arts =
        res.artifacts && res.artifacts.length > 0 ? `\nartifacts: ${res.artifacts.join(", ")}` : ""
      const note = res.distilled
        ? "\n\n(note: distilled from the worker's final message — it wrote no structured result sentinel, so this summary is best-effort and lists no artifacts)"
        : ""
      return `Sub-agent ${r.id} (${r.type}) result:\n\n${res.short}${arts}\n\n(${fmtTokens(res.tokens)} tokens · ${res.tools} tool calls)${note}`
    }
    case "incomplete": {
      const spent = r.status.tokens
        ? ` (spent ${fmtTokens(r.status.tokens)} tokens · ${r.status.tools} tool calls)`
        : ""
      if (r.status.salvage) {
        // The contract was not met (a required file is missing/empty), but the
        // worker DID produce a synthesis. Surface it so the lead can act on the
        // work without mining the transcript — while making clear it's unverified
        // and the file the lead asked for does NOT exist.
        const arts =
          r.status.artifacts && r.status.artifacts.length > 0
            ? `\nclaimed artifacts (VERIFY — at least one is missing/empty): ${r.status.artifacts.join(", ")}`
            : ""
        return `⚠ Sub-agent ${r.id} (${r.type}) finished INCOMPLETE — deliverable contract not met: ${r.status.reason}${spent}. The required file does NOT exist, so this is NOT a clean success. BUT its findings were salvaged from the worker's summary below — read them before deciding whether a re-run is even needed; often you can use this directly or just write the file yourself from it.\n\n--- salvaged findings ---\n${r.status.salvage}${arts}`
      }
      return `⚠ Sub-agent ${r.id} (${r.type}) finished WITHOUT a deliverable: ${r.status.reason}. This is NOT a success — the worker exited cleanly but produced no result summary${spent}. Treat the work as unverified: inspect its log/transcript, and re-spawn with a clearer task (and, if it was a file-producing job, set expectArtifacts) if you still need it.`
    }
    case "failed":
      return `Sub-agent ${r.id} failed: ${r.status.error}. No result. Consider re-spawning with a clearer task or a different model.`
    case "stopped":
      return `Sub-agent ${r.id} was stopped${r.status.reason ? `: ${r.status.reason}` : ""}. No result.`
    case "queued":
    case "running":
      return `Sub-agent ${r.id} is still ${r.status.kind}; no final result yet. Check AgentStatus ${r.id} or wait for the digest that arrives between turns when it finishes.`
    default: {
      throw new Error(`unhandled status kind: ${String(r.status satisfies never)}`)
    }
  }
}
