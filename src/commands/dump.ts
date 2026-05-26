import { writeStdoutSafely } from "../infra/safe-stdout.ts"
import { formatSessionAsMarkdown, formatSessionAsXml } from "../session-dump.ts"
import { loadSession } from "../session-restore.ts"

import { resolveSessionTarget } from "./session-index.ts"

export interface DumpCommandInput {
  target: string
  format: string
  cwd: string
}

export class DumpCommandError extends Error {}

export async function runDumpCommand(input: DumpCommandInput): Promise<void> {
  const sid = resolveSessionTarget(input.target, input.cwd)
  if (!sid) {
    throw new DumpCommandError("no saved sessions found to dump")
  }

  const loaded = loadSession(sid)
  const payload =
    input.format === "xml" ? formatSessionAsXml(loaded) : formatSessionAsMarkdown(loaded)
  await writeStdoutSafely(payload)
}
