/**
 * Parity guard for the manifest warn sites (S11.1c, dual-write). Each of the
 * 14 codes keeps its OLD message bytes and also carries `diagnostic.attrs`.
 * No `structuredData`, severity Warning, source `plugin.manifest`.
 *
 * @module plugins/manifest-warn-attrs.test
 */

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  createDiagnosticBus,
  getDiagnosticBus,
  type LogEvent,
  Severity,
} from "../bus/diagnostic-bus.ts"
import { createDiagnosticsHub } from "../diagnostics/hub.ts"
import type { TypedAttrs } from "../diagnostics/typed.ts"
import { splitFlatManifest } from "../test-utils/split-manifest.ts"

import { CONTRIBUTION_KEYS } from "./loader/contribution-keys.ts"
import { CORE_TOOLS, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"
import { parseManifest } from "./manifest.ts"

const P = "/x/manifest.json"
const BASE = { id: "p1", name: "P", version: "1.0.0", description: "d" }
const SB = {
  kind: "note",
  direction: "to-model",
  placement: "turn",
  attrs: { id: { type: "string", required: true } },
  body: "text",
  trust: "harness",
  summary: "s",
}
const HM = {
  id: "acp",
  description: "Agent Client Protocol over stdio",
  entry: { type: "module", path: "./host-mode.ts" },
}

interface Case {
  code: string
  /** Manifest fragment merged over BASE (flat form, split by the fixture helper). */
  extra: Record<string, unknown>
  /** Exact old message. `undefined` means "check prefix + reason". */
  message?: string
  prefix?: string
  attrs: Record<string, string | number | boolean>
}

const CASES: Case[] = [
  {
    code: "mode_color_ignored",
    extra: { modes: [{ id: "m", label: "M", color: "sky", style: { label: { fg: "sky" } } }] },
    message: `${P}: mode "m" declares both \`color\` and \`style\`; \`style\` takes precedence and \`color\` will be ignored.`,
    attrs: { code: "mode_color_ignored", manifestPath: P, modeId: "m" },
  },
  {
    code: "sideband_entry_not_object",
    extra: { sideband: [7] },
    message: "sideband[0]:entry",
    attrs: { code: "sideband_entry_not_object", manifestPath: P, index: 0 },
  },
  {
    code: "sideband_entry_invalid",
    extra: { sideband: [SB, { ...SB, kind: "" }] },
    message: "sideband[1]:kind",
    attrs: { code: "sideband_entry_invalid", manifestPath: P, index: 1, field: "kind" },
  },
  {
    code: "sideband_owner_ignored",
    extra: { sideband: [{ ...SB, owner: "evil" }] },
    message: "sideband[0].owner is ignored",
    attrs: { code: "sideband_owner_ignored", manifestPath: P, index: 0 },
  },
  {
    code: "error_renderers_not_array",
    extra: { errorRenderers: "x" },
    message: "errorRenderers:not_array",
    attrs: { code: "error_renderers_not_array", manifestPath: P },
  },
  {
    code: "error_renderer_not_object",
    extra: { errorRenderers: [5] },
    message: "errorRenderers[0]:not_object",
    attrs: { code: "error_renderer_not_object", manifestPath: P, index: 0 },
  },
  {
    code: "error_renderer_id_invalid",
    extra: { errorRenderers: [{ entry: "./e.ts" }] },
    message: "errorRenderers[0]:id",
    attrs: { code: "error_renderer_id_invalid", manifestPath: P, index: 0 },
  },
  {
    code: "error_renderer_entry_invalid",
    extra: { errorRenderers: [{ id: "a" }] },
    message: "errorRenderers[0]:entry",
    attrs: { code: "error_renderer_entry_invalid", manifestPath: P, index: 0 },
  },
  {
    code: "error_renderer_export_invalid",
    extra: { errorRenderers: [{ id: "a", entry: "./e.ts", export: 3 }] },
    message: "errorRenderers[0]:export",
    attrs: { code: "error_renderer_export_invalid", manifestPath: P, index: 0 },
  },
  {
    code: "error_renderer_duplicate_id",
    extra: {
      errorRenderers: [
        { id: "a", entry: "./e.ts" },
        { id: "a", entry: "./e.ts" },
      ],
    },
    message: "errorRenderers[1]:duplicate_id",
    attrs: { code: "error_renderer_duplicate_id", manifestPath: P, index: 1 },
  },
  {
    code: "host_mode_description_dropped",
    extra: { hostModes: [{ ...HM, description: "x".repeat(81) }] },
    prefix: `${P}: hostModes[0].description dropped (host mode still loads): `,
    attrs: { code: "host_mode_description_dropped", manifestPath: P, index: 0 },
  },
  {
    code: "cli_block_dropped",
    extra: { cli: { contractVersion: 99, commands: [] } },
    prefix: `${P}: cli block dropped (plugin still loads): `,
    attrs: { code: "cli_block_dropped", manifestPath: P },
  },
  {
    code: "host_mode_field_dropped",
    extra: { hostModes: [{ ...HM, examples: "x" }] },
    prefix: `${P}: hostModes[0].examples dropped (host mode still loads): `,
    attrs: { code: "host_mode_field_dropped", manifestPath: P, index: 0, field: "examples" },
  },
]

function check(
  c: Case,
  message: string,
  attrs: TypedAttrs | undefined,
  sink: { severity?: Severity; source?: string; structuredData?: unknown } | undefined,
) {
  if (c.message !== undefined) expect(message).toBe(c.message)
  else expect(message.startsWith(c.prefix as string)).toBe(true)
  const { reason, ...rest } = (attrs ?? {}) as Record<string, unknown>
  expect(rest).toEqual(c.attrs)
  if (c.prefix !== undefined) {
    expect(typeof reason).toBe("string")
    expect(message).toBe(`${c.prefix}${reason as string}`)
  } else {
    expect(reason).toBeUndefined()
  }
  if (sink) {
    expect(sink.severity).toBe(Severity.Warning)
    expect(sink.source).toBe("plugin.manifest")
    expect(sink.structuredData).toBeUndefined()
  }
}

describe("manifest warn attrs: custom warn callback", () => {
  for (const c of CASES) {
    it(`${c.code}: old message plus attrs`, () => {
      const seen: { m: string; a: TypedAttrs | undefined }[] = []
      parseManifest(splitFlatManifest({ ...BASE, ...c.extra }), P, {
        warn: (m, a) => seen.push({ m, a }),
      })
      expect(seen).toHaveLength(1)
      check(c, seen[0]?.m as string, seen[0]?.a, undefined)
    })
  }

  it("an old-style (m: string) callback still gets the same message", () => {
    const msgs: string[] = []
    const warn = (m: string) => {
      msgs.push(m)
    }
    parseManifest({ ...BASE, errorRenderers: "x" }, P, { warn })
    expect(msgs).toEqual(["errorRenderers:not_array"])
  })
})

describe("manifest warn attrs: default path", () => {
  for (const c of CASES) {
    it(`${c.code}: event has message, attrs, no structuredData`, () => {
      const seen: LogEvent[] = []
      const off = getDiagnosticBus().on("*", (e) => {
        if (e.source === "plugin.manifest") seen.push(e)
      })
      try {
        parseManifest(splitFlatManifest({ ...BASE, ...c.extra }), P)
      } finally {
        off()
      }
      expect(seen).toHaveLength(1)
      const e = seen[0] as LogEvent
      check(c, e.message, e.diagnostic?.attrs, e)
    })
  }
})

describe("manifest warn attrs: site 14 plugin_declares_no_contributions", () => {
  const ROOT = resolve(import.meta.dir, "../../tmp/manifest-warn-attrs-tests")
  const HOME = join(ROOT, "home")
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(HOME, { recursive: true })
    writePackage(HOME, "empty", { id: "empty", name: "empty", version: "0.1.0", description: "d" })
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
  const opts = {
    userDir: HOME,
    roots: { project: [join(ROOT, "nope", ".agents", "plugins")] },
    coreToolNames: CORE_TOOLS,
  }
  const keys = CONTRIBUTION_KEYS.join(", ")
  const old = (dir: string) =>
    `${dir}: plugin "empty" declares no contributions (${keys}) and ships no PROMPT.md; it will load but do nothing`

  it("explicit logger gets the same message bytes", async () => {
    const msgs: string[] = []
    await PluginLoader.load({ ...opts, logger: (m) => msgs.push(m) })
    const m = msgs.find((x) => x.includes("declares no contributions"))
    expect(m).toBe(old(join(HOME, "plugins", "empty")))
  })

  it("default path carries attrs, no structuredData, warning severity", async () => {
    const bus = createDiagnosticBus()
    const seen: LogEvent[] = []
    bus.on("*", (e) => seen.push(e))
    await PluginLoader.load({ ...opts, diagnostics: createDiagnosticsHub({ bus }).diagnostics })
    const e = seen.find((x) => x.message.includes("declares no contributions"))
    expect(e).toBeDefined()
    const dir = join(HOME, "plugins", "empty")
    expect(e?.message).toBe(old(dir))
    expect(e?.severity).toBe(Severity.Warning)
    expect(e?.source).toBe("plugin-loader")
    expect(e?.structuredData).toBeUndefined()
    expect(e?.diagnostic?.attrs).toEqual({
      code: "plugin_declares_no_contributions",
      dir,
      pluginId: "empty",
      keys,
    })
  })
})
