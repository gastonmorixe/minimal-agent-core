/**
 * Platform identity + whitelist matching for plugins and tools.
 *
 * A plugin (or an individual tool handler) may opt into a whitelist of
 * platforms it works on via a `platforms` field in `manifest.json`. The
 * field defaults to "all platforms" when absent. The loader gates the
 * plugin (or the single tool) off when the effective platform is not in
 * the whitelist; an env var or CLI argument can override the detected
 * platform (or bypass gating entirely with `all`).
 *
 * This module is the shared contract: the manifest parser validates a
 * whitelist against {@link KNOWN_PLATFORMS}, the loader matches with
 * {@link platformAllowed}, and the host detects the running platform with
 * {@link detectPlatform}. Pure + dependency-free (only reads
 * `process.platform` in {@link detectPlatform}).
 *
 * Three coarse platform buckets are recognized. UNIX-likes (FreeBSD,
 * OpenBSD, illumos, AIX, …) collapse into `linux` on purpose: a plugin
 * that works on one POSIX userland almost always works on the others, and
 * a finer taxonomy would just multiply whitelist boilerplate.
 *
 * @module utils/platform
 */

/** A canonical platform bucket a `platforms` whitelist entry may name. */
export type Platform = "macos" | "linux" | "windows"

/**
 * Every canonical platform a manifest `platforms` whitelist may list.
 * The manifest parser validates strictly against this set (aliases are
 * NOT accepted in a manifest — only in the user-facing override).
 */
export const KNOWN_PLATFORMS: readonly Platform[] = ["macos", "linux", "windows"]

/**
 * The bypass sentinel. An override resolving to this matches EVERY
 * whitelist, turning platform gating off for the session. Not a real
 * platform — never a valid manifest whitelist entry.
 */
export const PLATFORM_ALL = "all" as const

/** Result of normalizing a raw override token: a platform, the bypass, or null. */
export type NormalizedPlatform = Platform | typeof PLATFORM_ALL

/**
 * Map `process.platform` to a coarse {@link Platform} bucket.
 *
 *   - `darwin` → `macos`
 *   - `win32`  → `windows`
 *   - everything else (`linux`, `freebsd`, `openbsd`, `sunos`, `aix`, …)
 *     → `linux` (the POSIX/UNIX-like bucket)
 */
export function detectPlatform(nodePlatform: string = process.platform): Platform {
  if (nodePlatform === "darwin") return "macos"
  if (nodePlatform === "win32") return "windows"
  return "linux"
}

/**
 * Normalize a raw, user-supplied platform token (from an env var or CLI
 * argument) into a canonical {@link Platform}, the {@link PLATFORM_ALL}
 * bypass, or `null` when unrecognized.
 *
 * Accepts common aliases so the override is forgiving:
 *   - macos:   `macos`, `mac`, `osx`, `darwin`, `apple`
 *   - linux:   `linux`, `unix`, `posix`, `freebsd`, `openbsd`, `netbsd`,
 *              `bsd`, `sunos`, `solaris`, `illumos`, `aix`
 *   - windows: `windows`, `win`, `win32`, `win64`
 *   - bypass:  `all`, `any`, `*`
 *
 * Case- and whitespace-insensitive. Empty / undefined → `null`.
 */
export function normalizePlatform(raw: string | undefined): NormalizedPlatform | null {
  if (raw === undefined) return null
  const v = raw.trim().toLowerCase()
  if (v === "") return null
  switch (v) {
    case "all":
    case "any":
    case "*":
      return PLATFORM_ALL
    case "macos":
    case "mac":
    case "osx":
    case "os-x":
    case "darwin":
    case "apple":
      return "macos"
    case "windows":
    case "win":
    case "win32":
    case "win64":
      return "windows"
    case "linux":
    case "unix":
    case "posix":
    case "bsd":
    case "freebsd":
    case "openbsd":
    case "netbsd":
    case "dragonfly":
    case "sunos":
    case "solaris":
    case "illumos":
    case "aix":
      return "linux"
    default:
      return null
  }
}

/**
 * Decide whether a `platforms` whitelist admits the effective platform.
 *
 *   - An absent / empty whitelist means "all platforms" → always `true`.
 *   - The {@link PLATFORM_ALL} bypass effective value → always `true`.
 *   - Otherwise the effective platform must appear in the whitelist
 *     (entries are normalized defensively, so `["darwin"]` still matches
 *     `macos` even though the parser would have rejected it).
 *
 * @param whitelist - The manifest `platforms` array (or undefined).
 * @param effective - The resolved effective platform, or the bypass.
 */
export function platformAllowed(
  whitelist: readonly string[] | undefined,
  effective: NormalizedPlatform,
): boolean {
  if (whitelist === undefined || whitelist.length === 0) return true
  if (effective === PLATFORM_ALL) return true
  for (const entry of whitelist) {
    if (normalizePlatform(entry) === effective) return true
  }
  return false
}
