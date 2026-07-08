/**
 * Type-check the workspace with the TypeScript compiler.
 *
 * As of TypeScript 7 (GA 2026-07-08), `tsc` IS the native Go compiler that the
 * `@typescript/native-preview` `tsgo` binary previewed, so the old
 * tsgo-with-tsc-fallback dance is gone: there is one compiler and one command.
 */
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

const result = run("typecheck", ["bunx", "tsc", "--noEmit"])
process.exit(result.code)
