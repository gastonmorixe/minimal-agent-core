/**
 * Memory summary refresh — the policy layer.
 *
 * One public entry point: {@link refreshAndRender}. Called from
 * `handlers/load.ts` at session start, once per scope (global/project).
 *
 * Behavior at a glance:
 *
 *   IF memory is below threshold OR summarization is disabled:
 *     return memory.md verbatim (current behavior).
 *
 *   ELSE:
 *     if summary.md is stale enough (≥ dirtyBullets pending OR missing):
 *       call summarize(memory.md) → write summary.md with new cutoff.
 *     return summary.md body + "### Recent saves" pending tail.
 *
 * INVARIANT: the source of truth is memory.md. summary.md is always
 * derivable. The summarizer never reads summary.md. See
 * `docs/changes/2026-05-14-feat-memory-summary-refresh.md`.
 *
 * @module memory/lib/summary-refresh
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { MemorySummaryConfig } from "./memory-config.ts"
import { type Bullet, parseFile } from "./parse.ts"
import { summarize as realSummarize, SummarizeError } from "./summarize.ts"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Sibling of the memory.md file. Same dir, name `memory.summary.md`.
 * Lets `mtime`, `ls`, and casual inspection group source + view.
 */
export function summaryPathFor(memoryPath: string): string {
  // Replace the trailing "memory.md" with "memory.summary.md" — preserves
  // any namespace / project subdir prefix.
  return memoryPath.replace(/memory\.md$/, "memory.summary.md")
}

/** Global summary path — `~/.minimal-agent/memory.summary.md`. */
export function globalSummaryPath(home: string = homedir()): string {
  return join(home, ".minimal-agent", "memory.summary.md")
}

/** Project summary path — `~/.minimal-agent/projects/<cwd>/memory.summary.md`. */
export function projectSummaryPath(cwd: string, home: string = homedir()): string {
  const rel = cwd.replace(/^\/+/, "")
  return join(home, ".minimal-agent", "projects", rel, "memory.summary.md")
}

// ---------------------------------------------------------------------------
// Cutoff header
// ---------------------------------------------------------------------------

/**
 * HTML comment at the top of summary.md carrying the timestamp of the
 * last regen. We parse this at injection time to decide which bullets
 * are "not yet in summary" (pending).
 *
 * Example: `<!-- regen-cutoff: 2026-05-14T03:45:00.123-04:00 -->`
 */
const CUTOFF_RE = /^<!--\s*regen-cutoff:\s*(\S+)\s*-->\s*\n?/

/**
 * Pull the regen-cutoff timestamp from the summary file's first line.
 * Returns `null` if there is no recognizable cutoff comment (e.g.
 * hand-edited summary, legacy format, empty file).
 */
export function parseCutoff(summaryContent: string): string | null {
  const m = summaryContent.match(CUTOFF_RE)
  if (!m) return null
  // Validate ISO-ish: we don't need full RFC 3339 parsing, just refuse
  // obviously broken values so a typo doesn't cause silent misclassification.
  const ts = m[1]
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(ts)) return null
  // Parse and stringify to confirm it's a valid date.
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return ts
}

/** Strip the cutoff header from summary content for display. */
export function stripCutoffHeader(summaryContent: string): string {
  return summaryContent.replace(CUTOFF_RE, "").replace(/^\n+/, "")
}

/** Prepend the cutoff header to a summary body. */
export function withCutoffHeader(summaryBody: string, cutoffIso: string): string {
  return `<!-- regen-cutoff: ${cutoffIso} -->\n\n${summaryBody.trim()}\n`
}

// ---------------------------------------------------------------------------
// Partitioning bullets
// ---------------------------------------------------------------------------

/**
 * Split bullets into "already covered by summary" vs "pending".
 *
 * - Bullets with no timestamp (legacy lines) are always pending — we
 *   can't tell when they were added, so we conservatively show them.
 * - Bullets whose timestamp is strictly AFTER `cutoffIso` are pending.
 * - Everything else is in-summary.
 *
 * Comparison is via `Date.parse` so different timezone offsets compare
 * correctly (lexicographic on ISO 8601 only works for same-offset
 * strings; we don't get that guarantee across DST or machines).
 */
