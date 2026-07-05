/**
 * Non-interactive (`--prompt` / `-` / bare-positional) agent run.
 *
 * Owns the one-shot output path: formatter spin-up, `--json` vs human vs
 * `--output-schema` routing (via {@link PrintOutput}), streaming the agent's
 * chunks through the plugin stream, and the schema validate-and-exit gate.
 * Split out of `src/index.ts` to keep the entry point under the `max-lines`
 * lint budget; behavior is unchanged.
 *
 * @module host/startup/run-non-interactive
 */

import type { Agent } from "../../agent/agent.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import { PluginStream } from "../../plugins/stream.ts"
import { enforceOutputSchema, PrintOutput, resolvePrintModeOptions } from "../print-output.ts"
import { Formatter } from "../ui/formatter/formatter.ts"

/** Inputs for {@link runNonInteractivePrompt}. */
export interface RunNonInteractivePromptInput {
  /** The initialized agent to drive. */
  readonly agent: Agent
  /** The resolved one-shot prompt text. */
  readonly prompt: string
  /** Resolved formatter argv, or undefined when none. */
  readonly formatterCmd: string[] | undefined
  /** Whether the startup header was shown (drives the leading blank line). */
  readonly showHeader: boolean
  /** `--json` output-mode flag. */
  readonly wantJsonOutput: boolean
  /** Parsed `--output-schema`, or undefined. */
  readonly outputSchema: object | undefined
  /** The active plugin loader when plugins loaded, else null. */
  readonly loader: PluginLoader | null
  /** Working directory for the plugin stream. */
  readonly cwd: string
  /** Exit hook for tests. Defaults to `process.exit`. */
  readonly exit?: (code: number) => never
}

/**
 * Run one non-interactive prompt to completion and print its answer per the
 * selected output mode. Returns when the run is done; may call `exit(1)` on a
 * schema-validation failure.
 */
export async function runNonInteractivePrompt(input: RunNonInteractivePromptInput): Promise<void> {
  const { agent, prompt, formatterCmd, outputSchema, loader } = input
  const exit = input.exit ?? ((code: number): never => process.exit(code))

  // Breathing room between the closed startup tree (stderr) and the streamed
  // response (stdout). Skipped when the header is suppressed (script-friendly).
  if (input.showHeader) process.stdout.write("\n")
  const formatter = formatterCmd ? new Formatter(formatterCmd, process.stdout) : null
  if (formatter) formatter.start()

  const stdoutIsTTY = process.stdout.isTTY === true
  const printOpts = resolvePrintModeOptions({
    jsonFlag: input.wantJsonOutput,
    stdoutIsTTY,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  })
  const printOut = new PrintOutput(printOpts, {
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutIsTTY,
  })

  // Suppress live streaming when output is BUFFERED: json mode (events are the
  // only stdout) OR --output-schema (the answer must be validated before any
  // byte reaches stdout). Otherwise stream chunk-by-chunk (the live feel).
  const jsonMode = printOut.outputMode() === "json"
  const buffered = jsonMode || outputSchema !== undefined
  const baseSink = (s: string) => {
    if (buffered) return
    if (formatter) formatter.write(s)
    else process.stdout.write(s)
  }
  const pluginStream = loader ? new PluginStream(baseSink, loader, input.cwd) : null

  let finalText = ""
  try {
    const gen = agent.run(prompt)
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      finalText += value
      if (pluginStream) {
        const p = pluginStream.feed(value)
        if (p) await p
      } else {
        baseSink(value)
      }
    }
    if (pluginStream) await pluginStream.end()
  } finally {
    if (formatter) await formatter.end()
  }

  // --output-schema validate-and-exit: the final answer must be valid JSON
  // matching the schema, else a diagnostic to stderr + exit 1. Runs BEFORE any
  // stdout write so a failing run never leaks a non-conforming answer.
  if (outputSchema !== undefined) {
    const enforcement = enforceOutputSchema(finalText, outputSchema)
    if (!enforcement.ok) {
      for (const line of enforcement.diagnostics) process.stderr.write(`${line}\n`)
      exit(1)
    }
  }

  if (jsonMode) {
    printOut.finish(finalText)
  } else if (outputSchema !== undefined) {
    process.stdout.write(finalText.endsWith("\n") ? finalText : `${finalText}\n`)
  } else {
    process.stdout.write("\n")
  }
}
