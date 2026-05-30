/**
 * Cross-platform clipboard-image capture. Terminals do not deliver binary
 * clipboard data on paste, so we shell out to an OS helper to pull an image off
 * the system clipboard. Feature-detected: returns `null` (never throws) when no
 * helper is available or the clipboard holds no image.
 *
 * - macOS: `pngpaste -` (if installed) else an AppleScript fallback.
 * - Linux: `wl-paste` (Wayland) or `xclip` (X11).
 *
 * @module media/clipboard
 */

import { spawnSync } from "node:child_process"

const MAX = 64 * 1024 * 1024

function run(cmd: string, args: string[]): Uint8Array | null {
  try {
    const r = spawnSync(cmd, args, { maxBuffer: MAX })
    if (r.status === 0 && r.stdout && r.stdout.length > 0) return new Uint8Array(r.stdout)
  } catch {
    // command missing / not executable
  }
  return null
}

/**
 * Pull a PNG image off the system clipboard, or `null` if none / unsupported.
 * The bytes are raw PNG suitable for `MediaRegistry.registerBytes`.
 */
export function clipboardImage(): Uint8Array | null {
  if (process.platform === "darwin") {
    const png = run("pngpaste", ["-"])
    if (png) return png
    // AppleScript fallback: write clipboard PNG to a temp file, read it back.
    const script =
      'set p to (POSIX path of (path to temporary items)) & "ma-clip-" & (random number from 100000 to 999999) & ".png"\n' +
      "try\n" +
      "set f to open for access (POSIX file p) with write permission\n" +
      "write (the clipboard as «class PNGf») to f\n" +
      "close access f\n" +
      "return p\n" +
      "on error\n" +
      "try\nclose access (POSIX file p)\nend try\n" +
      'return ""\n' +
      "end try"
    try {
      const r = spawnSync("osascript", ["-e", script], { encoding: "utf8" })
      const path = (r.stdout ?? "").trim()
      if (r.status === 0 && path) {
        const bytes = run("cat", [path])
        run("rm", ["-f", path])
        return bytes
      }
    } catch {
      // osascript unavailable
    }
    return null
  }
  if (process.platform === "linux") {
    return (
      run("wl-paste", ["-t", "image/png"]) ??
      run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"])
    )
  }
  return null
}
