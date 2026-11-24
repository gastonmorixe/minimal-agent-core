/**
 * The time limit of one async module import at boot (M1). Shared by the
 * chain boot and the sideband display boot.
 *
 * @module plugins/loader/boot-import-race
 */

import { abortableSleep } from "../../../plugin-api/src/utils/retry.ts"

/** Time limit for one async module import (and its async factory) at boot, in ms. */
export const BOOT_IMPORT_TIMEOUT_MS = 2000

/** The value of {@link raceImport} when the time limit ends first. */
export const TIMED_OUT: unique symbol = Symbol("timed-out")

/**
 * Race an async boot import against a time limit of `ms` (M1). The limit is
 * `abortableSleep` (plugin-api retry.ts), not a raw timer: the core timer
 * ratchet does not allow a new `setTimeout` site. The sleep is aborted when
 * the race ends, so its timer is cleared. A rejection of `work` is passed on.
 */
export async function raceImport<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const ac = new AbortController()
  const limit = abortableSleep(ms, ac.signal).then(
    (): typeof TIMED_OUT => TIMED_OUT,
    (): typeof TIMED_OUT => TIMED_OUT,
  )
  try {
    return await Promise.race([work, limit])
  } finally {
    ac.abort()
  }
}
