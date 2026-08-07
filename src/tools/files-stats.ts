import {
  type FileStatus,
  type FileTrackingStore,
  normalizeTrackedPath,
  type TrackedFile,
} from "../session/file-tracking-store.ts"

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

/** Render a status report as a tab-delimited text block. */
export function formatFilesStatsReport(report: FilesStatsReport): string {
  const { present, missing, changed } = report.counts
  const totals = `Totals: present=${present} missing=${missing} changed=${changed}`
  if (report.files.length === 0) {
    // A bare "nothing matched" line reads as a broken tool. Distinguish the
    // two empty causes and always explain what the tool does so the result
    // is self-evidently working even before any file has been touched.
    if (report.filtered) {
      return [`No tracked files matched the filter.`, totals].join("\n")
    }
    return [
      `No files have been read or modified yet this session.`,
      `Every successful Read, Edit, or Write records the file's size and modified-time;`,
      `FilesStats reports each tracked file's live status:`,
      `  present - unchanged since last read`,
      `  changed - modified since last read (by you or another process)`,
      `  missing - deleted since last read`,
      totals,
    ].join("\n")
  }
  const lines = report.files.map((file) => {
    const metadata = file.metadata
      ? `size=${file.metadata.size} mtimeMs=${file.metadata.mtimeMs}`
      : "recorded-missing"
    return `${file.status}\t${file.path}\t${metadata}`
  })
  return [`status\tpath\tmetadata`, ...lines, totals].join("\n")
}
