# Hooks — lifecycle policy seams

Plugin hooks participate in the agent's lifecycle pipeline. Observation-only
events ride the EventBus (`broadcast-async`); veto/rewrite seams ride the
HookBus (`chain`, `broadcast-sync`, `stream`).

AgentCore never imports HookBus. It depends on [`LifecyclePort`](../src/sdk/lifecycle.ts)
(DIP). The host wires [`LifecyclePortAdapter`](../src/adapters/lifecycle-port-adapter.ts)
over `loader.hooks()`.

## Declaring a hook

Hooks exist only inside plugins. There is no user-config hook surface.
A plugin declares them in `manifest.json` under `headless.hooks[]`
(parsed by `parseHookSub` in `src/plugins/manifest.ts`):

```json
{
  "permissions": ["hooks:tool.willInvoke"],
  "headless": {
    "hooks": [{
      "id": "deny_dangerous_bash",
      "channel": "tool.willInvoke",
      "handler": { "type": "module", "path": "./handlers/deny.ts", "export": "default" },
      "priority": 10,
      "timeoutMs": 2000,
      "failClosed": false,
      "observeOnly": false
    }]
  }
}
```

The allowed keys are `id`, `channel`, `handler`, `priority`, `observeOnly`,
`timeoutMs` and `failClosed`. Any other key is a manifest error.

The loader (`src/plugins/loader/hook-subs.ts` and `resolveHookSub` in
`loader/event-subs.ts`) logs and drops a hook when:

- the channel is not in `channels.ts`.
- `permissions[]` does not grant the channel's permission.
- the handler is not `type: "module"`. **Subprocess hook handlers are not
  supported.** Subprocess handlers work only for `events[]`, which cannot
  veto or rewrite.
- the module cannot be found or imported, or has no default-export
  function.
- the manifest sets `requiresUnsafeHooks: true` and `UNSAFE_HOOKS=1` is not
  set. This skips every hook in the plugin. Its tools and events still
  load.

A handler is `(payload, ctx) => result | Promise<result>`. `ctx` is a
`HookHandlerContext` with `channel`, `packageDir`, `cwd`, `env`, `abort`,
`priority`, `emit(channel, payload)`, `log`, `agent`, and, when available,
`stderr` and `listCommands`.

## Shapes

| Shape | Bus | Blocking? | Can rewrite / veto? |
|-------|-----|-----------|---------------------|
| `chain` | HookBus | Yes (awaited) | Yes — `{payload}`, `{halt:true}` |
| `broadcast-sync` | HookBus | Yes (inline) | Via shared mutable holders (e.g. `editor.key`) |
| `broadcast-async` | EventBus | No | No |
| `stream` | HookBus | Producer-driven | N/A |

## Policy decision contract

Typed as `PolicyDecision<T>` in `src/sdk/lifecycle.ts`:

- **`allow`** — continue; `payload` may be rewritten (updated tool input, redacted messages)
- **`deny`** — stop; `reason` is model/user-facing
- **`ask`** — reserved. `isDenied()` treats it as deny until an ask-user host path exists. No listener return maps to it.

HookBus listener returns map to decisions:

| Listener return | Decision |
|-----------------|----------|
| `void` / `undefined` | allow (pass-through) |
| `{ payload }` | allow with rewrite |
| `{ halt: true, reason? }` | deny |
| `{ payload, halt: true }` | deny (payload kept for audit) |
| `{ additionalContext: HookContextEntry[] }` | allow, plus context entries (also valid next to `payload` / `halt`). An entry is a `string` or `{ text: string; position?: "before" \| "after" }` |

### Hook context (`additionalContext`)

