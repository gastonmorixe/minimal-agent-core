/**
 * System-clipboard capture for the editor's paste path.
 *
 * Images go through Bun's native pipeline first: `Bun.Image.fromClipboard()`
 * (Bun 1.3.14+) reads PNG/TIFF/HEIC/JPEG/GIF/BMP straight off the macOS and
 * Windows pasteboard with no subprocess. Bun returns `null` on Linux (and on
 * older runtimes), so there we still shell out to `wl-paste` / `xclip`. Text
 * has no Bun API, so it always shells out (`pbpaste` / `wl-paste` / `xclip`).
 *
 * Everything is feature-detected and returns `null` (never throws) when no
 * backend is available or the clipboard holds nothing of the requested kind.
 *
 * @module media/clipboard
 */

const MAX = 64 * 1024 * 1024

/** A Bun.Image-like handle (structural, so this file doesn't hard-depend on Bun types). */
interface BunImageLike {
  bytes(): Promise<Uint8Array>
  /** Set the encode target to PNG (chainable). */
  png?: () => BunImageLike
}
export interface BunImageStatics {
  fromClipboard?: () => BunImageLike | null
  hasClipboardImage?: () => boolean
  clipboardChangeCount?: () => number
}

/** The `Bun.Image` statics, or `null` on a runtime without it. */
function bunImageStatics(): BunImageStatics | null {
  const ctor = (globalThis as { Bun?: { Image?: unknown } }).Bun?.Image
  return typeof ctor === "function" ? (ctor as unknown as BunImageStatics) : null
}

/** Run a helper command, returning its stdout bytes or `null` (missing/empty/failed). */
function run(cmd: string, args: string[]): Uint8Array | null {
  try {
    const r = Bun.spawnSync([cmd, ...args], { maxBuffer: MAX })
    if (r.exitCode === 0 && r.stdout && r.stdout.length > 0) return r.stdout
  } catch {
    // command missing / not executable
  }
  return null
}

/** Shell out to the Linux clipboard helpers for an image (Wayland then X11). */
function linuxClipboardImage(): Uint8Array | null {
  return (
    run("wl-paste", ["-t", "image/png"]) ??
    run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"])
  )
}

/** Host facts that {@link readClipboardImage} reads; injectable for tests. */
export interface ClipboardEnv {
  platform: NodeJS.Platform
  /** Resolve a command on PATH, or `null` when it is not installed. */
  which: (cmd: string) => string | null
}

const defaultEnv = (): ClipboardEnv => ({
  platform: process.platform,
  which: (cmd) => Bun.which(cmd),
})

/** Outcome of {@link readClipboardImage}: the bytes, or why there are none. */
export interface ClipboardImageResult {
  /** PNG-encoded (native path) or raw helper output; `null` when nothing was read. */
  bytes: Uint8Array | null
  /**
   * Set when the read failed: the native reader threw, it reported an image
   * and gave no bytes, or (Linux) neither `wl-paste` nor `xclip` is installed.
   * Not set for an empty clipboard, which is not a failure.
   */
  error?: string
}

/**
 * Read an image off the system clipboard and say why when it fails.
 *
 * macOS/Windows: `Bun.Image.fromClipboard()` (native, no subprocess). Linux:
 * `wl-paste` / `xclip`; with neither installed the result carries an error.
 * Never throws. `statics` and `env` are injectable for tests.
 */
export async function readClipboardImage(
  statics: BunImageStatics | null = bunImageStatics(),
  env: ClipboardEnv = defaultEnv(),
): Promise<ClipboardImageResult> {
  let error: string | undefined
  if (statics?.fromClipboard) {
    try {
      const img = statics.fromClipboard()
      // Always encode to PNG: the macOS pasteboard often holds TIFF, which most
      // providers reject. Without `.png()` Bun re-uses the source format.
      if (img) {
        const bytes = await (img.png ? img.png() : img).bytes()
        if (bytes.length > 0) return { bytes }
        error = "the clipboard image decoded to zero bytes"
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }
  if (env.platform === "linux") {
    // Try only the helpers that are installed, so a missing one is a clear error.
    const haveWl = env.which("wl-paste") !== null
    const haveX = env.which("xclip") !== null
    const bytes =
      (haveWl ? run("wl-paste", ["-t", "image/png"]) : null) ??
      (haveX ? run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]) : null)
    if (bytes) return { bytes }
    if (!error && !haveWl && !haveX) {
      error = "no clipboard helper found: install wl-clipboard (Wayland) or xclip (X11)"
    }
  }
  // An image the native reader reported but could not read is a failure too.
  if (!error && safeHasImage(statics)) error = "the clipboard has an image that could not be read"
  return error ? { bytes: null, error } : { bytes: null }
}

function safeHasImage(statics: BunImageStatics | null): boolean {
  try {
    return statics?.hasClipboardImage?.() ?? false
  } catch {
    return false
  }
}

/**
 * Pull an image off the system clipboard, or `null` if none / unsupported /
 * unreadable. Use {@link readClipboardImage} to learn why a read failed.
 */
export async function clipboardImage(
  statics: BunImageStatics | null = bunImageStatics(),
): Promise<Uint8Array | null> {
  return (await readClipboardImage(statics)).bytes
}

/**
 * Synchronous clipboard-image capture, for the editor's sync paste FSM.
 *
 * Linux only (`wl-paste` / `xclip`). On macOS and Windows it returns `null`:
 * `Bun.Image.fromClipboard()` has an async `.bytes()`, so the native reader
 * runs through {@link readClipboardImage} instead.
 */
export function clipboardImageSync(): Uint8Array | null {
  return process.platform === "linux" ? linuxClipboardImage() : null
}

/**
 * Is there an image on the clipboard right now? Cheap on macOS/Windows
 * (`Bun.Image.hasClipboardImage()`); always `false` on a runtime without Bun's
 * native API. Useful for a passive "press Ctrl+V to paste the image" hint.
 */
export function hasClipboardImage(): boolean {
  try {
    return bunImageStatics()?.hasClipboardImage?.() ?? false
  } catch {
    return false
  }
}

/**
 * A monotonically-increasing counter that bumps on any clipboard change, or
 * `null` when unsupported. macOS has no change notification, so the documented
 * pattern is to poll this cheap integer and only probe {@link hasClipboardImage}
 * when it moves.
 */
export function clipboardChangeCount(): number | null {
  try {
    return bunImageStatics()?.clipboardChangeCount?.() ?? null
  } catch {
    return null
  }
}

/**
 * Pull plain text off the system clipboard, or `null` if none / unsupported.
 * Bun has no text-clipboard API, so this always shells out: `pbpaste` (macOS),
 * `wl-paste` / `xclip` (Linux).
 */
export function clipboardText(): string | null {
  let bytes: Uint8Array | null = null
  if (process.platform === "darwin") {
    bytes = run("pbpaste", [])
  } else if (process.platform === "linux") {
    bytes = run("wl-paste", ["-n"]) ?? run("xclip", ["-selection", "clipboard", "-o"])
  }
  if (!bytes || bytes.length === 0) return null
  try {
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}
