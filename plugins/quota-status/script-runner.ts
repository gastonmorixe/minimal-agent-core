/**
 * Run a user-supplied status-bar script.
 *
 * `statusBar.script` (user config) names a command the quota footer runs each
 * refresh. The command receives the session metadata as JSON on stdin and its
 * stdout's FIRST line becomes the footer. This is the full-control escape hatch
 * over the built-in segment renderer.
 *
 * Contract (deliberately forgiving — a broken script must never blank or wedge
 * the footer):
 *   - bounded: aborts on `signal` (the live-area scheduler's per-slot timeout)
 *     or an internal hard cap, whichever fires first;
 *   - non-throwing: any spawn/exit/timeout failure resolves to `null` so the
 *     caller falls back to the built-in renderer;
 *   - output is the first non-empty stdout line, trimmed; empty stdout → `null`.
 *
 * @module quota-status/script-runner
 */

/** Hard cap for a status script, independent of the caller signal. */
const SCRIPT_TIMEOUT_MS = 4_000

/**
 * Split a shell-ish command string into argv, honoring `"..."` / `'...'`
 * quoting. Local, dependency-free copy of the host's `parseFormatterCommand`
 * (`src/ui/formatter/formatter.ts`): the decoupling contract (Wave D) forbids
 * importing from `src/`, and this parser is a few lines of pure regex with no host
 * state. Behavior is identical: double- or single-quoted runs become one arg
 * (quotes stripped), bare whitespace-delimited tokens become separate args.
 *
 * @param cmd - The raw command string from `statusBar.script`.
 * @returns The parsed argv (empty when `cmd` is blank).
 */
function parseFormatterCommand(cmd: string): string[] {
  const args: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(cmd)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]!)
  }
  return args
}

/**
 * Run `script` with `payload` (JSON) on stdin. Returns the first stdout line, or
 * `null` on any failure / timeout / empty output. Never throws.
 */
export async function runStatusScript(
  script: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<string | null> {
  const argv = parseFormatterCommand(script)
  if (argv.length === 0) return null

  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (signal) {
    if (signal.aborted) return null
    signal.addEventListener("abort", onAbort, { once: true })
  }
  const timer = setTimeout(() => ac.abort(), SCRIPT_TIMEOUT_MS)
  if (typeof timer.unref === "function") timer.unref()

  try {
    const proc = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      signal: ac.signal,
    })
    try {
      await proc.stdin.write(typeof payload === "string" ? payload : JSON.stringify(payload))
      await proc.stdin.end()
    } catch {
      // Script may not read stdin; ignore a broken-pipe on write.
    }
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) return null
    const firstLine = out.split("\n").find((l) => l.trim().length > 0)
    return firstLine ? firstLine.replace(/\r$/, "") : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener("abort", onAbort)
  }
}
