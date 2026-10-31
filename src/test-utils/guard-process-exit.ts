/**
 * Test-run guard, preloaded by `bunfig.toml` for every `bun test` run: no
 * test may end the test process.
 *
 * A real `process.exit(code)` inside a test kills the runner with that code.
 * Every later test file then never runs, and an exit code of 0 reads as a
 * green gate. Code that must exit takes an injected exit function instead
 * (for example `EditorControllerOptions.exitFn`), and tests pass a no-op or a
 * recorder. A test that needs to observe a direct call can still
 * `spyOn(process, "exit")`.
 *
 * @module test-utils/guard-process-exit
 */

process.exit = ((code?: number | string | null): never => {
  throw new Error(
    `process.exit(${code ?? ""}) was called inside bun test. A real exit ends the ` +
      "whole test run, so inject an exit function (for example EditorControllerOptions.exitFn).",
  )
}) as typeof process.exit
