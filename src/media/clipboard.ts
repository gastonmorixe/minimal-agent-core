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
}
interface BunImageStatics {
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

/**
 * Pull an image off the system clipboard, or `null` if none / unsupported.
 *
 * macOS/Windows: `Bun.Image.fromClipboard()` (native, no subprocess). Linux:
 * `wl-paste` / `xclip`. The returned bytes are ready for
 * `MediaRegistry.registerBytes`.
 *
 * NOTE: this is `async` because `Bun.Image`'s terminal (`.bytes()`) is. The
 * editor's synchronous paste path uses {@link clipboardImageSync} instead.
 */
export async function clipboardImage(): Promise<Uint8Array | null> {
  const statics = bunImageStatics()
  if (statics?.fromClipboard) {
    try {
      const img = statics.fromClipboard()
      if (img) return await img.bytes()
    } catch {
      // fall through to OS helpers
    }
  }
  if (process.platform === "linux") return linuxClipboardImage()
  return null
}

/**
 * Synchronous clipboard-image capture, for the editor's sync paste FSM.
 *
 * `Bun.Image.fromClipboard()` is sync to construct but its `.bytes()` terminal
 * is async, so the native path can't be used here. We shell out: `pngpaste` on
 * macOS when present (fast), else `wl-paste`/`xclip` on Linux. Returns `null`
 * when nothing is available (the caller then inserts the literal paste).
 *
 * Prefer {@link clipboardImage} (native, no subprocess) anywhere an `await` is
 * allowed; this exists only for the strictly-synchronous keystroke path.
 */
export function clipboardImageSync(): Uint8Array | null {
  if (process.platform === "darwin") return run("pngpaste", ["-"])
  if (process.platform === "linux") return linuxClipboardImage()
  return null
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
