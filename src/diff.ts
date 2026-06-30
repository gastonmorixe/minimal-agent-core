/**
 * Unified-diff helpers for the Edit and Write tools.
 *
 * Two builders:
 *
 * - {@link buildEditDiff} — fast path for `Edit`: we already have the exact
 *   `old_string`/`new_string` (and optionally `replaceAll`), so we just locate
 *   each match in the file, expand to whole lines, and emit one hunk per
 *   match with a few lines of context. No diff algorithm needed.
 *
 * - {@link buildFileDiff} — general line-based diff for `Write` (or any
 *   before/after pair). Uses a simple LCS table — fine for typical file
 *   sizes; would be O(n·m) memory if abused on huge files.
 *
 * Both return a standard unified-diff string with `--- a/path`, `+++ b/path`,
 * and `@@ -oldStart,oldLen +newStart,newLen @@` hunk headers, suitable to
 * pass straight into {@link renderUnifiedDiff} (the UI colorizer
 * in `src/ui/render/unified-diff.ts`, byte-parity-pinned to the diff-view
 * plugin's renderer).
 */

export { renderUnifiedDiff } from "./host/ui/render/unified-diff.ts"

interface Hunk {
  oldStart: number // 1-based line number in `before`
  oldLen: number
  newStart: number // 1-based line number in `after`
  newLen: number
  lines: string[] // each line starts with " ", "-", or "+"
}

/**
 * Split text into lines, preserving the fact that a trailing `\n` yields no
 * extra empty line (matches `git diff` semantics for our purposes).
 */
function splitLines(s: string): string[] {
  if (s === "") return []
  const arr = s.split("\n")
  if (arr[arr.length - 1] === "") arr.pop()
  return arr
}

