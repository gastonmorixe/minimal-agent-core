import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import {
  countSitesByFile,
  DEFAULT_BLESSED,
  DEFAULT_EXEMPT,
  DEFAULT_HOST_ROOTS,
  isBlessed,
  renderBaseline,
  resolveFromSrc,
  resolvesToHostRoot,
  scanCoreHostImports,
  scanSourceForHostImports,
} from "./core-host-import-scan.ts"

describe("resolveFromSrc (path resolution against the importing file's dir)", () => {
  it("resolves ../host/ from a one-deep src file to the src/host tree", () => {
    expect(resolveFromSrc("ui/compositor.ts", "../host/ui/compositor.ts")).toBe(
      "src/host/ui/compositor.ts",
    )
  })

  it("resolves ../../host/ from a two-deep src file to the src/host tree", () => {
    expect(resolveFromSrc("ui/style/ansi.ts", "../../host/ui/style/ansi.ts")).toBe(
      "src/host/ui/style/ansi.ts",
    )
  })

  it("resolves ./host/ from a src-root file to src/host", () => {
    expect(resolveFromSrc("index.ts", "./host/cli/main.ts")).toBe("src/host/cli/main.ts")
  })
})

describe("resolvesToHostRoot (the violation predicate)", () => {
  it("flags ../host/ui/compositor.ts from src/ui/compositor.ts (VIOLATION)", () => {
    expect(resolvesToHostRoot("ui/compositor.ts", "../host/ui/compositor.ts")).toBe(true)
  })

  it("flags ../../host/ deep escapes", () => {
    expect(resolvesToHostRoot("ui/style/ansi.ts", "../../host/ui/style/ansi.ts")).toBe(true)
  })

  it("ignores bare and node:/bun: specifiers", () => {
    expect(resolvesToHostRoot("agent.ts", "node:path")).toBe(false)
    expect(resolvesToHostRoot("agent.ts", "bun:test")).toBe(false)
    expect(resolvesToHostRoot("agent.ts", "some-package")).toBe(false)
    // a bare specifier that merely STARTS with "host" is a package name
    expect(resolvesToHostRoot("agent.ts", "host/whatever")).toBe(false)
  })

  it("does not flag sibling dirs whose name merely starts with the host root", () => {
    expect(resolvesToHostRoot("ui/foo.ts", "../host-utils/x.ts")).toBe(false)
  })

  it("does not flag a non-host relative import (core-internal)", () => {
    expect(resolvesToHostRoot("ui/foo.ts", "../llm/messages.ts")).toBe(false)
    expect(resolvesToHostRoot("agent.ts", "./sdk/ports.ts")).toBe(false)
  })

  it("takes host roots as a parameter (survives the ../minimal-agent-host move)", () => {
    const roots = ["src/host", "../minimal-agent-host"]
    // from src/ui/foo.ts, three `../` escape above the repo root to the sibling
    expect(resolvesToHostRoot("ui/foo.ts", "../../../minimal-agent-host/cli/x.ts", roots)).toBe(
      true,
    )
    // with ONLY the future root configured, today's in-repo tree is not matched
    // (from src/ui/foo.ts, ../host/x.ts lands in src/host, not the future root)
    expect(resolvesToHostRoot("ui/foo.ts", "../host/x.ts", ["../minimal-agent-host"])).toBe(false)
  })
})

describe("isBlessed (the CLI adapter + host package exceptions)", () => {
  it("blesses src/index.ts (the CLI entrypoint)", () => {
    expect(isBlessed("index.ts")).toBe(true)
  })

  it("blesses every file under the host package itself", () => {
    expect(isBlessed("host/cli/main.ts")).toBe(true)
    expect(isBlessed("host/ui/compositor.ts")).toBe(true)
    expect(isBlessed("host/editor-controller.ts")).toBe(true)
  })

  it("does not bless ordinary core files", () => {
    expect(isBlessed("ui/compositor.ts")).toBe(false)
    expect(isBlessed("agent.ts")).toBe(false)
    // a file whose name merely contains 'host' but isn't under host/ is core
    expect(isBlessed("agent/ask-user-host.ts")).toBe(false)
  })
})

