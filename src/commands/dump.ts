/**
 * `--dump <sid|last>` command — print a session transcript to stdout.
 *
 * Thin shell over the SAME `sessions:read` capability provider that backs
 * the `session-history` plugin's `SessionHistory` tool
 * (`src/plugins/host/providers/sessions-read.ts`). One rendering path: the
 * CLI dump and the tool's `{action:"dump"}` are byte-identical for the
 * same session, and improvements to the provider serve both surfaces.
 *
 * @module commands/dump
 */

import { writeStdoutSafely } from "../infra/safe-stdout.ts"
import { createSessionsReadApi } from "../plugins/host/providers/sessions-read.ts"

import { resolveSessionTarget } from "./session-index.ts"

export interface DumpCommandInput {
  target: string
  format: string
  cwd: string
}

/** Thrown for user-facing `dump` failures (bad target, no sessions); the CLI prints the message without a stack. */
export class DumpCommandError extends Error {}

/**
 * Implements the `minimal-agent dump <session>` CLI command: resolves the
 * target (id prefix or "last") to a session, renders the whole transcript as
 * markdown or XML via the sessions read API, and writes it to stdout.
 */
export async function runDumpCommand(input: DumpCommandInput): Promise<void> {
  const sid = resolveSessionTarget(input.target, input.cwd)
  if (!sid) {
    throw new DumpCommandError("no saved sessions found to dump")
  }

  const sessions = createSessionsReadApi()
  const result = await sessions.dump(sid, {
    format: input.format === "xml" ? "xml" : "markdown",
  })
  if (!result) {
    throw new DumpCommandError(`no session file on disk for sid ${JSON.stringify(sid)}`)
  }
  await writeStdoutSafely(result.text)
}
