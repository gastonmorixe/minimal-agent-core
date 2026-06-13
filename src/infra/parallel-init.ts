/**
 * Runs independent startup tasks concurrently and times each one. Failures
 * are captured per task instead of aborting the batch; a failed task marked
 * `critical` makes the whole call throw after all tasks settle. Returns the
 * per-task `{name, ms, ok}` results plus the total elapsed time.
 */
export async function parallelInit(
  tasks: { name: string; init: () => Promise<unknown>; critical?: boolean }[],
) {
  const t0 = performance.now()
  const results = await Promise.allSettled(
    tasks.map(async (t) => {
      const s = performance.now()
      try {
        await t.init()
        return { name: t.name, ms: Math.round(performance.now() - s), ok: true }
      } catch (e) {
        return { name: t.name, ms: Math.round(performance.now() - s), ok: false, err: String(e) }
      }
    }),
  )
  return {
    results: results.map((r) => (r.status === "fulfilled" ? r.value : r.reason)),
    totalMs: Math.round(performance.now() - t0),
  }
}
