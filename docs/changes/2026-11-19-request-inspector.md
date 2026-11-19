# Typed `llm.requestWillSend` instead of the text request dump

Date: 2026-11-19. Scope: core (transport, public exports) and the CLI host.

## The problem

Before each request, `--debug` showed a dump of the request (model, header
fields, tools, system blocks, messages). Core made this dump as TEXT:
`src/llm/transport/debug.ts` read `DEBUG` / `VERBOSE` from the environment,
formatted rows with cache markers and `...(+Nch)` hints, and emitted one
`transport.request-dump` Debug diagnostic per row. The CLI TUI then parsed
those rows again with regexes to draw a colored block. So:

- core held presentation code and read host env vars;
- the TUI depended on the exact text of core (markers, hints, indents);
- the structured data that the TUI needed traveled as flat diagnostic attrs.

## The contract

Core now gives data only. Module `src/llm/transport/request-inspector.ts`,
public at `@minimal-agent/core/host/request-inspector`:

- `REQUEST_WILL_SEND = "llm.requestWillSend"`: the event name.
- `RequestWillSendEvent`: `sessionId`, `ts` (from the diagnostics clock),
  `request: RequestSnapshot`, and `diagnostics: RequestDiagnostics` (the
  request's own handle; AgentCore passes its session scope).
- `RequestSnapshot`: an allowlist view of the request: `model`, `stream`,
  `maxTokens`, `requestType`, `thinking`, `outputConfig`, `speed`, `tools`,
  `system`, `messages`, and `cache` (indexes of the cache breakpoints, never
  marker text). It never holds `auth`, `credentialName`, `networkClient`,
  `signal`, `diagnostics`, ports or callbacks. The arrays are the caller's
  arrays by reference: the view is valid only during the synchronous
  subscriber call. Its types are deep-readonly (type level only: no freeze,
  no clone).
- `RequestDiagnostics`: a `Pick` of `Diagnostics` (`sessionId`, `emit`,
  `debug`, `warn`). At runtime it is the request's full diagnostics handle;
  the `Pick` only narrows the type, and a subscriber uses only those members.
- `RequestInspector`: `hasSubscribers()`, `subscribe(handler)` (returns an
  idempotent unsubscribe), `publish(build, diagnostics?)`. A throw from
  `build` or from a handler does not break the send: it is reported as a
  Warning under `REQUEST_INSPECTOR_SOURCE = "transport.request-inspector"`.
- `createRequestInspector()` (a new channel) and `processRequestInspector()`
  (the process channel).

`canonicalAttemptFn` uses `SendOptions.requestInspector` when it is set, and
the process channel when it is not (the same pattern as
`opts.diagnostics ?? processDiagnostics()`). Plugin `llm.complete` side calls
go through the same path.

## Zero cost

With no subscriber, the send site does one `??`, one function call and one
`Set.size` read (`opts.requestInspector ?? processRequestInspector()`, then
`hasSubscribers()`). It makes no closure, no object and no string. The snapshot is built only inside the `publish` thunk, at most once
for all subscribers. Core reads no `DEBUG` or `VERBOSE` env for this; a host
decides when to subscribe.

## Ownership

- Core: the event and the redacted snapshot.
- Host: the text, the colors, the width rules and the verbose view. The CLI
  subscribes only with `--debug`:
  - `src/logging/request-dump-model.ts` turns the snapshot into a typed view;
  - `src/logging/request-dump-text.ts` makes the plain rows (byte-identical to
    the old core rows) and `src/logging/request-dump-log.ts` re-emits them as
    `transport.request-dump` Debug diagnostics on the request's own handle
    (session log file, session event log, stderr mirror in print/protocol
    mode);
  - `src/ui/status/debug-dump*.ts` paints the REPL block from the typed view
    (byte-identical to before, proved by goldens).
  - `--verbose` shows full text with line gutters.

## Migration notes

- Removed from core: `src/llm/transport/debug.ts` (`requestDumpRows`,
  `requestDumpLines`, `debugRequestOptions`, `isDebug`, `isVerbose`), the
  private `src/utils/truncate-hint.ts`, and the type `RequestDumpRowData` from
  `./host/diagnostics`. The CLI owns its own `RequestDumpRowData` now.
- A host that wants the dump subscribes to `processRequestInspector()` (or
  passes its own inspector in `SendOptions.requestInspector`) and formats the
  snapshot itself. A host that does not subscribe gets no rows: setting
  `DEBUG=1` alone no longer makes core emit `transport.request-dump`.
- The web host gets no dump rows now (it got them only when its process ran
  with `DEBUG=1`).
- The CLI gate is `--debug` or `DEBUG=1`. `DEBUG` must be `1`; other values
  (for example `DEBUG=true` or `DEBUG=*`) no longer enable the request dump.
  The old core gate was any non-empty `DEBUG`. The REPL block already used
  the `DEBUG=1` rule; now the log rows use the same rule.
- One small output change in the CLI text: an explicit EMPTY `tools` or
  `system` list no longer prints a `[0 tool(s)]` / `[0 block(s)]` section
  (the snapshot gives `[]` for absent and empty). AgentCore and
  `llm.complete` never send an empty list.

## Follow-ups

- Web host: it has no request dump now. It can subscribe to
  `llm.requestWillSend` (`processRequestInspector()`) later, for a typed
  request view in the web trace.
- Thread a per-runtime inspector through `AgentCoreConfig` /
  `BuildAgentCoreDeps` / `SessionOptions`, like `statusPort`.
