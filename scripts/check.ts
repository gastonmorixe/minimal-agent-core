type Step = {
  label: string
  command: string[]
}

const steps: Step[] = [
  { label: "typecheck", command: ["bun", "run", "typecheck"] },
  { label: "lint", command: ["bun", "run", "lint"] },
  { label: "format:check", command: ["bun", "run", "format:check"] },
  { label: "docs:check", command: ["bun", "run", "docs:check"] },
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
