/**
 * Pure core for the `ReportResult` completion tool — the worker's structured
 * hand-back. A worker calls `ReportResult({summary, artifacts?, incomplete?})`
 * as its final action; the HANDLER (in the worker process) writes the sentinel
 * file deterministically. This module is the pure half: validate the model's
 * input and build the exact `ResultDigest` bytes to persist. No IO, no throw.
 *
 * Why a tool and not "ask the model to write a file": we cannot force a model
 * to emit any particular text, but we CAN make the one required final action a
 * single structured tool call and do the filesystem write ourselves. That moves
 * the brittle part (exact path, valid JSON) off the model and onto our code.
 * The model only supplies findings. A worker on a provider with no tool calling
 * still has the documented manual-sentinel fallback; distillation of the final
 * message is the floor below that. See `prompts/result-protocol.tmpl.md`.
 *
 * @module sub-agents/lib/report
 */

import { err, ok, type Result, type ResultDigest } from "./types.ts"

/** The validated shape of a `ReportResult` tool input. */
export interface ReportRequest {
  /** The worker's findings: a dense, self-contained synthesis the lead reads. */
  readonly summary: string
  /** Absolute paths of files the worker created or changed. */
  readonly artifacts?: readonly string[]
  /** The worker is reporting it could NOT finish (lead should treat as unverified). */
  readonly incomplete?: boolean
  /** Optional self-reported counts (advisory; the supervisor's live progress is authoritative). */
  readonly tokens?: number
  readonly tools?: number
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

function nonNegInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined
}

function strArray(v: unknown, max = 32): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
  return out.length > 0 ? out.slice(0, max) : undefined
}

/**
 * Validate a raw `ReportResult` tool input into a {@link ReportRequest}. The
 * only hard requirement is a non-empty `summary` (the whole point of the call);
 * everything else is optional. Returns a {@link Result} so a malformed call
 * becomes a teaching `is_error` tool result rather than a thrown exception.
 */
export function parseReportRequest(input: Record<string, unknown>): Result<ReportRequest> {
  // Accept a few natural aliases the model might reach for, so a near-miss call
  // still succeeds instead of bouncing on a key name.
  const summary = str(input.summary) ?? str(input.short) ?? str(input.result) ?? str(input.findings)
  if (!summary) {
    return err(
      "`summary` is required: a dense, self-contained paragraph or two with your actual findings (not a pointer to them).",
    )
  }
  const artifacts = strArray(input.artifacts)
  const incomplete = input.incomplete === true
  const tokens = nonNegInt(input.tokens)
  const tools = nonNegInt(input.tools)
  return ok({
    summary,
    ...(artifacts ? { artifacts } : {}),
    ...(incomplete ? { incomplete } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(tools !== undefined ? { tools } : {}),
  })
}

/**
 * Build the {@link ResultDigest} to persist as the sentinel. When the worker
 * flagged `incomplete`, we set the structured `incomplete` flag (which the
 * supervisor reducer branches on, routing the worker to an `incomplete` status
 * instead of `done`) AND prefix the summary with a human-readable `INCOMPLETE:`
 * marker so a hand-written fallback sentinel and the rendered text read the
 * same. Counts default to 0 (the supervisor's live progress is authoritative
 * for the widget).
 */
export function buildDigest(req: ReportRequest): ResultDigest {
  const short = req.incomplete ? `INCOMPLETE: ${req.summary}` : req.summary
  return {
    short,
    tokens: req.tokens ?? 0,
    tools: req.tools ?? 0,
    ...(req.artifacts && req.artifacts.length > 0 ? { artifacts: req.artifacts } : {}),
    ...(req.incomplete ? { incomplete: true } : {}),
  }
}

/** Serialize a digest to the exact one-line JSON the probe's `readResult` parses. */
export function serializeDigest(digest: ResultDigest): string {
  return JSON.stringify(digest)
}
