# Concurrency cap: the SDK default is 10

Date: 2026-11-20. Scope: core (`src/config/concurrency-cap.ts`,
`src/sdk/tool-calls.ts`). Follows `2026-11-20-concurrent-tool-calls.md`.

## The change

`DEFAULT_MAX_CONCURRENT_TOOL_CALLS` is now 10 (was 1). `runToolCalls` uses
this constant when `AgentCoreConfig.maxConcurrentToolCalls` is omitted or
not valid (it used a literal 1 before). So an SDK host that does not set a
cap (for example `runtime.openSession` without `maxConcurrentToolCalls`)
gets the same default as the CLI.

The precedence does not change: env `MINIMAL_AGENT_MAX_CONCURRENT_TOOL_CALLS`
over config `maxConcurrentToolCalls` over the default.

## What stays opt-in

A call still runs in a wave only when its tool is concurrency-safe (built-in
list, manifest `concurrencySafe: true`, optional `concurrencySafe(input)`)
and the executor sets `ToolExecutor.concurrency`. An executor without a
policy, or a batch with no two concurrency-safe calls in a row, keeps the
serial loop byte for byte.

## Migration notes

- A host that wants the old serial loop sets `maxConcurrentToolCalls: 1`,
  or the env / config value to 1.
- A host that wraps a `ToolExecutor` must copy `concurrency` (and use the
  `ToolExecContext.gates` that core passes) to get an overlap.
- The CLI keeps its own default of 10. It is now the same as the SDK
  default.
