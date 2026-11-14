/**
 * Drift guard: pins the bytes of the 11 sideband v1 emitters to literals.
 * The literals match minimal-agent-plugins/ma-sideband-plugin/lib/codec.test.ts
 * byte for byte. If a core emitter changes, this test fails in core first.
 * Row 12 (`<system-instruction>`, llm/adapter-legacy.ts) is not sideband: skipped.
 */
import { describe, expect, test } from "bun:test"

import { COMPACTION_USER_MARKER } from "../agent/context-compact.ts"
import { formatDiagnosticsAnnotation } from "../agent/tool-preview-budget.ts"
import { activeModeStamp, modeChangeAttachment } from "../modes/PROMPTS.ts"
import { escapeTagAttr } from "../plugins/loader/helpers.ts"
import { formatRawOutputFooter } from "../session/blob-store.ts"
import { formatBinaryOptInContent, formatBinaryResultMessage } from "../tools/binary-guard.ts"
import { formatRedactedAssetStub, formatSanitizerFooter } from "../tools/embedded-payload-scrub.ts"

const SP = 'a&b "q" <t> >'
const E3 = "a&amp;b &quot;q&quot; &lt;t> >"

/** Reads a core source file as text (for non-exported inline emitters). */
async function src(rel: string): Promise<string> {
  return await Bun.file(new URL(`../${rel}`, import.meta.url)).text()
}

/** Returns the tag line of a builder output that has prose after it. */
function firstLine(s: string): string {
  return s.split("\n\n")[0]!
}

