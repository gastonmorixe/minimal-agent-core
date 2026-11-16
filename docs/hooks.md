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
rejection, or a timeout halts the chain with a deny reason. On
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
  → tool.didBatch                           (after parallel batch)
  → message.willSend / LifecyclePort.beforeSend
  → network
  → message.didSend
```

## Channel catalog (policy-relevant)

| Channel | Shape | Known analogue | Wired? |
|---------|-------|-----------------|--------|
| `turn.willStart` | chain | UserPromptSubmit | Yes (REPL `repl-editor-hooks.ts`, headless, host mode) |
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

## Tier boundaries

| Tier | Owns |
|------|------|
| 1 AgentCore | `message.willSend`, tool will/did/batch, compact (via LifecyclePort) |
| 2 InteractiveSession / host | `turn.willStart`, session start/stop, queue, abort |
| 3 Frontend | `editor.*`, keyboard, ANSI, compositor |

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

Subprocess hook handlers (`resolveHookSub` skips them). Shell/HTTP/prompt user hooks
(`settings.json`-style user hooks). PermissionRequest auto-ask
UI, MessageDisplay stream redaction, FileChanged watchers, enterprise managed
hook policy.
