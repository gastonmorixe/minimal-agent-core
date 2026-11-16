import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import {
  type FileStatus,
  type FileTrackingStore,
  normalizeTrackedPath,
  type TrackedFile,
} from "../session/file-tracking-store.ts"

import { filesStatsEmptyText } from "./tool-result-text.ts"

export interface FilesStatsInput {
  status?: FileStatus | "all"
  path?: string
}

export interface FilesStatsReport {
  files: Array<TrackedFile & { status: FileStatus }>
  counts: Record<FileStatus, number>
  /** True when a status/path filter was applied (affects the empty message). */
  filtered: boolean
}

/** Build a filtered status report over a store's tracked files. */
export function buildFilesStatsReport(
  store: FileTrackingStore,
  input: FilesStatsInput = {},
): FilesStatsReport {
  const filter = input.status ?? "all"
  const pathFilter = input.path
  const filtered = input.status !== undefined || input.path !== undefined
  // Normalize the path filter against the SAME cwd the tracker uses, so a
  // relative filter ("src/tools") matches the absolute tracked paths the
  // same way Read/Edit/Write address files.
  const normalizedFilter =
    pathFilter === undefined ? undefined : normalizeTrackedPath(pathFilter, store.cwd)
  const files = store
    .statuses()
    .filter((file) => filter === "all" || file.status === filter)
    .filter(
      (file) =>
        !normalizedFilter ||
        file.path === normalizedFilter ||
        file.path.startsWith(`${normalizedFilter}/`),
    )
  const counts: Record<FileStatus, number> = { present: 0, missing: 0, changed: 0 }
  for (const file of files) counts[file.status]++
  return { files, counts, filtered }
}

/**
 * Render a status report as a tab-delimited text block. The prose of an
 * empty report is the `tool_text.FilesStats.empty` kind (no provider: only
 * the totals line). The header, rows and totals are data.
 */
export function formatFilesStatsReport(
  report: FilesStatsReport,
  text?: SyntheticTextResolver,
): string {
  const { present, missing, changed } = report.counts
  const totals = `Totals: present=${present} missing=${missing} changed=${changed}`
  if (report.files.length === 0) {
    const prose = filesStatsEmptyText(text, report.filtered)
    return prose ? `${prose}\n${totals}` : totals
  }
  const lines = report.files.map((file) => {
    const metadata = file.metadata
      ? `size=${file.metadata.size} mtimeMs=${file.metadata.mtimeMs}`
      : "recorded-missing"
    return `${file.status}\t${file.path}\t${metadata}`
  })
  return [`status\tpath\tmetadata`, ...lines, totals].join("\n")
}