A `chain` listener may return `additionalContext: HookContextEntry[]`, alone
or with `payload` / `halt`. An entry is a `string` or
`{ text: string; position?: "before" | "after" }`. A string, and an object
with no `position`, mean `"after"`. A plugin imports the type with
`import type { HookContextEntry } from "@minimal-agent/core/plugin-api/types/plugin"`.
It is defined in `plugin-api/src/types/hook-context.ts` (the one source of
truth), and core re-exports it from `@minimal-agent/core/sdk/lifecycle` for
hosts.
`emitChain` collects the entries as they are, in listener order, into
`ChainEmitResult.additionalContext`. That field is always an array, also on a
halt. `chainResultToDecision` copies it onto `PolicyDecision.additionalContext`
only when it is not empty (an empty array leaves the field unset).
Every site wraps the texts with `wrapHookContext`, and
`splitHookContext` splits entries into `{ before, after }`
([`src/sdk/hook-context.ts`](../src/sdk/hook-context.ts)). Blank entries are
dropped. For a `failClosed` listener, a malformed entry (no string `text`, or
a `position` that is not `"before"` or `"after"`) is a malformed result and
denies. For other listeners a malformed entry is skipped.

`position` counts only on `turn.willStart` and `session.willStart`. On every
other channel the entry text lands where the table says and the position is
ignored. Where the context lands:

| Channel | Destination |
|---------|-------------|
| `tool.willInvoke` / `tool.didInvoke` | Appended to that call's tool result (a text block when the result is a block array). Position ignored |
| `turn.willStart` | The first user message of the turn (`AgentCore.run(text, { additionalContext })`): `"before"` entries before the prompt, the rest after it |
| `turn.willStop` | Part of the continuation note (only on a halt). Position ignored |
| `session.willStart` | `AgentCore.addSessionContext`: one time, in the next user message. In the first user message of a turn, `"before"` entries before the prompt, the rest after it |
| other chain channels (`subagent.willSpawn`, ...) | As before. Position ignored |

Order of the first user message of a turn:

1. leading `tool_result` blocks (orphan repair) and turn markers (abort or
   resume marker, mode change, turn attachments, save echoes), unchanged;
2. session `"before"` block, then `turn.willStart` `"before"` block;
3. the user text;
4. session `"after"` block, then `turn.willStart` `"after"` block.

**Behavior change:** a plain string `session.willStart` entry now lands
AFTER the user text, the same as on every other channel. Before hook context
positions, session context landed before the user text. Return
`{ text, position: "before" }` to keep the old placement.

Each group is one text block, wrapped by `wrapHookContext`. An empty group
adds no block. Session context that lands in a later user message (mid-turn,
or after a compaction inside a turn) goes before that message content,
after the leading `tool_result` blocks: the `"before"` block, then the
`"after"` block.

Session context is part of the message history, so it is persisted and stays
in later requests and on resume. The system prompt does not change, so the
prompt cache prefix stays the same: only the newest message changes.
Dedupe: when a user message in the current history already has a text
block with the same wrapped lines, no second block is added. Each group
(before, after) dedupes on its own against every text block of every user
message, before or after the user text. So a resume that sends the same
`session.willStart` context again adds nothing, also for a block that an
older version persisted before the text. New or changed lines add a new
block. A block does not record its position: a new `"before"` group whose
text equals an old `"after"` block is not added again, and that text stays
after. Within one take, an `"after"` entry with the same text as a
`"before"` entry is dropped, so the text lands one time, before.

**Silence never approves past a hard gate.** Mode/CLI permission deny runs
*before* `tool.willInvoke`. Hooks may further deny or rewrite; they cannot
allow a tool the mode already refused.

## Errors, timeouts, and approval gates (`failClosed`)

A `chain` listener that throws, rejects, or exceeds its `timeoutMs` is
logged and skipped. The chain goes on (fail open). With no other
listener, the result is allow. So a buggy unrelated hook cannot block
all progress.

A hook whose job is to approve or deny (an approval gate) sets
`failClosed: true` in its manifest entry (`hooks[].failClosed`, or the
`failClosed` listen option). For that listener only, a throw, a
rejection, or a timeout halts the chain (a deny, with the failure facts). On
`tool.willInvoke`, the model gets a tool error for that one call, and the
turn continues. `failClosed` cannot be combined with `observeOnly`.
`timeoutMs` has no default: omit it, and the bus waits for the listener.

## Pipeline order (tools + send)

