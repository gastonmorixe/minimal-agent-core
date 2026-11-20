# Concurrent tool calls: waves of concurrency-safe calls

Date: 2026-11-20. Scope: core (tool step scheduler, tool round, SDK ports,
config, plugin manifest, built-in tools, plugin-api types). Users: the CLI
host (status row, end-order blocks) and `ma-fetch-plugin` (plugins repo).
Design: `research/SPEC.md` (D1-D13, X1-X6), `research/decision-3prime.md`,
ADR `docs/adr/0001-opt-in-concurrent-tool-calls.md` (umbrella repo).
Terms: `GLOSSARY.md` (run, round, tool call, admission, batch, wave,
concurrency-safe, serial call, concurrency cap).

## The problem

The loop ran the tool calls of one round one after another
(`runToolCalls` in `src/sdk/tool-calls.ts`). A batch of 10 Fetch calls took
151 s, and the slowest call took 34 s. Most of that time was waiting on the
network, one call at a time.

## The contract

- **Waves.** Consecutive concurrency-safe calls of one batch form a wave.
  The runs of a wave overlap, at most the concurrency cap at the same time.
  Extra calls of a wave wait for a run slot in call order. A serial call is
  a barrier: it starts only after all earlier calls end, and no later call
  starts before it ends. Example: Fetch A, Fetch B, Edit C, Fetch D, Fetch E
  runs as wave (A, B), then C, then wave (D, E). Core does not move all
  concurrency-safe calls to the front.
- **Concurrency cap.** `AgentCoreConfig.maxConcurrentToolCalls` (also
  `BuildAgentCoreDeps` and `RuntimeCoreDeps`). An
  integer of 1 or more. The host resolves it with
  `resolveMaxConcurrentToolCalls({env, config})` (new
  `src/config/concurrency-cap.ts`, re-exported from `./host/config`): env
  `MINIMAL_AGENT_MAX_CONCURRENT_TOOL_CALLS` wins over the config key
  `maxConcurrentToolCalls` (`UserConfig`, `~/.minimal-agent/config.jsonc`),
  then the default. An invalid value at a layer is ignored. There is no CLI
  flag. The default is `DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 1` in
  `src/config/concurrency-cap.ts`. An omitted or invalid value in
  `AgentCoreConfig` also gives 1 (`runToolCalls`). The CLI commit of this
  change sets the default to 10 later.
- **Cap 1 is the old loop.** With cap 1, or when a batch has no two
  concurrency-safe calls in a row, `runToolCalls` runs the old serial code
  (`runToolCallsSerially`). The events and the saved bytes are the same as
  before (the goldens `tool-turn-golden` and `tool-outcome-golden` do not
  change). The scheduler (`src/sdk/tool-call-waves.ts`) loads only for a
  batch with a wave.

## Opt-in

A tool must opt in. The default for each tool is a serial call. The
decision has two steps (`src/tools/concurrency-safe.ts`):

1. Before admission, the flag of the tool:
   - Built-in tools: `Read`, `Glob`, `Grep` and `FilesStats`
     (`CONCURRENCY_SAFE_BUILTIN_TOOLS` in `src/tools/tools.ts`). The flag is
     not in the tool schema, so the `tools` array that the model gets does
     not change.
   - Plugin tools: the manifest field `concurrencySafe` (boolean, default
     `false`) on the headless tool trigger (`trigger.tool.concurrencySafe`;
     parser in `src/plugins/manifest-tool-flags.ts`).
   - A handler with `interactive: true` always makes a serial call, also
     with the flag.
2. After admission, with the input that a `tool.willInvoke` hook may have
   rewritten: the flag AND the optional handler export
   `concurrencySafe(input)` (plugin-api type `ToolConcurrencySafe`). Only a
   return value of `true` counts. Another value or a throw makes a serial
   call. The call then waits for all earlier calls, runs alone, and the next
   admission waits for it.

## Order rules

- **Admission** (input check, mode gate, `tool.willInvoke` hooks) runs one
  call at a time in call order. `tool_call` and the `running_tool` status of
  each call come before its admission, as before. So the ACP approval gate
  still gets the `tool_call` update before it asks.