function formatHunk(path: string, hunks: Hunk[]): string {
  if (hunks.length === 0) return ""
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@`)
    out.push(...h.lines)
  }
  return out.join("\n")
}

/**
 * Build a unified diff for an `Edit` tool invocation.
 *
 * Locates each occurrence of `oldString` in `before`, snaps to whole-line
 * boundaries, and emits a hunk per match. Uses `contextLines` lines of
 * surrounding unchanged context.
 */
export function buildEditDiff(
  filePath: string,
  before: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  contextLines = 3,
): string {
  if (before === "" || oldString === "") return ""

  // Find all match offsets (or just the first one).
  const offsets: number[] = []
  let from = 0
  while (true) {
    const idx = before.indexOf(oldString, from)
    if (idx === -1) break
    offsets.push(idx)
    from = idx + oldString.length
    if (!replaceAll) break
  }
  if (offsets.length === 0) return ""

  const beforeLines = splitLines(before)
  // Precompute cumulative line offsets so we can convert char-offset → line index.
  const lineStartOffsets: number[] = [0]
  for (let i = 0; i < beforeLines.length; i++) {
    lineStartOffsets.push(lineStartOffsets[i] + beforeLines[i].length + 1)
  }
  const offsetToLine = (off: number): number => {
    // binary search for largest index where lineStartOffsets[i] <= off
    let lo = 0
    let hi = lineStartOffsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStartOffsets[mid] <= off) lo = mid
      else hi = mid - 1
    }
    return lo // 0-based line index
  }

  const hunks: Hunk[] = []
  let cumulativeShift = 0 // tracks new-file line offset vs old-file as we walk

  for (const off of offsets) {
    const startLine = offsetToLine(off)
    const endLine = offsetToLine(off + oldString.length - 1)
    // Expand replacement to whole lines: take the full lines in [startLine, endLine].
    const oldChunkLines = beforeLines.slice(startLine, endLine + 1)
    // The match might not start/end at line boundaries — preserve the surrounding
    // characters on the boundary lines.
    const startCharInLine = off - lineStartOffsets[startLine]
    const endCharInLine = off + oldString.length - lineStartOffsets[endLine]
    const prefix = oldChunkLines[0].slice(0, startCharInLine)
    const suffix = oldChunkLines[oldChunkLines.length - 1].slice(endCharInLine)
    const newChunkText = prefix + newString + suffix
    const newChunkLines = newChunkText.split("\n")

    const ctxStart = Math.max(0, startLine - contextLines)
    const ctxEnd = Math.min(beforeLines.length - 1, endLine + contextLines)

    const lines: string[] = []
    for (let i = ctxStart; i < startLine; i++) lines.push(` ${beforeLines[i]}`)
    for (const l of oldChunkLines) lines.push(`-${l}`)
    for (const l of newChunkLines) lines.push(`+${l}`)
    for (let i = endLine + 1; i <= ctxEnd; i++) lines.push(` ${beforeLines[i]}`)

    const oldLen = ctxEnd - ctxStart + 1
    const newLen = oldLen - oldChunkLines.length + newChunkLines.length

    hunks.push({
      oldStart: ctxStart + 1,
      oldLen,
      newStart: ctxStart + 1 + cumulativeShift,
      newLen,
      lines,
    })
    cumulativeShift += newChunkLines.length - oldChunkLines.length
  }

  return formatHunk(filePath, hunks)
}

/**
 * Build a unified diff between two arbitrary texts using a line-level LCS.
 *
 * Suitable for `Write` (we read the existing file before overwriting). For
 * very large files the O(n·m) table will get expensive; in practice agent
 * Writes are small enough that this is fine.
 */
export function buildFileDiff(
  filePath: string,
  before: string,
  after: string,
  contextLines = 3,
): string {
  const a = splitLines(before)
  const b = splitLines(after)

  // LCS table
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // Walk to produce ops: " ", "-", "+"
  type Op = { kind: " " | "-" | "+"; text: string; ai: number; bi: number }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i], ai: i, bi: j })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "-", text: a[i], ai: i, bi: j })
      i++
    } else {
      ops.push({ kind: "+", text: b[j], ai: i, bi: j })
      j++
    }
  }
  while (i < n) {
    ops.push({ kind: "-", text: a[i], ai: i, bi: j })
    i++
  }
  while (j < m) {
    ops.push({ kind: "+", text: b[j], ai: i, bi: j })
    j++
  }

  // Group into hunks separated by >2*contextLines unchanged ops.
  const hunks: Hunk[] = []
  let cur: { startOp: number; endOp: number } | null = null
  const changedIdx: number[] = []
  for (let k = 0; k < ops.length; k++) if (ops[k].kind !== " ") changedIdx.push(k)
  if (changedIdx.length === 0) return ""

  for (const k of changedIdx) {
    const lo = Math.max(0, k - contextLines)
    const hi = Math.min(ops.length - 1, k + contextLines)
    if (cur && lo <= cur.endOp + 1) {
      cur.endOp = Math.max(cur.endOp, hi)
    } else {
      if (cur) hunks.push(buildHunkFromRange(ops, cur.startOp, cur.endOp))
      cur = { startOp: lo, endOp: hi }
    }
  }
  if (cur) hunks.push(buildHunkFromRange(ops, cur.startOp, cur.endOp))

  return formatHunk(filePath, hunks)

  function buildHunkFromRange(ops: Op[], start: number, end: number): Hunk {
    const lines: string[] = []
    let oldStart = -1
    let newStart = -1
    let oldLen = 0
    let newLen = 0
    for (let k = start; k <= end; k++) {
      const op = ops[k]
      if (oldStart === -1) {
        // Find the first 1-based old/new line numbers covered by this hunk.
        oldStart = op.kind === "+" ? op.ai + 1 : op.ai + 1
        newStart = op.kind === "-" ? op.bi + 1 : op.bi + 1
      }
      lines.push(`${op.kind}${op.text}`)
      if (op.kind !== "+") oldLen++
      if (op.kind !== "-") newLen++
    }
    // Edge case: empty hunk shouldn't happen given changedIdx, but guard.
    if (oldStart < 1) oldStart = 1
    if (newStart < 1) newStart = 1
    return { oldStart, oldLen, newStart, newLen, lines }
  }
}
