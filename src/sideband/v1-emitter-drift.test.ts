/**
 * Drift guard: pins the bytes of the 11 sideband v1 emitters to literals.
 * The literals match minimal-agent-plugins/ma-sideband-plugin/lib/codec.test.ts
 * byte for byte. If a core emitter changes, this test fails in core first.
 * Row 12 (`<system-instruction>`, llm/codec/message-codec.ts) is not sideband: skipped.
 * Rows 1 and 2 (mode-active, mode-change) are plugin text now: core pins only the
 * synthetic kind and the raw facts; the bytes live in the plugin parity tests.
 */
import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { SyntheticFacts, SyntheticKind } from "../../plugin-api/src/types/synthetic-text.ts"
import { buildLocalCompactMessages, buildTailCompactMessages } from "../agent/context-compact.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { formatDiagnosticsAnnotation } from "../agent/tool-preview-budget.ts"
import type { Message } from "../llm/messages.ts"
import { modeActiveStampText, modeChangeText } from "../modes/mode-text.ts"
import { escapeTagAttr } from "../plugins/loader/helpers.ts"
import {
  CORE_TOOLS,
  TOOL_HANDLER_BODY,
  toolManifest,
  writePackage,
} from "../plugins/loader.fixtures.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { wrapHookContext } from "../sdk/hook-context.ts"
import { formatRawOutputFooter } from "../session/blob-store.ts"
import { formatBinaryOptInContent, formatBinaryResultMessage } from "../tools/binary-guard.ts"
import { formatRedactedAssetStub, formatSanitizerFooter } from "../tools/embedded-payload-scrub.ts"

const SP = 'a&b "q" <t> >'
const E3 = "a&amp;b &quot;q&quot; &lt;t> >"

/** Reads a core source file as text (for non-exported inline emitters). */
async function src(rel: string): Promise<string> {
  return await Bun.file(new URL(`../${rel}`, import.meta.url)).text()
}

/**
 * Returns the body of the named top-level function: finds `function name(`,
 * then the first `{` that ends a line after the signature, then brace-matches
 * to the closing brace. Throws if the function is missing or unbalanced.
 */