- **Run.** Only the run of the call overlaps.
- **Post-run section** (decision 3'). The result chain, `tool.didInvoke`,
  the blob write and the toolView `outcome` event run one call at a time in
  END order: the first call to end its run goes first. So the REPL shows
  each result when its call ends.
- **Call order.** The save of the record, `tool_output`, `tool_result`,
  `results[]` and `tool.didBatch` stay in CALL order. A call is delivered
  only after all earlier calls of the batch are delivered and saved. So the
  saved results are always a prefix (1..k, never a gap), the next model
  request is the same as in a serial run, and the JSON and stream-json
  lines keep their order. Restore needs no change.
- Hook authors: key per-call state by `toolUseId`. See
  [`docs/hooks.md`](../hooks.md), section "Concurrent tool calls (waves)".

## Failures and abort

- A tool error, a hook deny or an input error ends only its own call. The
  other calls go on.
- Esc / Ctrl-C (the abort signal of the run): running calls get the signal.
  A call that did not start gets the result "tool aborted by user". Calls
  that ended keep their results. Core checks the signal again when a queued
  call gets its slot.
- A failure of the loop itself (an executor rejection, a save that
  throws): core aborts the running calls, waits until all calls settle (no
  bare `Promise.all`), saves the results in call order up to the first call
  with no result, and then rethrows.
- The scheduler uses no timers. The waits are promises that the calls
  resolve.

## Port changes

All changes are additive. Each new field is optional, and a host that sets
none of them gets the serial loop.

- `./sdk/ports`:
  - New `ToolCallGates`: `admitted(input | null): Promise<boolean>` (after
    admission; true when the call stays in the wave), `ran(): Promise<void>`
    (end of the run; enter the post-run section) and
    `inCallOrder(): Promise<void>` (leave the section; wait for the earlier
    calls). These types are new in this change, so no released code uses
    them.
  - New `ToolConcurrencyPolicy` (`toolFlag`, `isCallConcurrencySafe`).
  - `ToolExecutor.concurrency?` (optional). An executor without it makes
    only serial calls.
  - `ToolExecContext.gates?` and `ToolExecContext.concurrent?` (optional).
    An executor that has `concurrency` but calls no gates gets no overlap:
    the scheduler holds the whole call as its admission.
  - `AgentCoreConfig.maxConcurrentToolCalls?` (optional). The same
    optional field is on `BuildAgentCoreDeps` and `RuntimeCoreDeps`.
    `buildAgentCore` and `openAgentCoreSession` both forward it.
- Tool view port (`src/agent/tool-view-port.ts`, through
  `./host-kit/tool-executor-adapter`): the `started` event gets
  `concurrent?: boolean`. It is `true` only for a call in a wave of 2 or
  more that passed the per-input check. When it is false, the key is
  absent, so the events at cap 1 and in a one-call wave are the same as
  before.
- plugin-api: manifest `trigger.tool.concurrencySafe?`, the type
  `ToolConcurrencySafe`, and the loaded handler field `concurrencySafe?`.
- `./host/config`: `resolveMaxConcurrentToolCalls`,
  `normalizeMaxConcurrentToolCalls`, `parseMaxConcurrentToolCallsEnv`,
  `MAX_CONCURRENT_TOOL_CALLS_ENV`, `DEFAULT_MAX_CONCURRENT_TOOL_CALLS` and
  their types; `UserConfig.maxConcurrentToolCalls?`.
- No package subpath is added or removed. The status event has no change
  (`running_tool` still has only `toolName`).
- Comments that said "parallel tool batch" now say "batch"
  (`tool-batch-gate.ts`, `lifecycle.ts`, `hooks/channels.ts`,
  `docs/hooks.md`).

## Known behavior

- `tool.didInvoke` inside a wave fires in END order, one call at a time.
  `tool.didBatch` still gets the results in call order.
- X5: `ToolFeedbackTracker.observe` runs in the post-run section. Inside a
  wave, the truncation streak follows end order, not call order. The serial
  path does not change.
- Blob eviction inside a wave keeps the newest writes in END order (blob
  names are per tool use id; one write at a time). It does not keep the
  last calls in call order.
- `durationMs` on the wave path is the admission time plus the run time of
  the call. It does not include the wait for a run slot or for delivery.
  This is the same meaning as on the serial path.
- `tool.willInvoke` gets no abort signal. If the loop fails while a later
  call waits for a human answer in admission, the rethrow waits for that
  answer. The running calls get the abort first.
- A queued call that is aborted while it waits for its run slot already ran
  `tool.willInvoke`. It gets "tool aborted by user" and no `tool.didInvoke`.
  The same applies to a call that is aborted while it waits for the
  post-run section. That call still gets a toolView `outcome` event that
  marks it aborted. After a failure of the loop (not a user abort), a
  call that ended its run before the failed call still gets its real
  result, saved in call order.
- The `stamp` phase of the result chain runs one call at a time in call
  order, after the other result-chain phases (outside the post-run
  section).
- Fetch: `durationMs` includes the wait for a plugin slot (Fetch cap 4,
  below), because core measures around the run of the tool.

## Related changes

- **Fetch plugin** (plugins repo, `ma-fetch-plugin`): a Fetch call without
  a named session (`session` omitted or `""`, and no config
  `defaults.session`) is concurrency-safe. When the shared persistent worker
  is busy, an extra call uses the one-shot path. The plugin has its own cap
  of 4 one-shot processes (env `MINIMAL_AGENT_FETCH_MAX_CONCURRENT`;
  waiters in call order). Measured on a 32 GiB host: 10 one-shot calls at
  the same time had a peak RSS of 3.7 GB in total and used 6.9 of 10
  cores; `nytimes.com` alone took 2.3 GB.
- **CLI** (decision A): while 2 or more calls run, the status row shows one
  aggregated line, for example "Running N tools · Fetch ×7 · (12s)", with
  the timer of the oldest call that still runs. With one call, the row is
  the same as before. Calls in a wave write their rows as one block when
  the call ends (from `started.concurrent`). The CLI commit sets the
  default cap to 10.

## Migration notes

- No action for a host that does not set `maxConcurrentToolCalls`: the
  loop is the same as before.
- A host that sets a cap above 1 must accept results in end order on the
  REPL ports (toolView, status port). The SDK events stay in call order.
- A plugin tool that only reads can opt in with
  `"concurrencySafe": true`. Use the `concurrencySafe(input)` export when
  only some inputs are safe.
- Do not use `ToolSupport.parallel` or `parallelToolCalls` for this. They
  are model capabilities and have no relation to the scheduler.

## Follow-ups

- Start a call while the model still streams the response.
- Read-only detection for Bash commands (Bash stays a serial call).
- A fix of the in-process file lock (two writers in one process).
- A new field on the status event (for example a count of open calls).
- The web status line, the print mode lines and the sub-agent lane
  `inFlight` slot show one call only.
- Core reports the run time apart from the slot wait (Fetch `durationMs`).
- An abort signal for `tool.willInvoke`.
