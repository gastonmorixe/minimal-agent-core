/**
 * `ReportResult` — the worker's structured completion hand-back. A worker calls
 * this as its FINAL action; THIS handler (running inside the worker process)
 * writes the result sentinel deterministically. The model supplies findings; it
 * never touches a path or hand-rolls JSON, so the brittle part of the protocol
 * is owned by code, not by the model remembering an exact format.
 *
 * Env-gated: the worker carries `MINIMAL_AGENT_SUBAGENT_RESULT_PATH` (stamped by
 * the spawn plan). When that is absent — a LEAD called the tool — there is no
 * sentinel to write, so we return an explanation instead of doing anything.
 *
 * The write is atomic (temp file + rename) so the supervisor's probe, which may
 * read the path on any tick, never sees a half-written sentinel.
 *
 * @module sub-agents/handlers/report_result
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import type {
  ToolAvailability,
  TUIContext,
  TUIResult,
} from "@minimal-agent/plugin-api/types/plugin"

import { buildDigest, parseReportRequest, serializeDigest } from "../lib/report.ts"
import { ENV_RESULT_PATH } from "../lib/spawn.ts"

/**
 * Availability gate: `ReportResult` is the SUB-AGENT completion tool, so it is
 * advertised ONLY inside a worker process. A worker carries the result-sentinel
 * path in its env (the spawn plan stamps `MINIMAL_AGENT_SUBAGENT_RESULT_PATH`);
 * the lead does not. Returning `false` for the lead hides the tool from its tool
 * list entirely, so the lead never sees it, never wastes tokens on it, and can't
 * call it by mistake. The handler keeps its own env check too (defense in depth
 * for a resumed/forced call). See {@link ToolAvailability}.
 */
export const available: ToolAvailability = (ctx) => Boolean(ctx.env[ENV_RESULT_PATH]?.trim())

/**
 * Tool handler for `ReportResult`: records a sub-agent worker's final
 * summary/artifacts at the result path the supervisor injected via env, so
 * the lead can read it back with `AgentResult`.
 */
export default async function reportResult(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "ReportResult: unexpected trigger", is_error: true }
  }

  const parsed = parseReportRequest(ctx.trigger.input)
  if (!parsed.ok) return { kind: "tool_result", content: parsed.error, is_error: true }

  const resultPath = ctx.env[ENV_RESULT_PATH]?.trim()
  if (!resultPath) {
    // A lead (or a non-worker context) called ReportResult. There is no sentinel
    // to write. Tell the caller plainly rather than failing silently.
    return {
      kind: "tool_result",
      content:
        "ReportResult is the SUB-AGENT completion tool: it records a worker's result for its lead. " +
        "This session is not a sub-agent (no result path in the environment), so there is nothing to report. " +
        "If you are the lead, just reply normally; to read a finished worker's result use AgentResult.",
      is_error: true,
    }
  }

  const digest = buildDigest(parsed.value)
  const json = serializeDigest(digest)

  try {
    mkdirSync(dirname(resultPath), { recursive: true })
    // Atomic publish: write a sibling temp file, then rename over the target so
    // the supervisor never reads a partial sentinel.
    const tmp = `${resultPath}.tmp-${process.pid}`
    writeFileSync(tmp, json, "utf-8")
    renameSync(tmp, resultPath)
  } catch (e) {
    return {
      kind: "tool_result",
      content: `ReportResult: failed to write the result sentinel to ${resultPath}: ${e instanceof Error ? e.message : String(e)}. As a fallback, write that JSON to the path yourself.`,
      is_error: true,
    }
  }

  const artifactNote =
    parsed.value.artifacts && parsed.value.artifacts.length > 0
      ? ` Recorded ${parsed.value.artifacts.length} artifact path(s).`
      : ""
  const stateNote = parsed.value.incomplete
    ? " Flagged INCOMPLETE — the lead will treat the work as unverified."
    : ""
  return {
    kind: "tool_result",
    content:
      `Result recorded. Your deliverable has been handed back to the lead.${artifactNote}${stateNote} ` +
      "You can stop now; nothing else is required.",
  }
}