describe("v1 emitter drift: real builders", () => {
  // modes/PROMPTS.ts:12 activeModeStamp (raw)
  test("1 mode-active", () => {
    expect(activeModeStamp("ask", "2026-01-02T03:04:05.000Z")).toBe(
      '<ma::agent::mode-active id="ask" since="2026-01-02T03:04:05.000Z" />',
    )
    expect(activeModeStamp(SP, "s")).toBe(`<ma::agent::mode-active id="${SP}" since="s" />`)
  })

  // modes/PROMPTS.ts:17 modeChangeAttachment (raw)
  test("2 mode-change", () => {
    expect(modeChangeAttachment({ from: "default", to: "ask", at: "t" })).toBe(
      '<ma::agent::mode-change from="default" to="ask" at="t" />',
    )
    expect(modeChangeAttachment({ from: SP, to: "b", at: "t" })).toBe(
      `<ma::agent::mode-change from="${SP}" to="b" at="t" />`,
    )
  })

  // session/blob-store.ts:511 formatRawOutputFooter (raw)
  test("3 raw-output", () => {
    expect(
      formatRawOutputFooter({ path: "/w/a.blobs/t1.raw", bytes: 1536, sha256: "ab12cd34ef567890" }),
    ).toBe(
      '<ma::agent::raw-output path="/w/a.blobs/t1.raw" size="1.5kB" sha256="ab12cd34ef567890" />',
    )
    expect(formatRawOutputFooter({ path: SP, bytes: 1, sha256: "x" })).toBe(
      `<ma::agent::raw-output path="${SP}" size="1B" sha256="x" />`,
    )
  })

  // tools/binary-guard.ts:243 formatBinaryResultMessage tag line (E3)
  test("4 binary-result", () => {
    const full = formatBinaryResultMessage({
      mime: "application/pdf",
      sizeBytes: Math.round(4.97 * 1024 * 1024),
      path: "/w/f.pdf",
      sha256: "ab12",
      tool: "Fetch",
    })
    expect(firstLine(full)).toBe(
      '<ma::agent::binary-result mime="application/pdf" size="4.97MB" path="/w/f.pdf" sha256="ab12" tool="Fetch" />',
    )
    expect(firstLine(formatBinaryResultMessage({ mime: "text/x", sizeBytes: 3 }))).toBe(
      '<ma::agent::binary-result mime="text/x" size="3B" />',
    )
    expect(firstLine(formatBinaryResultMessage({ mime: SP, sizeBytes: 3, tool: SP }))).toBe(
      `<ma::agent::binary-result mime="${E3}" size="3B" tool="${E3}" />`,
    )
  })

  // tools/binary-guard.ts:274 formatBinaryOptInContent (E3, raw body, block)
  test("5 binary body", () => {
    expect(formatBinaryOptInContent({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" })).toBe(
      '<ma::agent::binary-result mime="image/png" size="3B" encoding="base64">\nAQID\n</ma::agent::binary-result>',
    )
    expect(formatBinaryOptInContent({ bytes: new Uint8Array([1, 2, 3]), mime: SP, path: SP })).toBe(
      `<ma::agent::binary-result mime="${E3}" size="3B" encoding="base64" path="${E3}">\nAQID\n</ma::agent::binary-result>`,
    )
  })

  // tools/embedded-payload-scrub.ts:180 formatRedactedAssetStub (E3)
  test("6 redacted-asset", () => {
    expect(
      formatRedactedAssetStub(
        { kind: "data_uri", mime: "image/png", base64Chars: 2048, approxBytes: 1536 },
        "Fetch",
      ),
    ).toBe(
      '<ma::agent::redacted-asset kind="data_uri" mime="image/png" size="1.5kB" chars_removed="2048" tool="Fetch" />',
    )
    expect(
      formatRedactedAssetStub({ kind: "data_uri", mime: SP, base64Chars: 1, approxBytes: 1 }),
    ).toBe(`<ma::agent::redacted-asset kind="data_uri" mime="${E3}" size="1B" chars_removed="1" />`)
  })

  // tools/embedded-payload-scrub.ts:192 formatSanitizerFooter (E3)
  test("7 context-sanitizer", () => {
    const rec = (approxBytes: number) => ({
      kind: "data_uri" as const,
      mime: "image/png",
      base64Chars: 1,
      approxBytes,
    })
    expect(formatSanitizerFooter([rec(1536), rec(1536)], 4096)).toBe(
      '<ma::agent::context-sanitizer removed="2" kinds="data_uri" chars_removed="4096" saved="3.0kB" />',
    )
  })

  // agent/tool-preview-budget.ts:85 formatDiagnosticsAnnotation (strip leading "\n\n")
  test("8 diagnostics", () => {
    const strip = (s: string) => {
      expect(s.startsWith("\n\n")).toBe(true)
      return s.slice(2)
    }
    expect(strip(formatDiagnosticsAnnotation(["note one", "note two"], "ad-hoc"))).toBe(
      '<ma::agent::diagnostics count="2" scope="ad-hoc">\nnote one\nnote two\n</ma::agent::diagnostics>',
    )
    expect(strip(formatDiagnosticsAnnotation([SP]))).toBe(
      `<ma::agent::diagnostics count="1">\n${SP}\n</ma::agent::diagnostics>`,
    )
  })

  // plugins/loader/helpers.ts:148 escapeTagAttr (E4 rule used by row 10)
  test("10 E4 escape rule", () => {
    expect(escapeTagAttr(SP)).toBe("a&amp;b &quot;q&quot; &lt;t&gt; &gt;")
  })

  // agent/context-compact.ts:105 COMPACTION_USER_MARKER
  test("11 compaction marker", () => {
    expect(`${COMPACTION_USER_MARKER} kind="tail" />`).toBe(
      '<ma::context::compaction kind="tail" />',
    )
    expect(`${COMPACTION_USER_MARKER} kind="local" />`).toBe(
      '<ma::context::compaction kind="local" />',
    )
  })
})

describe("v1 emitter drift: source-text pins (inline emitters)", () => {
  // loops/tool-round.ts:522 and :963 inline policy tag, raw body
  test("9 policy", async () => {
    const t = await src("loops/tool-round.ts")
    const frag = "`<ma::agent::policy>${n}</ma::agent::policy>`"
    expect(t.split(frag).length - 1).toBeGreaterThanOrEqual(2)
    expect(t).toContain("lifecycleNotes.map((n) => `<ma::agent::policy>")
    expect(t).toContain('.join("\\n")')
  })

  // plugins/loader/session-context.ts:114 composeSessionContext sys role block
  // (E4 name, raw body, block). loader.ts buildBlock delegates here.
  test("10 sys role block", async () => {
    const t = await src("plugins/loader/session-context.ts")
    expect(t).toContain(
      '`<ma::sys::${s.role} name="${escapeTagAttr(s.name)}">\\n${s.body}\\n</ma::sys::${s.role}>`',
    )
    expect(t).toContain('.join("\\n\\n")')
  })

  // agent/context-compact.ts:105 marker, :264 tail text, :392 local text
  test("11 compaction inline text", async () => {
    const t = await src("agent/context-compact.ts")
    expect(t).toContain('export const COMPACTION_USER_MARKER = "<ma::context::compaction"')
    expect(t).toContain('`${COMPACTION_USER_MARKER} kind="tail" />\\n## Context checkpoint')
    expect(t).toContain('`${COMPACTION_USER_MARKER} kind="local" />\\n## Context checkpoint')
  })
})
