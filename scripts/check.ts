type Step = {
  label: string
  command: string[]
}

const steps: Step[] = [
  { label: "typecheck", command: ["bun", "run", "typecheck"] },
  { label: "lint", command: ["bun", "run", "lint"] },
  // `biome:check` covers format + assist (including `organizeImports` /
  // import-sort) + Biome's own linter pass. Biome's linter is disabled
  // in biome.json (oxlint owns lint), so this run is effectively a
  // format + import-sort gate. Without it, import-sort drift accumulates
  // silently because `format:check` only checks formatting.
  //
  // Kept ALONGSIDE `format:check` for now so a pure-formatting failure
  // surfaces as a distinct line in CI output before the import-sort
  // check fires. Both gates passing means the tree is biome-clean.
  { label: "format:check", command: ["bun", "run", "format:check"] },
  { label: "biome:check", command: ["bun", "run", "biome:check"] },
  { label: "docs:check", command: ["bun", "run", "docs:check"] },
  // Architecture invariants (I1 provider-clean core, I2 core never imports
  // plugins, I3 plugins never import core) also run inside the full `bun
  // test` step below; this explicit step fails the gate FAST and surfaces
  // boundary violations as a distinct line in CI output. Matches
  // src/architecture/* unit tests + src/architecture.*.test.ts suites.
  { label: "test:arch", command: ["bun", "run", "test:arch"] },
  { label: "test", command: ["bun", "test"] },
]

for (const step of steps) {
  console.log(`\n> ${step.label}: ${step.command.join(" ")}`)
  const result = Bun.spawnSync(step.command, {
    stdout: "inherit",
    stderr: "inherit",
  })

  const code = result.exitCode ?? 1
  console.log(`< ${step.label}: exit ${code}`)

  if (code !== 0) {
    process.exit(code)
  }
}