```text
model tool_use
  → CLI --tools / mode permissions          (hard deny)
  → tool.permissionChecked                  (observe)
  → tool.willInvoke / LifecyclePort.beforeTool
  → execute (Write/Edit/Bash/plugin)
  → tool.didInvoke
  → tool_result to model
  → tool.didBatch                           (after the batch)
  → message.willSend / LifecyclePort.beforeSend
  → network
  → message.didSend
```

### Concurrent tool calls (waves)

When the concurrency cap is more than 1, the runs of concurrency-safe tool
calls in a batch can overlap (a wave). The hook order stays the same for
each call:

- `tool.willInvoke` runs one call at a time, in call order. The next call
  does not start its admission before the admission of the call before it
  ends.
- Inside a wave, `tool.didInvoke` runs one call at a time, in END order:
  the first call to end its run goes first. Each payload is for one call,
  keyed by its `toolUseId`. The result chain, the blob write and the host
  `outcome` event of the call run in the same step. The save and the SDK
  events (`tool_output`, `tool_result`) stay in call order.
- Between these two hooks, the run of a call can overlap with the runs of
  other calls. Thus, a listener must key per-call state by `toolUseId`. Do
  not keep "the current call" in one variable, and do not expect the
  `tool.didInvoke` order to be the call order.
- `tool.didBatch` still runs one time after the batch, with the results in
  call order.

## Channel catalog (policy-relevant)

| Channel | Shape | Known analogue | Wired? |
|---------|-------|-----------------|--------|
| `turn.willStart` | chain | UserPromptSubmit | Yes (REPL `repl-editor-hooks.ts`, headless, host mode) |
| `turn.willStop` | chain | Stop | Yes (AgentCore, `TurnStopGate`) |
| `session.willStart` | chain | SessionStart | Yes (host: startup/resume. AgentCore: compact) |
| `tool.willInvoke` | chain | PreToolUse | Yes (`executeToolRound`) |
| `tool.didInvoke` | chain | PostToolUse | Yes. Rewrite only: `afterTool` keeps the payload and ignores `halt` |
| `repl.modeWillChange` | chain | — | Declared, but nothing emits it yet |
| `tool.didBatch` | chain | PostToolBatch | Yes (AgentCore) |
| `message.willSend` | chain | (wire redaction) | Yes (AgentCore) |
| `message.didSend` | broadcast-async | — | Yes |
| `compact.willRun` / `compact.didRun` | chain / async | Pre/PostCompact | Yes |
| `subagent.willSpawn` | chain | SubagentStart (blocking) | Yes (plugin) |
| `agent.*` / `turn.didEnd` / `turn.aborted` | broadcast-async | Session/Stop | Yes (host) |
| `cwd.didChange` | broadcast-async | CwdChanged | Yes |
| `instructions.didLoad` | broadcast-async | InstructionsLoaded | Yes |
| `editor.*` | sync/async | — | Yes (Tier 3) |

Full static list: [`src/plugins/hooks/channels.ts`](../src/plugins/hooks/channels.ts).

### `target.didSwitch` (plugin event, not a hook channel)

`target.didSwitch` is an event on the plugin **event bus** (manifest
`events[]`, `"on": "target.didSwitch"`), not a HookBus channel. A plugin
cannot stop or change a switch with it.

- **Payload:** `{ from, to }`. Each one is a `TargetSnapshot`:
  `{ credentialName?, providerId?, model, effort? }`. No token and no secret.
- **When:** after each change of the live target of the session
  (`AgentCore.switchTarget`, `setModel`, `setEffort`, or an automatic model
  adoption). Not for a change to the same target.
- **Who sends it:** the CLI, not core (`minimal-agent-cli`
  `src/startup/live-target.ts`). The TUI and host mode (ACP) send it: they
  have one session for each process. The web host does **not** send it, and
  it does not set `ctx.queryTarget`: it has many sessions in one process.
- **Read the live target** at any time with `ctx.queryTarget?.()`.
- A host that is not the CLI gets the same change from
  `AgentCore.onTargetChange(listener)`.

After a switch the prompt cache starts again: the system prompt is built
again and the old thinking is discarded.

### `turn.willStop`

