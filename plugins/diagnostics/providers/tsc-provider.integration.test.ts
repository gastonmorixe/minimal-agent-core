/**
 * Integration test for {@link TscSpawnProvider} against REAL tsc.
 *
 * Creates a temp project with a tsconfig and a file containing known type
 * errors, then runs the provider and verifies it catches them with correct
 * TS codes. Skipped when `tsc` is absent so the suite stays green elsewhere.
 *
 * Uses this repo's own tsc binary (from the TypeScript devDependency).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { TscSpawnProvider } from "./tsc-provider.ts"

const REPO = join(import.meta.dir, "..", "..", "..")
const tscBin = join(REPO, "node_modules", ".bin", "tsc")

function scratchProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "diag-tsc-"))
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(root, rel), content)
  }
  return root
}

describe("TscSpawnProvider (real tsc)", () => {
  it.skipIf(!existsSync(tscBin))(
    "detects type errors with correct TS codes in a real project",
    async () => {
      const root = scratchProject({
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            noUncheckedIndexedAccess: true,
          },
          include: ["*.ts"],
        }),
        "broken.ts": [
          `function viz(label: string, ...vecs: number[][]) {`,
          `  const n = vecs[0].length;`,
          `  for (let i = 0; i < n; i++) {`,
          `    const val = vecs[0][i];`,
          `    const len = Math.round(Math.abs(val) * 10);`,
          `    return val >= 0 ? "pos" : "neg";`,
          `  }`,
          `}`,
        ].join("\n"),
      })

      try {
        const provider = new TscSpawnProvider(tscBin, root)
        const findings = await provider.check(join(root, "broken.ts"), "")
        const codes = findings.map((f) => f.code)

        // TS2532: Object is possibly 'undefined' — vecs[0] with noUncheckedIndexedAccess
        expect(codes).toContain("TS2532")
        // TS2345: Argument of type 'number | undefined' not assignable to 'number'
        expect(codes).toContain("TS2345")
        // TS18048: 'val' is possibly 'undefined'
        expect(codes).toContain("TS18048")

        // All findings should be from tsc and severity error
        expect(findings.every((f) => f.source === "tsc")).toBe(true)
        expect(findings.every((f) => f.severity === "error")).toBe(true)

        // Lines and columns should be numbers
        for (const f of findings) {
          expect(typeof f.line).toBe("number")
          expect(typeof f.col).toBe("number")
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it.skipIf(!existsSync(tscBin))(
    "returns empty array for a clean file",
    async () => {
      const root = scratchProject({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true },
        }),
        "clean.ts": `const x: number = 42\n`,
      })
      try {
        const provider = new TscSpawnProvider(tscBin, root)
        const findings = await provider.check(join(root, "clean.ts"), "")
        expect(findings).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    30_000,
  )
})
