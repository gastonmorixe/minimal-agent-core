/**
 * Media id generation. Ids are 8 lowercase hex chars, **content-addressed** by
 * default: `sha256(bytes).slice(0,8)`. The same file attached twice yields the
 * same id, so the registry dedupes to one entry (and one upload). When bytes
 * are not yet available, a random 8-hex id is used. This mirrors the "short,
 * stable, non-cryptographic" hashing in `src/session-store.ts`.
 *
 * @module media/id
 */

import { randomBytes } from "node:crypto"

/** Full sha256 hex digest of the bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

/** Content-addressed 8-hex media id derived from a sha256 hex digest. */
export function mediaIdFromSha(sha256: string): string {
  return sha256.slice(0, 8)
}

/** Content-addressed 8-hex media id for a byte buffer. */
export function mediaId(bytes: Uint8Array): string {
  return mediaIdFromSha(sha256Hex(bytes))
}

/** Random 8-hex id for cases where bytes are not available yet. */
export function randomMediaId(): string {
  return randomBytes(4).toString("hex")
}
