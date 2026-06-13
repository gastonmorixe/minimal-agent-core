/**
 * 8-character lowercase base36 task ids.
 *
 * Short + URL-safe + easy for a user to read back and pass to
 * `CronDelete`. Collision is checked against the caller's existing set;
 * with 36^8 ≈ 2.8e12 space and ≤50 live tasks, a retry practically never
 * fires, but the bounded loop keeps it deterministic for tests.
 *
 * @module schedule/lib/id
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"
const ID_LEN = 8

/**
 * Generate a unique 8-char id.
 *
 * @param exists - Predicate: true when an id is already taken.
 * @param rand - Injectable [0,1) source (default `Math.random`) for tests.
 * @returns A fresh id not currently in use.
 */
export function generateId(
  exists: (id: string) => boolean,
  rand: () => number = Math.random,
): string {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    let id = ""
    for (let i = 0; i < ID_LEN; i++) {
      id += ALPHABET[Math.floor(rand() * ALPHABET.length)] ?? "0"
    }
    if (!exists(id)) return id
  }
  throw new Error("schedule: could not generate a unique task id after 10000 attempts")
}

/** Shape check for an 8-char base36 id (used to validate user input). */
export function isTaskId(s: string): boolean {
  return s.length === ID_LEN && /^[0-9a-z]{8}$/.test(s)
}
