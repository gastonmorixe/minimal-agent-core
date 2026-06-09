/**
 * Shared subprocess helper for spawn-based providers (biome, oxlint).
 *
 * Bun-first with a Node `child_process` fallback so the provider also runs
 * under plain Node test harnesses. Captures stdout/stderr, honors an
 * AbortSignal, and never throws on a non-zero exit (linters exit non-zero when
 * they find problems : that's success, not failure).
 *
 * @module plugins/diagnostics/providers/spawn
 */
import { spawn as nodeSpawn } from "node:child_process"

export interface SpawnResult {
  stdout: string
  stderr: string
  code: number | null
}

/** Run `bin args`, optionally piping `input` to stdin. Resolves on exit. */
export function runCapture(
  bin: string,
  args: string[],
  opts: { cwd: string; input?: string; signal?: AbortSignal },
): Promise<SpawnResult> {
  // Prefer Bun.spawn when available (faster, no extra module).
  const BunRef = (globalThis as { Bun?: typeof Bun }).Bun
  if (BunRef) {
    return runWithBun(BunRef, bin, args, opts)
  }
  return runWithNode(bin, args, opts)
}

async function runWithBun(
  BunRef: typeof Bun,
  bin: string,
  args: string[],
  opts: { cwd: string; input?: string; signal?: AbortSignal },
): Promise<SpawnResult> {
  const proc = BunRef.spawn([bin, ...args], {
    cwd: opts.cwd,
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const onAbort = () => {
    try {
      proc.kill()
    } catch {
      /* already exited */
    }
  }
  if (opts.signal) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener("abort", onAbort, { once: true })
  }
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { stdout, stderr, code }
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
  }
}

function runWithNode(
  bin: string,
  args: string[],
  opts: { cwd: string; input?: string; signal?: AbortSignal },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(bin, args, { cwd: opts.cwd })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (c) => (stdout += c.toString()))
    child.stderr?.on("data", (c) => (stderr += c.toString()))
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout, stderr, code }))
    const onAbort = () => child.kill()
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener("abort", onAbort, { once: true })
    }
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input)
      child.stdin?.end()
    }
  })
}
