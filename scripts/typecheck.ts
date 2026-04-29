type CommandResult = {
  code: number
}

function run(label: string, command: string[]): CommandResult {
  console.log(`\n> ${label}: ${command.join(" ")}`)
  const result = Bun.spawnSync(command, {
    stdout: "inherit",
    stderr: "inherit",
  })

  const code = result.exitCode ?? 1
  console.log(`< ${label}: exit ${code}`)
  return { code }
}

const fast = run("typecheck:fast", ["bunx", "tsgo", "--noEmit"])

if (fast.code === 0) {
  process.exit(0)
}

console.error("\ntsgo failed. Running the stable TypeScript compiler as fallback.")
const fallback = run("typecheck:fallback", ["bunx", "tsc", "--noEmit"])

if (fallback.code === 0) {
  console.error("\ntsc passed after tsgo failed. Treat this as a native preview mismatch.")
  process.exit(0)
}

process.exit(fallback.code)
