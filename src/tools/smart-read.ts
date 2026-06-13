const MAX_BYTES = 100_000
/**
 * Reads a window of a text file by line offset/limit (default 200 lines),
 * additionally clamping the result to 100 kB. Reports the file's total line
 * count, whether the byte cap fired, and a follow-up `offset` suggestion for
 * paging when it did.
 */
export async function smartRead(opts: { filePath: string; offset?: number; limit?: number }) {
  const text = await Bun.file(opts.filePath).text()
  const lines = text.split("\n")
  const start = opts.offset || 0
  const chunk = lines.slice(start, start + (opts.limit || 200))
  const content = chunk.join("\n")
  const truncated = content.length > MAX_BYTES
  return {
    content: truncated ? content.slice(0, MAX_BYTES) : content,
    totalLines: lines.length,
    truncated,
    suggestion: truncated ? "Use offset=" + (start + 100) : undefined,
  }
}