Permission `hooks:turn.willStop`. Payload `TurnWillStopPayload`:
`{ lastAssistantText, stopHookActive, sid?, agentId?, leadSid? }`. It fires
when a round ends with no tool calls. A halt continues the turn: the reason
(`DEFAULT_STOP_HOOK_REASON`, `"Turn stop blocked by turn.willStop hook."`,
when the listener gives a blank one) and the listener context become a
user-role continuation note, and another round runs.
`stopHookActive` is true on a round that a halt caused. The cap is
`AgentCoreConfig.maxStopHookHalts` (default 8) halts per turn. The count
starts at 0 for each turn. Tool rounds between two stops do not reset it,
so a hook cannot keep the turn open for ever. The next halt past the cap
emits a `stop_hook_capped` TurnNotice and the turn ends. Without a halt,
the listener context is ignored. A port throw ends the turn. A throw,
timeout, or malformed result of a `failClosed` listener also ends the turn
(no continuation). It is not a halt and does not count toward the cap: the
HookBus marks it `failed: true`, and the adapter maps it to allow. The loop
races the hook against the turn abort signal, so an abort ends the turn as
aborted at once, also when the hook never resolves. A turn that ends on a
refusal or a content filter skips the hook.

### `session.willStart`

Permission `hooks:session.willStart`. Payload `SessionWillStartPayload`:
`{ source: "startup" | "resume" | "clear" | "compact", sid, cwd, model }`.
It cannot block: a halt is ignored, and only the listener context is kept.
The CLI host emits `startup` / `resume` before the first turn. AgentCore
emits `compact` after a compaction commits. Its `cwd` comes from the host
`AgentCoreConfig.sessionFacts` (the CLI gives `process.cwd()`). It is `""`
when the host sets no `sessionFacts` or the function gives no `cwd`.
`clear` is reserved: nothing emits it yet.

### Payload fields

`tool.didInvoke` carries `isError: boolean`. `turn.willStart`,
`tool.willInvoke`, `tool.didInvoke` and `compact.willRun` carry optional
`sid?: string` and `agentMode?: string` (the active agent mode id, not the
compact engine mode). The `sid` is the id of the session that runs the
loop (`AgentCoreConfig.sessionFacts`). A runtime `Session` gives its own
`Session.id`, so two sessions in one process have different `sid` values.

## Tier boundaries

| Tier | Owns |
|------|------|
| 1 AgentCore | `message.willSend`, tool will/did/batch, compact, `turn.willStop`, `session.willStart` (source `compact`) (via LifecyclePort) |
| 2 InteractiveSession / host | `turn.willStart`, `session.willStart` (source `startup` / `resume`), session start/stop, queue, abort |
| 3 Frontend | `editor.*`, keyboard, ANSI, compositor |

Port methods for the new seams: `LifecyclePort.beforeTurnStop`
(`turn.willStop`), `LifecyclePort.sessionWillStart` (`session.willStart`),
and `AgentCore.addSessionContext` (the host queues the `session.willStart`
context there).

## Permissions

Manifests declare `permissions: ["hooks:tool.willInvoke", …]` (wildcards like
`hooks:tool.*` allowed). The loader drops subscriptions without a matching grant.

## File-lock vs `tool.willInvoke` (evaluation)

Cooperative file locking today is hardwired in `tools.ts` (acquire before
Write/Edit, release after). Now that `tool.willInvoke` / `tool.didInvoke` are
trustworthy emit sites, a follow-on could re-home acquire/release into a
first-party listener — **but only if** cooperative semantics stay identical
(same lock file paths, same refusal chrome, no race with mode deny). Keep the
hardwired path until an integration test proves parity; do not regress.

Reference fixture: `ma-policy-ref-plugin` (disabled by default) denies
dangerous Bash and redacts `sk-` tokens on `message.willSend`.

## Out of scope (v1)

Subprocess handlers in manifest `headless.hooks[]` (`resolveHookSub` skips
them). Core does not run shell, HTTP or prompt hooks. Shell user hooks
(`settings.json`-style) belong in a plugin (`ma-hooks-plugin`) that listens
on the HookBus like any other plugin. PermissionRequest auto-ask UI,
MessageDisplay stream redaction, FileChanged watchers, enterprise managed
hook policy. A `session.willStart` emitter for source `clear`.
