/**
 * Inline-tag handler for `<ma::emit::output />` — renders the full content of
 * a tool call's raw-output blob or a safe filesystem path inline in the
 * response stream.
 *
 * Two source modes, mutually exclusive:
 *
 *   `<ma::emit::output tool="call_00_xxx" />`
 *     Resolves to the raw-output blob for that tool_use_id within THIS
 *     session's blob store. Uses the `blobs:read` capability.
 *
 *   `<ma::emit::output path="/tmp/render_tree.txt" />`
 *     Reads the file at `path`. Only paths under `/tmp/` or within the
 *     agent's `cwd` (project directory) are allowed. Resolved through
 *     realpath to defeat traversal.
 *
 * Both modes accept an optional `title="..."` attribute rendered as a dim
 * heading above the output (matches the diff inline-tag convention).
 *
 * Both modes apply a 256 KiB read cap. When `tool=` resolves through
 * `blobs:read`, the API's own 64 KiB default cap is raised to 256 KiB.
 * Binary files (null byte within the first 4 KiB) are refused. A dim
 * `[clipped N bytes]` note is appended when the content exceeds the cap.
 *
 * The handler returns `{kind: "rendered", ansi: ...}` so the bytes land
 * inline in the response, ANSI escapes intact. The model never touches the
 * content.
 */

import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"

import type { TUIContext, TUIResult } from "@minimal-agent/plugin-api/types/plugin"

const MAX_BYTES = 256 * 1024 // 256 KiB
const BINARY_PROBE = 4096 // check first 4 KiB for null bytes

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

/** Safely resolve a path to its canonical form, falling back to the original on error. */
function tryRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** Allowed-to-read sanity check. Realpaths the allowed roots so /tmp → /private/tmp on macOS matches. */
function isPathSafe(abs: string, cwd: string): boolean {
  const roots = [cwd, "/tmp", tmpdir()].map(tryRealpath)
  return roots.some((root) => abs === root || abs.startsWith(root + "/"))
}

/** True if the first `max` bytes of a file contain a null byte. */
async function isBinaryFile(abs: string): Promise<boolean> {
  try {
    const fd = Bun.file(abs)
    const buf = new Uint8Array(await fd.arrayBuffer())
    const probe = buf.subarray(0, BINARY_PROBE)
    for (let i = 0; i < probe.length; i++) {
      if (probe[i] === 0) return true
    }
    return false
  } catch {
    return true // can't read = treat as binary
  }
}

/**
 * Handle `<ma::emit::output />` inline tag: resolve content from a
 * raw-output blob (`tool=`) or a safe filesystem path (`path=`), and
 * return it as rendered ANSI. Rejects binary content, enforces a 256 KiB
 * cap, and refuses paths outside `/tmp` or `cwd`.
 */
export default async function emitOutputHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "inline_tag") {
    return { kind: "rendered", ansi: "" }
  }

  const attrs = ctx.trigger.attrs
  const toolUseId = attrs.tool
  const filePath = attrs.path
  const title = attrs.title ?? null

  // Exactly one source required.
  if ((toolUseId && filePath) || (!toolUseId && !filePath)) {
    return {
      kind: "rendered",
      ansi: `${DIM}<!-- emit::output: provide exactly one of \`tool\` or \`path\` -->${RESET}`,
    }
  }

  let raw = ""
  let clippedNote = ""

  // -- `tool` source: resolve via the blob store -------------------------------
  if (toolUseId) {
    if (!ctx.agent?.sessionId) {
      return {
        kind: "rendered",
        ansi: `${DIM}<!-- emit::output: no session id available (tool= requires agent.sessionId) -->${RESET}`,
      }
    }
    if (!ctx.host?.blobs) {
      return {
        kind: "rendered",
        ansi: `${DIM}<!-- emit::output: blobs:read capability not granted -->${RESET}`,
      }
    }

    const result = await ctx.host.blobs.read(ctx.agent.sessionId, toolUseId, {
      maxBytes: MAX_BYTES,
    })
    if (!result) {
      return {
        kind: "rendered",
        ansi: `${DIM}<!-- emit::output: blob not found for tool_use_id "${toolUseId}" (may have been evicted or tool output was below the 4 KiB persist threshold) -->${RESET}`,
      }
    }
    raw = result.text
    if (result.clipped) {
      clippedNote = `${DIM}[clipped ${result.bytes - result.text.length} bytes]${RESET}`
    }
  }

  // -- `path` source: validate and read directly -------------------------------
  if (filePath) {
    let resolved: string
    try {
      resolved = realpathSync(filePath)
    } catch {
      return {
        kind: "rendered",
        ansi: `${DIM}<!-- emit::output: path not found or not readable: ${filePath} -->${RESET}`,
      }
    }
    if (!isPathSafe(resolved, ctx.cwd)) {
      return {
        kind: "rendered",
        ansi: `${DIM}<!-- emit::output: path not in /tmp/ or project dir: ${filePath} -->${RESET}`,
      }
    }
    if (await isBinaryFile(resolved)) {
      return {
        kind: "rendered",
        ansi: `${DIM}<!-- emit::output: binary file: ${filePath} -->${RESET}`,
      }
    }
    try {
      const fd = Bun.file(resolved)
      raw = await fd.text()
      if (raw.length > MAX_BYTES) {
        clippedNote = `${DIM}[clipped ${raw.length - MAX_BYTES} bytes]${RESET}`
        raw = raw.slice(0, MAX_BYTES)
      }
    } catch {
      return {
        kind: "rendered",
        ansi: `${DIM}<!-- emit::output: read error: ${filePath} -->${RESET}`,
      }
    }
  }

  if (raw.length === 0) {
    return {
      kind: "rendered",
      ansi: `${DIM}<!-- emit::output: empty content -->${RESET}`,
    }
  }

  const heading = title ? `${DIM}── ${title} ──${RESET}\n` : ""
  const clip = clippedNote ? `\n${clippedNote}` : ""
  return { kind: "rendered", ansi: `\n${heading}${raw}${clip}\n` }
}
