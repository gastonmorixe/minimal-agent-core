# Fix: plugin tool live feedback, cancellation, and UI-thread responsiveness

> 2026-06-07. A long-running plugin tool (Fetch) showed NO scrollback header
> until it finished, the status row lied that it was `⋯ stalled` after 2s, an
> ignored-abort path could wedge the whole REPL, and persisting a large tool
> body did synchronous fs + hashing on the UI thread. One root design flaw
> (a tool call modeled as an opaque `await` instead of a lifecycle), four
> user-visible symptoms. Fixed with TDD (red → green per bug).

## Symptoms

1. **No header until completion.** Running `Fetch https://…` rendered nothing
   in scrollback (`╭ ⤓ Fetch <url>`) until the handler resolved, up to 120s
   later. Built-in tools (Bash/Read) painted their header before executing;
   plugin tools did not.
2. **False "stalled".** The live status row flipped to the amber
   `⋯ stalled · last byte Ns ago` ~2s into every healthy plugin-tool call.
3. **REPL freeze on a wedged plugin.** A subprocess plugin handler that
   ignored its abort signal could never be canceled: Esc/Ctrl+C did nothing
   and the turn never ended until the OS or manifest timeout reaped it.
4. **UI stall on big bodies.** Persisting a multi-MB tool body ran
   `writeFileSync` + a synchronous sha256 + multiple full-body `split("\n")`
   passes on the single thread that paints the TUI and reads keystrokes.

## Root cause (one flaw, measured)

The tool-dispatch loop in `src/agent.ts` treated a tool call as a single
opaque `await loader.dispatch(...)` with ad-hoc side-channel flags, instead of
a lifecycle with explicit states. Built-in tools had a hand-rolled exception
(paint-first + stream chunks); plugin tools fell through every gap.

- **Bug 1.** `if (!pluginTool) writeToolHeader()` deliberately skipped the
  early header for plugin tools so it could reuse the handler's post-hoc
  `displayHeader`. Scrollback is append-only, so "reuse the later header"
  forced "paint nothing now".
- **Bug 2.** The status entry was seeded `direction:"down"` + `lastChunkAt`,
  which the renderer flips to `⋯ stalled` after `STALL_THRESHOLD_MS` (2s) with
  no new chunk. But chunks are fed only for Bash (`onStdout: isBash ? …`), so
  every non-streaming tool was guaranteed to "stall".
- **Bug 3.** `invokeSubprocess` did `await new Response(proc.stdout).text()`
  + `await proc.exited` and never read `ctx.abort` or killed the child.
- **Bug 4.** `BlobStore.write` is sync (`writeFileSync` + `createHash`), and
  `truncateToolOutput` / `computeTuiElision` counted lines via
  `split("\n").length`, allocating a per-line array over the full body just to
  read `.length`.

## Fixes

### Header timing is a per-tool Strategy (Bugs 1)

`src/agent.ts`: a tool either paints its header **now** (from data available
synchronously) or **defers** it until the handler returns a richer
`displayHeader` — never both, because scrollback can't be rewritten.

- Built-ins: paint early (unchanged).
- Plugin tools that declare `headerKey`: paint early from that input field.
  This is the opt-in for **long-running** tools that must show feedback
  immediately (Fetch → `url`).
- Plugin tools without `headerKey`: defer to `displayHeader`, exactly as
  before. These are the **instant** tools whose `displayHeader` IS the header
  (Task's `+ added 2 tasks · 0/2`, ShowDiff, MemoryTool, LockStatus).

New declarative manifest field `headerKey` (parsed in `manifest.ts`, carried
through `PluginToolDefinition` / `ToolDefinition`, surfaced by
`formatToolInput`). `ma-fetch`'s manifest sets `"headerKey": "url"`. Core
stays closed to per-plugin special-casing (OCP); each plugin opens up the one
field worth showing.

### Stall seeding only for streaming tools (Bug 2)

`src/agent.ts`: `toolStreamsOutput = tool.name === "Bash"` is the single source
of truth for both the seeded activity (`direction:"down"` + `lastChunkAt` only
when it streams, else neutral `idle`) AND the `onStdout`/`onStderr` wiring, so
"seeds stall" and "feeds chunks" can never drift apart again.

### Subprocess plugins honor abort (Bug 3)

`src/plugins/loader/helpers.ts`: `invokeSubprocess` now spawns `detached` (own
process group), races completion against the abort signal, and on abort
group-kills the child (`SIGTERM` → `SIGKILL` after a 2s grace) and settles the
call promptly with an error `tool_result`. Already-aborted-on-entry returns
without spawning. Mirrors core's `execBash` kill discipline in `src/tools.ts`.

### Off-thread persistence + allocation-free counting (Bug 4)

- `src/blob-store.ts`: new `writeAsync` (fs/promises) with the same eligibility
  gates and `{path,bytes,sha256}` result as `write`. The agent's plugin-result
  path `await`s it (it's already inside the async `run` generator), keeping the
  big body's fs write off the synchronous critical section.
- `src/tools/truncation.ts`: new `countLines` counts newline segments by
  scanning (zero allocation), used by `truncateToolOutput` and
  `computeTuiElision` instead of `split("\n").length`.

## Tests (TDD: red first, then green)

- `src/agent.plugin-tool-feedback.test.ts` — header painted before
  `dispatch` resolves (clean URL, not raw JSON); seeded activity never renders
  `stalled`.
- `src/plugins/loader/helpers.abort.test.ts` — subprocess settles in <5s on
  abort (was a 15s+ hang) and on already-aborted entry; no dangling child.
- `src/blob-store.async.test.ts` — `writeAsync` defers the fs op, lands the
  blob after `await`, honors the gates, matches the sync write byte/digest.
- `src/tools/count-lines.test.ts` — `countLines(s) === s.split("\n").length`
  across edge cases + large bodies.

Full gate: whole suite green (4684+ pass), typecheck clean, lint clean. The
full-suite run also caught a regression (the unconditional early-paint broke
the Task plugin's `displayHeader`), which is exactly what drove the per-tool
Strategy design above.

## Follow-ups (not in this change)

- Module-type plugin handlers still run in-process on the UI thread; a CPU-
  heavy synchronous handler body can still stall the loop. The framework-level
  fix is to push heavy module handlers to the subprocess path (now that
  subprocess honors abort) or run them off-thread.
- The deeper refactor is to model the whole tool call as an explicit
  `ToolPhase` discriminated union (`pending → running → streaming →
  done/error/aborted`) and collapse the live + session-replay header logic into
  one renderer. This change makes the cheap correctness fixes; the union is the
  structural follow-up.