function functionBody(code: string, name: string): string {
  const at = code.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`function not found: ${name}`)
  const open = code.slice(at).search(/\)(: [^\n{]*)? \{\n/)
  if (open < 0) throw new Error(`no body start: ${name}`)
  const start = code.indexOf("{", at + open)
  let depth = 0
  for (let i = start; i < code.length; i++) {
    if (code[i] === "{") depth++
    else if (code[i] === "}" && --depth === 0) return code.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces: ${name}`)
}

/** A resolver that records (kind, facts) and returns a fixed marker. */
function recorder(): SyntheticTextResolver & {
  calls: { kind: SyntheticKind; facts: SyntheticFacts }[]
} {
  const calls: { kind: SyntheticKind; facts: SyntheticFacts }[] = []
  return {
    calls,
    resolve(kind, facts) {
      calls.push({ kind, facts })
      return "RECORDED"
    },
  }
}

/** Returns the checkpoint tag: first message text up to the end of the tag. */
function checkpointTag(msgs: Message[]): string {
  const block = msgs[0]!.content[0] as { text: string }
  return block.text.slice(0, block.text.indexOf("/>") + 2)
}

/** Returns the tag line of a builder output that has prose after it. */
function firstLine(s: string): string {
  return s.split("\n\n")[0]!
}

describe("v1 emitter drift: real builders", () => {
  // modes/mode-text.ts modeActiveStampText: kind mode.active_stamp, raw facts
  test("1 mode-active", () => {
    const text = recorder()
    expect(modeActiveStampText(text, "ask", "2026-01-02T03:04:05.000Z")).toBe("RECORDED")
    modeActiveStampText(text, SP, "s")
    expect(text.calls).toEqual([
      { kind: "mode.active_stamp", facts: { id: "ask", since: "2026-01-02T03:04:05.000Z" } },
      { kind: "mode.active_stamp", facts: { id: SP, since: "s" } },
    ])
  })

  // modes/mode-text.ts modeChangeText: kind mode.change, raw facts
  test("2 mode-change", () => {
    const text = recorder()
    expect(modeChangeText(text, { from: "default", to: "ask", at: "t" })).toBe("RECORDED")
    modeChangeText(text, { from: SP, to: "b", at: "t" })
    expect(text.calls).toEqual([
      { kind: "mode.change", facts: { from: "default", to: "ask", at: "t" } },
      { kind: "mode.change", facts: { from: SP, to: "b", at: "t" } },
    ])
  })

  // session/blob-store.ts formatRawOutputFooter (raw)
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

  // tools/binary-guard.ts formatBinaryResultMessage tag line (E3)
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

  // tools/binary-guard.ts formatBinaryOptInContent (E3, raw body, block).
  // The plugin codec renders ANY raw body (its test uses "A<&>"), but this core builder
  // always base64-encodes, so that body cannot occur here: do not "fix" the difference.
  test("5 binary body", () => {
    expect(formatBinaryOptInContent({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" })).toBe(
      '<ma::agent::binary-result mime="image/png" size="3B" encoding="base64">\nAQID\n</ma::agent::binary-result>',
    )
    expect(formatBinaryOptInContent({ bytes: new Uint8Array([1, 2, 3]), mime: SP, path: SP })).toBe(
      `<ma::agent::binary-result mime="${E3}" size="3B" encoding="base64" path="${E3}">\nAQID\n</ma::agent::binary-result>`,
    )
    // The special attrs literal (E3) is pinned above. Here the base64 body stays raw
    // (+ and / are not escaped).
    expect(
      formatBinaryOptInContent({ bytes: new Uint8Array([0xfb, 0xff]), mime: SP, path: SP }),
    ).toBe(
      `<ma::agent::binary-result mime="${E3}" size="2B" encoding="base64" path="${E3}">\n+/8=\n</ma::agent::binary-result>`,
    )
  })

  // tools/embedded-payload-scrub.ts formatRedactedAssetStub (E3)
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

  // tools/embedded-payload-scrub.ts formatSanitizerFooter (E3)
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

  // agent/tool-preview-budget.ts formatDiagnosticsAnnotation (strip leading "\n\n")
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

  // plugins/loader/helpers.ts escapeTagAttr (E4 rule used by row 10)
  test("10 E4 escape rule", () => {
    expect(escapeTagAttr(SP)).toBe("a&amp;b &quot;q&quot; &lt;t&gt; &gt;")
  })

  // agent/context-compact.ts buildTailCompactMessages and buildLocalCompactMessages
  test("11 compaction", () => {
    const prev: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    expect(checkpointTag(buildTailCompactMessages(prev, 1))).toBe(
      '<ma::context::compaction kind="tail" />',
    )
    expect(checkpointTag(buildLocalCompactMessages({ previous: prev, keepTail: 1 }))).toBe(
      '<ma::context::compaction kind="local" />',
    )
  })
})

describe("v1 emitter drift: real loader and function-anchored pin", () => {
  const ROOT = resolve(__dirname, "../../tmp/v1-drift-sys")
  const HOME = join(ROOT, "home")
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(HOME, { recursive: true })
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  // plugins/loader.ts PluginLoader.getPromptBlock, which calls buildBlock (real path)
  test("10 sys block", async () => {
    writePackage(HOME, "too", toolManifest("too", "WebSearch", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": "Body text.",
    })
    writePackage(
      HOME,
      "beh",
      { id: "beh", name: "Beh", version: "0.1.0", description: "d" },
      { "PROMPT.md": "# Rules\n\nRule body." },
    )
    const loader = await PluginLoader.load({
      userDir: HOME,
      roots: { project: [join(ROOT, "nope")] },
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.getPromptBlock()).toBe(
      '<ma::sys::behavior name="rules">\nRule body.\n</ma::sys::behavior>\n\n<ma::sys::tool name="WebSearch">\nBody text.\n</ma::sys::tool>',
    )
  })

  // sdk/hook-context.ts wrapHookContext is the one policy note builder.
  // executeToolRound folds the notes through it at both sites.
  test("9 policy (wrapHookContext, used inside executeToolRound)", async () => {
    expect(wrapHookContext(["a", " ", "b"])).toBe(
      "<ma::agent::policy>a</ma::agent::policy>\n<ma::agent::policy>b</ma::agent::policy>",
    )
    const body = functionBody(await src("loops/tool-round.ts"), "executeToolRound")
    const frag = "`${content}\\n${wrapHookContext(lifecycleNotes)}`"
    expect(body.split(frag).length - 1).toBe(2)
  })
})
