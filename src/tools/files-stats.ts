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
}

/** Build a filtered status report over a store's tracked files. */
export function buildFilesStatsReport(
  store: FileTrackingStore,
  input: FilesStatsInput = {},
): FilesStatsReport {
  const filter = input.status ?? "all"
  const pathFilter = input.path
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
  return { files, counts }
}

/** Render a status report as a tab-delimited text block. */
export function formatFilesStatsReport(report: FilesStatsReport): string {
  if (report.files.length === 0) return "No tracked files matched the filter."
  const lines = report.files.map((file) => {
    const metadata = file.metadata
      ? `size=${file.metadata.size} mtimeMs=${file.metadata.mtimeMs}`
      : "recorded-missing"
    return `${file.status}\t${file.path}\t${metadata}`
  })
  const { present, missing, changed } = report.counts
  return [
    `status\tpath\tmetadata`,
    ...lines,
    `Totals: present=${present} missing=${missing} changed=${changed}`,
  ].join("\n")
}