describe("scanSourceForHostImports (import-site extraction)", () => {
  it("finds a static re-export shim that escapes into src/host (the P3 shims)", () => {
    const sites = scanSourceForHostImports(
      `export * from "../host/ui/compositor.ts"\n`,
      "ui/compositor.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].specifier).toBe("../host/ui/compositor.ts")
    expect(sites[0].resolved).toBe("src/host/ui/compositor.ts")
    expect(sites[0].typeOnly).toBe(false)
  })

  it("returns nothing for a blessed file even when it imports host (src/index.ts)", () => {
    expect(
      scanSourceForHostImports(`import { runCli } from "./host/cli/main.ts"\n`, "index.ts"),
    ).toHaveLength(0)
  })

  it("returns nothing for intra-host imports (host package importing itself)", () => {
    expect(
      scanSourceForHostImports(`import { c } from "./ui/style/ansi.ts"\n`, "host/ui/compositor.ts"),
    ).toHaveLength(0)
  })

  it("flags type-only imports with typeOnly:true", () => {
    const sites = scanSourceForHostImports(
      `import type { EditorKeyPayload } from "../host/editor-controller.ts"\n`,
      "agent/turn-attachments.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(true)
  })

  it("flags export type ... from with typeOnly:true", () => {
    const sites = scanSourceForHostImports(
      `export type { ReplaySidecarTask } from "../host/session-replay-derivers.ts"\n`,
      "agent/turn-attachments.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(true)
  })

  it("finds MULTI-LINE static imports (specifier on a later line)", () => {
    const source = [
      `import {`,
      `  type ReplayToolRenderer,`,
      `  registerReplayRenderer,`,
      `} from "../../host/session-replay-derivers.ts"`,
      ``,
    ].join("\n")
    const sites = scanSourceForHostImports(source, "plugins/loader/replay-renderers.ts")
    expect(sites).toHaveLength(1)
    expect(sites[0].specifier).toBe("../../host/session-replay-derivers.ts")
  })

  it("flags dynamic import with a LITERAL specifier into host", () => {
    // src-root file → `./host/` is the in-repo host tree
    const sites = scanSourceForHostImports(
      `const m = await import("./host/cli/main.ts")\n`,
      "agent.ts",
    )
    expect(sites).toHaveLength(1)
    expect(sites[0].typeOnly).toBe(false)
  })

  it("ignores dynamic import with a computed (non-literal) argument", () => {
    expect(scanSourceForHostImports(`const m = await import(abs)\n`, "agent.ts")).toHaveLength(0)
    expect(
      scanSourceForHostImports(`const m = await import("./host/" + name)\n`, "agent.ts"),
    ).toHaveLength(0)
  })

  it('flags CommonJS require("literal") into host', () => {
    const sites = scanSourceForHostImports(`const x = require("./host/foo.ts")\n`, "agent.ts")
    expect(sites).toHaveLength(1)
    expect(sites[0].resolved).toBe("src/host/foo.ts")
  })

  it("ignores imports inside comments", () => {
    expect(
      scanSourceForHostImports(
        `// export * from "../host/dead.ts"\n/* import "../host/dead2.ts" */\n`,
        "ui/foo.ts",
      ),
    ).toHaveLength(0)
  })
})

describe("scanCoreHostImports (filesystem walk on a fixture tree)", () => {
  const root = mkdtempSync(join(tmpdir(), "core-host-scan-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("walks nested dirs, skips blessed files, counts sites per file", () => {
    mkdirSync(join(root, "ui"), { recursive: true })
    mkdirSync(join(root, "host", "cli"), { recursive: true })
    // core shim → violation
    writeFileSync(join(root, "ui", "compositor.ts"), `export * from "../host/ui/compositor.ts"\n`)
    // blessed entrypoint imports host → NOT a violation
    writeFileSync(join(root, "index.ts"), `import { runCli } from "./host/cli/main.ts"\n`)
    // host package internal import → NOT a violation (blessed prefix)
    writeFileSync(join(root, "host", "cli", "main.ts"), `import { x } from "../ui/compositor.ts"\n`)
    // core file with TWO host sites (src-root → ./host/)
    writeFileSync(
      join(root, "agent.ts"),
      `import { c } from "./host/ui/style/ansi.ts"\nimport type { T } from "./host/editor-controller.ts"\n`,
    )

    const sites = scanCoreHostImports(root)
    expect(sites.map((s) => s.file)).toEqual(["agent.ts", "agent.ts", "ui/compositor.ts"])

    const counts = countSitesByFile(sites)
    expect(counts.get("agent.ts")).toBe(2)
    expect(counts.get("ui/compositor.ts")).toBe(1)
    expect(counts.has("index.ts")).toBe(false)
    expect(counts.has("host/cli/main.ts")).toBe(false)
  })

  it("renderBaseline emits a paste-ready frozen literal", () => {
    const text = renderBaseline(scanCoreHostImports(root))
    expect(text).toStartWith("const BASELINE = new Map<string, number>([")
    expect(text).toContain('["agent.ts", 2],')
    expect(text).toContain('["ui/compositor.ts", 1],')
  })
})

// ---------------------------------------------------------------------------
// THE RATCHET: the repo-wide invariant. Core (src/ minus src/host/) must not
// grow its dependency on the host package. The baseline is the set of
// known-existing violations at Phase 3 (the src/ui/ re-export shims Jacob left
// intentionally + a few core test/agent files that still reach into
// src/host/). It may only shrink: a file absent from the baseline must have
// ZERO host imports, and a file in the baseline must not gain MORE. Regenerate
// after an intentional cleanup with the one-liner in the module header, and
// lower the numbers.
//
// BASELINE IS DEBT — must only shrink. These 54 sites are real core→host
// decoupling debt (the P3 re-export shims). They are scheduled for removal in
// Phase 4: Jacob's host adapter replaces the shims with SDK port wiring, at
// which point each entry burns down to zero. Burned down by Phase 4 port
// wiring. Do not regenerate upward — a growing count means new core→host
// coupling crept in, which is exactly what this test exists to stop.
//
// Last ratcheted down 2026-07-02 (turn-notice decoupling, Mia + Veronica):
// tool-round.ts 2→1 (glyphs extracted to host renderers; the remaining
// format.ts pipeline import is a documented Phase-4 follow-up), and
// auto-plugins/config/diff/first-run/modes/quota-summary burned to 0
// (host-ansi/formatter imports repointed to the plugin-api leaf package).
// ---------------------------------------------------------------------------
const BASELINE = new Map<string, number>([
  ["agent/agent.plugin-tool-feedback.test.ts", 1],
  ["agent/agent.queue-nav-repl.test.ts", 1],
  ["agent/agent.ts", 7],
  ["agent/ask-user-host.test.ts", 3],
  ["agent/model-error.test.ts", 1],
  ["agent/tool-round.ts", 1],
  ["agent/turn-attachments.ts", 1],
  ["bus/abort-quit-keystroke.test.ts", 1],
  ["e2e/command-repl-e2e.test.ts", 2],
  ["e2e/first-run.test.ts", 1],
  ["e2e/history-edit-repl.e2e.test.ts", 2],
  ["e2e/live-area-e2e.test.ts", 3],
  ["e2e/notification-frame-tear.e2e.test.ts", 1],
  ["e2e/prompt-inject-e2e.test.ts", 2],
  ["e2e/system-prompt-override-e2e.test.ts", 1],
  ["plugins/loader.replay-renderers.test.ts", 1],
  ["plugins/loader/replay-renderers.ts", 1],
  ["session/draft-store-editor.integration.test.ts", 1],
  ["session/queue-persist-e2e.test.ts", 2],
  ["test-utils/fixtures/paste-pty-driver.ts", 1],
  ["test-utils/fixtures/quit-confirm-tmux-driver.ts", 3],
  ["ui/choice-modal.ts", 1],
  ["ui/chrome/first-run.ts", 1],
  ["ui/command-list.ts", 1],
  ["ui/command-notice.ts", 1],
  ["ui/command-output.ts", 1],
  ["ui/command-table.ts", 1],
  ["ui/compositor.ts", 1],
  ["ui/formatter/formatter.ts", 1],
  ["ui/model-picker.ts", 1],
  ["ui/overlay.ts", 1],
  ["ui/render/unified-diff.ts", 1],
  ["ui/spinner/index.ts", 1],
  ["ui/spinner/named-presets.ts", 1],
  ["ui/startup/progress-spinner.ts", 1],
  ["ui/startup/tree.ts", 1],
  ["ui/status/format.ts", 1],
  ["ui/status/line-renderer.ts", 1],
  ["ui/status/scrollback.ts", 1],
  ["ui/style/ansi.ts", 1],
  ["ui/style/mode.ts", 1],
  ["ui/tool-transcript/format.ts", 1],
])

describe("core→host import ratchet (repo invariant)", () => {
  const sites = scanCoreHostImports("src", DEFAULT_HOST_ROOTS, DEFAULT_BLESSED, DEFAULT_EXEMPT)
  const counts = countSitesByFile(sites)

  it("no core file imports the host package beyond its frozen baseline", () => {
    const regressions: string[] = []
    for (const [file, n] of counts) {
      const allowed = BASELINE.get(file) ?? 0
      if (n > allowed) {
        regressions.push(`  ${file}: ${n} host import(s), baseline ${allowed} (+${n - allowed})`)
      }
    }
    expect(
      regressions,
      regressions.length > 0
        ? "core→host import ratchet TRIPPED — these core files gained host imports.\n" +
            "Core (src/ minus src/host/) must depend on SDK ports, not the host shell.\n" +
            "Move the shared code behind a port, or import from the host only in src/index.ts.\n" +
            regressions.join("\n")
        : "",
    ).toEqual([])
  })

  it("the baseline has no stale entries (a cleaned-up file must leave the baseline)", () => {
    const stale: string[] = []
    for (const [file, allowed] of BASELINE) {
      const actual = counts.get(file) ?? 0
      if (actual < allowed) {
        stale.push(`  ${file}: baseline ${allowed}, actual ${actual} — lower it to ${actual}`)
      }
    }
    expect(
      stale,
      stale.length > 0
        ? "core→host baseline has STALE entries — progress was made, ratchet it down.\n" +
            "Regenerate with the one-liner in core-host-import-scan.ts's header.\n" +
            stale.join("\n")
        : "",
    ).toEqual([])
  })
})
