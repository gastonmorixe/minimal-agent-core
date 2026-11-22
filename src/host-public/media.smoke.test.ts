/**
 * Smoke test: the media kit resolves and works through the package name, and
 * the paste and clipboard subpaths are gone (paste plugin v3, A4: the CLI owns
 * that code in `src/paste/`).
 *
 * @module host-public/media.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { createMediaRegistry, formatMediaToken } from "@minimal-agent/core/host-kit/media"

describe("./host-kit/media (public subpath)", () => {
  it("registers bytes and formats a token", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
    const item = createMediaRegistry().registerBytesSync(png, "clipboard", "image/png")
    expect(formatMediaToken(item)).toMatch(/^\[Image #[0-9a-f]{8}\b/)
  })

  it("the paste and clipboard subpaths do not resolve", () => {
    for (const sub of ["clipboard", "paste-intercept", "clipboard-token"]) {
      const spec = `@minimal-agent/core/host/${sub}`
      expect(() => Bun.resolveSync(spec, import.meta.dir), spec).toThrow()
    }
  })
})
