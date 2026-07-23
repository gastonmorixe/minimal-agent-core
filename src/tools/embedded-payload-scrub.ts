/**
 * Scrub embedded binary-as-text payloads inside otherwise-valid UTF-8 tool
 * output (the hole whole-body binary-guard does not cover).
 *
 * Primary target: `data:<mime>;base64,...` URIs inlined by Fetch markdown,
 * HTML→MD converters, and some CLIs. These are valid text so magic/NUL
 * heuristics never fire, yet they waste model tokens and pollute dumps.
 *
 * Design:
 *   - Pure string transform; no I/O.
 *   - Replaces each oversized data-URI with a greppable
 *     `<ma::agent::redacted-asset …/>` stub so the model knows something
 *     was removed and can recover via blob/path when a caller attached one.
 *   - Leaves tiny data-URIs alone (below {@link DEFAULT_MIN_BASE64_CHARS})
 *     so 1×1 tracking pixels / tiny icons don't thrash the body.
 *   - Idempotent: already-redacted text and bodies without `data:` are
 *     returned unchanged (cheap `includes` fast path).
 *   - Does NOT touch multimodal `image` content blocks (those ride as
 *     structured blocks, not string tool text).
 *
 * Call sites:
 *   - L1: `tool-round` after tool return (model-facing + TUI display).
 *   - Dump: `session-dump` so `ma sessions dump` does not print megabase64.
 *   - L0 producers may pre-scrub; core remains the safety net.
 *
 * @module tools/embedded-payload-scrub
 */

import { formatBytes as formatBlobBytes } from "../session/blob-store.ts"

/**
 * Minimum base64 payload length (characters, whitespace-stripped) before a
 * data-URI is redacted. Below this the URI stays (cheap icons).
 * 256 chars ≈ 192 raw bytes.
 */
export const DEFAULT_MIN_BASE64_CHARS = 256

/**
 * One redacted embedded payload. Stable shape for tests + future jsonl
 * `redactions[]` metadata.
 */
export interface EmbeddedRedaction {
  kind: "data_uri"
  mime: string
  /** Base64 character count (whitespace stripped). */
  base64Chars: number
  /** Approx decoded byte size (`floor(chars * 3/4)`). */
  approxBytes: number
}

/** Options for {@link scrubEmbeddedPayloads}. */
export interface ScrubEmbeddedPayloadsOpts {
  /** Tool name stamped on stubs (e.g. `"Fetch"`). */
  tool?: string
  /**
   * Override {@link DEFAULT_MIN_BASE64_CHARS}. Set `0` to scrub every
   * `data:*;base64,` URI regardless of size.
   */
  minBase64Chars?: number
  /**
   * Hard opt-out. When true, returns the input unchanged.
   * (Per-call `binary: true` whole-body opt-in is handled by the caller —
   * this flag is for config / tests.)
   */
  disabled?: boolean
}

/** Result of {@link scrubEmbeddedPayloads}. */
export interface ScrubEmbeddedPayloadsResult {
  /** Model-facing text (stubbed when changed). */
  text: string
  /** True when at least one data-URI was replaced. */
  changed: boolean
  /** Per-URI redaction records (empty when unchanged). */
  redactions: EmbeddedRedaction[]
  /** Total base64 characters removed. */
  charsRemoved: number
}

/**
 * Match `data:<mime>[;params];base64,<payload>`.
 *
 * - mime is type/subtype with common token chars
 * - optional `;charset=…` / other params before `;base64`
 * - payload is a **continuous** base64 run (`[A-Za-z0-9+/=]+` only).
 *
 * No whitespace inside the payload on purpose:
 *   - ASCII space would glue adjacent URIs through prose (`…AAA two data:…`)
 *   - newlines would glue the next word when it happens to be base64 alphabet
 *     (`…AAA\nafter` — "after" is valid base64 chars)
 *
 * Real Fetch/markdown inlined data-URIs are continuous (one long token inside
 * `](…)` or an attribute). Line-wrapped PEM-style base64 is out of v1 scope.
 *
 * Global; lastIndex is reset by the scrub loop via `matchAll` / fresh exec.
 */