export function partitionByCutoff(
  bullets: readonly Bullet[],
  cutoffIso: string,
): { inSummary: Bullet[]; pending: Bullet[] } {
  const inSummary: Bullet[] = []
  const pending: Bullet[] = []
  const cutoffMs = Date.parse(cutoffIso)
  if (Number.isNaN(cutoffMs)) {
    // Bad cutoff — treat everything as pending. Caller will likely
    // regen on top of this anyway.
    return { inSummary: [], pending: [...bullets] }
  }
  for (const b of bullets) {
    if (b.ts === null) {
      pending.push(b)
      continue
    }
    const t = Date.parse(b.ts)
    if (Number.isNaN(t)) {
      pending.push(b)
      continue
    }
    if (t > cutoffMs) pending.push(b)
    else inSummary.push(b)
  }
  return { inSummary, pending }
}

// ---------------------------------------------------------------------------
// Headlines
// ---------------------------------------------------------------------------

/**
 * Extract a one-line headline from a bullet body for the "Recent
 * saves" tail. First sentence if reasonable, else word-boundary trim
 * with ellipsis.
 */
export function headlineOf(body: string, maxChars = 100): string {
  const trimmed = body.trim()
  if (trimmed.length === 0) return ""
  if (trimmed.length <= maxChars) return trimmed
  // First sentence boundary: a period (or !/?) followed by space and a capital.
  const m = trimmed.match(/^(.{20,}?[.!?])(?=\s+[A-Z(])/)
  if (m && m[1].length <= maxChars) return m[1]
  // Hard truncate at last space within maxChars.
  const cut = trimmed.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(" ")
  const base = lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut
  return `${base}…`
}

/** Render the pending bullets as a markdown section, or `""` if empty. */
export function renderPendingSection(pending: readonly Bullet[]): string {
  if (pending.length === 0) return ""
  const lines = pending.map((b) => `- #${b.id} · ${headlineOf(b.body)}`)
  return `### Recent saves (not yet in summary)\n\n${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Write `content` to `path` atomically: write to a per-pid tmp file in
 * the same directory, then `rename` (which is atomic on POSIX). If the
 * process dies mid-write, the tmp file is orphaned but the existing
 * `path` (if any) stays intact.
 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface RefreshAndRenderOpts {
  /** Used to seed the system prompt with the right framing. */
  scope: "global" | "project"
  /** Path to the source `memory.md`. Read-only here. */
  memoryPath: string
  /** Path to the derived `memory.summary.md`. Written when regen runs. */
  summaryPath: string
  /** Resolved memory-summary config. */
  cfg: MemorySummaryConfig
}

export interface RefreshAndRenderDeps {
  /** Override summarize for tests. Defaults to the real implementation. */
  summarize?: typeof realSummarize
  /** Override "now" for tests. Defaults to `() => new Date()`. */
  now?: () => Date
  /** Optional logger (e.g. for "regen skipped: X" messages). Defaults to stderr. */
  log?: (msg: string) => void
}

export interface RefreshResult {
  /**
   * Markdown text to inject under the scope header. May be empty if
   * the memory file is missing or empty.
   */
  text: string
  /** Whether a regen LLM call actually ran (success or failure). */
  regenerated: boolean
  /** One-line reason for the chosen path. Useful in tests and logs. */
  reason: string
}

/** Default logger writes to stderr (off by default unless DEBUG=1). */
function defaultLog(msg: string): void {
  if (process.env.DEBUG === "1") {
    process.stderr.write(`[memory-summary] ${msg}\n`)
  }
}

/**
 * Decide whether to regen, possibly regen, and return the rendered
 * injection text for this scope.
 *
 * Never throws. All failure modes degrade to "inject what we have".
 */
export async function refreshAndRender(
  opts: RefreshAndRenderOpts,
  deps: RefreshAndRenderDeps = {},
): Promise<RefreshResult> {
  const summarize = deps.summarize ?? realSummarize
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? defaultLog
  const { scope, memoryPath, summaryPath, cfg } = opts

  // 1. Read the source memory file.
  if (!existsSync(memoryPath)) {
    return { text: "", regenerated: false, reason: "no-memory-file" }
  }
  let memoryContent: string
  try {
    memoryContent = readFileSync(memoryPath, "utf-8")
  } catch (e) {
    log(`memory read failed: ${(e as Error).message}`)
    return { text: "", regenerated: false, reason: "memory-read-failed" }
  }
  const trimmed = memoryContent.replace(/^\s+|\s+$/g, "")
  if (trimmed.length === 0) {
    return { text: "", regenerated: false, reason: "empty-memory" }
  }

  // 2. Quick exit: summarization disabled → verbatim.
  if (!cfg.enabled) {
    return { text: trimmed, regenerated: false, reason: "disabled" }
  }

  // 3. Threshold check: small memory → verbatim, skip the LLM round-trip.
  const bullets = parseFile(memoryContent)
  if (bullets.length < cfg.minBullets || memoryContent.length < cfg.minBytes) {
    return {
      text: trimmed,
      regenerated: false,
      reason: `below-threshold(bullets=${bullets.length}, bytes=${memoryContent.length})`,
    }
  }

  // 4. Load existing summary (if any) and parse cutoff.
  let summaryContent: string | null = null
  let cutoff: string | null = null
  if (existsSync(summaryPath)) {
    try {
      summaryContent = readFileSync(summaryPath, "utf-8")
      cutoff = parseCutoff(summaryContent)
    } catch (e) {
      log(`summary read failed: ${(e as Error).message}`)
      summaryContent = null
    }
  }

  // 5. Decide whether regen is needed.
  let pending: Bullet[]
  let needRegen: boolean
  let reason: string
  if (summaryContent === null) {
    needRegen = true
    pending = bullets
    reason = "no-summary"
  } else if (cutoff === null) {
    // Summary exists but lacks a cutoff — treat as legacy / corrupt,
    // regen unconditionally.
    needRegen = true
    pending = bullets
    reason = "no-cutoff-in-summary"
  } else {
    const part = partitionByCutoff(bullets, cutoff)
    pending = part.pending
    needRegen = pending.length >= cfg.dirtyBullets
    reason = needRegen
      ? `dirty(pending=${pending.length}, threshold=${cfg.dirtyBullets})`
      : `fresh(pending=${pending.length}, threshold=${cfg.dirtyBullets})`
  }

  // 6. Regen if needed.
  let regenerated = false
  if (needRegen) {
    try {
      const newSummaryBody = await summarize(
        memoryContent,
        { model: cfg.model, scope },
      )
      const newCutoff = now().toISOString()
      summaryContent = withCutoffHeader(newSummaryBody, newCutoff)
      atomicWrite(summaryPath, summaryContent)
      regenerated = true
      // After regen, EVERYTHING is in-summary by definition.
      pending = []
      reason = `regenerated(${reason})`
    } catch (e) {
      const kind = e instanceof SummarizeError ? e.kind : "unknown"
      log(`regen failed (${kind}): ${(e as Error).message}`)
      // Fall through: use the existing summaryContent (if any) and
      // current pending list. If summaryContent is null, we have to
      // fall back to verbatim.
      if (summaryContent === null) {
        return {
          text: trimmed,
          regenerated: false,
          reason: `regen-failed-no-fallback(${kind})`,
        }
      }
      reason = `regen-failed-fallback(${kind})`
    }
  }

  // 7. Compose final text: summary body + pending headlines tail.
  const body = stripCutoffHeader(summaryContent ?? "")
  const sections: string[] = []
  if (body.length > 0) sections.push(body.trim())
  const pendingSection = renderPendingSection(pending)
  if (pendingSection.length > 0) sections.push(pendingSection.trim())

  return {
    text: sections.join("\n\n"),
    regenerated,
    reason,
  }
}
