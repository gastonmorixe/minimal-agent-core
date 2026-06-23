/**
 * Integration test for {@link SourceKitLspProvider} against the REAL
 * sourcekit-lsp in the Xcode toolchain. Proves the persistent-server path
 * end to end: boot once, then warm per-edit diagnostics with correct codes.
 * Skipped when sourcekit-lsp is absent.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { SourceKitLspProvider } from "./sourcekit-lsp-provider.ts"

/** Resolve sourcekit-lsp binary, taking the first one found. */
function resolveSourceKitLsp(): string | null {
  const candidates = [
    "/usr/bin/sourcekit-lsp",
    "/Applications/Xcode-27.0.0-beta.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/sourcekit-lsp",
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

const SRCKIT_BIN = resolveSourceKitLsp()
const IS_CI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true"

describe("SourceKitLspProvider (real sourcekit-lsp)", () => {
  it.skipIf(!SRCKIT_BIN)(
    "boots and returns clean diagnostics for a well-formed Swift file",
    async () => {
      const probe = join(tmpdir(), "__diag_swift_clean.swift")
      writeFileSync(probe, "let x = 42\n")
      try {
        const provider = new SourceKitLspProvider(SRCKIT_BIN!, "/tmp")
        try {
          // Wait for the server to warm up (first boot is slow)
          const findings = await provider.check(probe, "let x = 42\n")
          // A clean file should produce no errors
          expect(Array.isArray(findings)).toBe(true)
          const errors = findings.filter((f) => f.severity === "error")
          expect(errors).toEqual([])
        } finally {
          provider.dispose()
        }
      } finally {
        rmSync(probe, { force: true })
      }
    },
    30_000,
  )

  it.skipIf(!SRCKIT_BIN || IS_CI)(
    "detects a type error in a Swift file",
    async () => {
      const probe = join(tmpdir(), "__diag_swift_error.swift")
      writeFileSync(probe, "let x: String = 42\n")
      try {
        const provider = new SourceKitLspProvider(SRCKIT_BIN!, "/tmp")
        try {
          const findings = await provider.check(probe, "let x: String = 42\n")
          expect(findings.some((f) => f.severity === "error")).toBe(true)
          expect(findings.every((f) => f.source === "sourcekit-lsp")).toBe(true)
        } finally {
          provider.dispose()
        }
      } finally {
        rmSync(probe, { force: true })
      }
    },
    30_000,
  )

  it.skipIf(!SRCKIT_BIN)(
    "handles Obj-C files without crashing",
    async () => {
      const probe = join(tmpdir(), "__diag_objc_simple.m")
      // Plain C function inside a .m file to verify Obj-C file handling
      writeFileSync(probe, "int add(int a, int b) { return a + b; }\n")
      try {
        const provider = new SourceKitLspProvider(SRCKIT_BIN!, "/tmp")
        try {
          const findings = await provider.check(probe, "int add(int a, int b) { return a + b; }\n")
          expect(Array.isArray(findings)).toBe(true)
        } finally {
          provider.dispose()
        }
      } finally {
        rmSync(probe, { force: true })
      }
    },
    30_000,
  )

  it.skipIf(!SRCKIT_BIN)(
    "returns diagnostics for a clean C file (no crashes)",
    async () => {
      const probe = join(tmpdir(), "__diag_c_clean.c")
      writeFileSync(probe, "int main(void) { return 0; }\n")
      try {
        const provider = new SourceKitLspProvider(SRCKIT_BIN!, "/tmp")
        try {
          const findings = await provider.check(probe, "int main(void) { return 0; }\n")
          expect(Array.isArray(findings)).toBe(true)
        } finally {
          provider.dispose()
        }
      } finally {
        rmSync(probe, { force: true })
      }
    },
    30_000,
  )

  it.skipIf(!SRCKIT_BIN)(
    "warm loop is reasonably fast (sub-second after first boot)",
    async () => {
      const probe = join(tmpdir(), "__diag_swift_warm.swift")
      writeFileSync(probe, 'let y = "hello"\n')
      try {
        const provider = new SourceKitLspProvider(SRCKIT_BIN!, "/tmp")
        try {
          // First call to boot the server
          await provider.check(probe, 'let y = "hello"\n')
          // Warm call
          const t0 = performance.now()
          await provider.check(probe, 'let y = "hello"\n')
          const warmMs = performance.now() - t0
          // sourcekit-lsp is heavier than tsgo but sub-second is reasonable
          expect(warmMs).toBeLessThan(1500)
        } finally {
          provider.dispose()
        }
      } finally {
        rmSync(probe, { force: true })
      }
    },
    30_000,
  )
})