const DATA_URI_RE =
  /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9=._+-]+)*)?(;base64),([A-Za-z0-9+/=]+)/gi

/**
 * Replace oversized `data:*;base64,…` URIs in `input` with honest
 * `<ma::agent::redacted-asset>` stubs.
 *
 * When one or more URIs are removed, appends a single trailing
 * `<ma::agent::context-sanitizer …/>` summary so the model can see the
 * aggregate without scanning every stub.
 */
export function scrubEmbeddedPayloads(
  input: string,
  opts: ScrubEmbeddedPayloadsOpts = {},
): ScrubEmbeddedPayloadsResult {
  if (opts.disabled || input.length === 0) {
    return { text: input, changed: false, redactions: [], charsRemoved: 0 }
  }
  // Fast path: no data: scheme at all (common case for Bash/Read/Grep).
  if (!input.includes("data:")) {
    return { text: input, changed: false, redactions: [], charsRemoved: 0 }
  }
  // Already fully sanitized (idempotent): has sanitizer footer and no raw data:base64 left.
  // Still re-scan — a body may mix stubs with a remaining URI.

  const minChars = opts.minBase64Chars ?? DEFAULT_MIN_BASE64_CHARS
  const redactions: EmbeddedRedaction[] = []
  let charsRemoved = 0

  const text = input.replace(
    DATA_URI_RE,
    (full, mime: string, _params: string, _b64flag: string, payload: string) => {
      const b64 = payload.replace(/\s+/g, "")
      if (b64.length < minChars) {
        return full
      }
      const approxBytes = Math.floor((b64.length * 3) / 4)
      const rec: EmbeddedRedaction = {
        kind: "data_uri",
        mime: mime.toLowerCase(),
        base64Chars: b64.length,
        approxBytes,
      }
      redactions.push(rec)
      charsRemoved += b64.length
      return formatRedactedAssetStub(rec, opts.tool)
    },
  )

  if (redactions.length === 0) {
    return { text: input, changed: false, redactions: [], charsRemoved: 0 }
  }

  // Avoid stacking sanitizer footers on re-scrub of already-processed text.
  const withoutPriorFooter = text.replace(/\n*\n<ma::agent::context-sanitizer\b[^>]*\/>\s*$/u, "")
  const footer = formatSanitizerFooter(redactions, charsRemoved)
  return {
    text: `${withoutPriorFooter}\n\n${footer}`,
    changed: true,
    redactions,
    charsRemoved,
  }
}

/**
 * True when `text` still contains a scrub-worthy data-URI (for L3/legacy
 * gates without allocating a full scrub result).
 */
export function containsScrubbableDataUri(
  text: string,
  minBase64Chars: number = DEFAULT_MIN_BASE64_CHARS,
): boolean {
  if (!text.includes("data:")) return false
  DATA_URI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DATA_URI_RE.exec(text)) !== null) {
    const b64 = m[4]!.replace(/\s+/g, "")
    if (b64.length >= minBase64Chars) return true
  }
  return false
}

/** Build a single-asset stub tag. */
export function formatRedactedAssetStub(rec: EmbeddedRedaction, tool?: string): string {
  const attrs: string[] = [
    `kind="data_uri"`,
    `mime="${escapeAttr(rec.mime)}"`,
    `size="${escapeAttr(formatBlobBytes(rec.approxBytes))}"`,
    `chars_removed="${rec.base64Chars}"`,
  ]
  if (tool) attrs.push(`tool="${escapeAttr(tool)}"`)
  return `<ma::agent::redacted-asset ${attrs.join(" ")} />`
}

/** Aggregate footer after one or more redactions. */
export function formatSanitizerFooter(
  redactions: EmbeddedRedaction[],
  charsRemoved: number,
): string {
  const savedBytes = redactions.reduce((a, r) => a + r.approxBytes, 0)
  return (
    `<ma::agent::context-sanitizer removed="${redactions.length}" ` +
    `kinds="data_uri" chars_removed="${charsRemoved}" ` +
    `saved="${escapeAttr(formatBlobBytes(savedBytes))}" />`
  )
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}
