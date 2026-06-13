# Plugin Subsystem Code Review

Read-only review of `src/plugins/` in the minimal-agent codebase (Bun + TypeScript).
Working tree is clean (no diff to review), so this is a full review of the subsystem
as it stands on branch `dev-private`.

## Scope reviewed (files + line counts)

| File | Lines |
|---|---|
| `src/plugins/loader.ts` | 1465 |
| `src/plugins/manifest.ts` | 955 |
| `src/plugins/scanner.ts` | 546 |
| `src/plugins/stream.ts` | 137 |
| `src/plugins/types.ts` | 21 (re-export shim) |
| `src/plugins/event-bus.ts` | 313 |
| `src/plugins/agent-context.ts` | 195 |
| `src/plugins/loader/discovery.ts` | 318 |
| `src/plugins/loader/helpers.ts` | 355 |
| `src/plugins/loader/event-subs.ts` | 568 |
| `src/plugins/loader/fragments.ts` | 170 |
| `src/plugins/loader/setups.ts` | 99 |
| `src/plugins/loader/turn-attachments.ts` | 121 |
| `src/plugins/loader/replay-renderers.ts` | 107 |
| `src/plugins/hooks/hook-bus.ts` | 364 |
| `src/plugins/hooks/hooks.ts` | 222 |
| `src/plugins/hooks/channels.ts` | 320 |
| `src/plugins/hooks/types.ts` | 112 |
| `src/plugins/hooks/tool-lifecycle.ts` | 117 |
| `src/plugins/v2/host.ts` | 94 |
| `src/plugins/v2/host-capabilities.ts` | 373 |
| `src/plugins/v2/plugin-sdk.ts` | 26 |
| `src/plugins/v2/bash-tool-plugin.ts` | 20 |
| `src/plugins/v2/providers/sessions-read.ts` | 458 |
| `src/plugins/v2/providers/blobs-read.ts` | 85 |

`*.test.ts` files were skimmed for coverage gaps only, not reviewed line-by-line.

---

## CRITICAL

### C1. Capability-gated host data is exposed via unsanitized `sid` → path traversal
**`src/plugins/v2/providers/blobs-read.ts:36,39,51,69` and `src/plugins/v2/providers/sessions-read.ts:202,121-123,430`**

`blobs-read.ts` carefully validates `toolUseId` against `/^[A-Za-z0-9_-]+$/`
(line 68, with the comment "Defend against path traversal through a hostile
tool_use_id") but never validates `sid`. `sid` flows straight into
`blobDir(sid) = join(dir, `${sid}.blobs`)` (line 36) for both `list` and `read`,
and in `sessions-read.ts` into `sessionFilePath(sid, dir) = join(dir, `${sid}.jsonl`)`
(via `readRecords`/`dump`) plus `join(dir, `${sid}.tasks.jsonl`)` etc. `sid` is
model/plugin-controlled (the `sessions` plugin passes whatever sid it was handed).
A `sid` like `../../../../etc/hosts%00`-style value, or just `../../somewhere/secret`,
escapes the sessions root: `join(dir, "../../foo.jsonl")` resolves outside
`~/.minimal-agent/sessions`. This turns `sessions:read`/`blobs:read` from
"read the session store" into "read/list arbitrary `*.jsonl` / `*.blobs` paths on
disk," defeating the capability scoping.
**Fix:** validate `sid` with the same character-class guard already used for
`toolUseId` (reject anything not matching `^[A-Za-z0-9_-]+$`, which is the real
session-id shape), in both providers, before any path join. Centralize it in
`session-store.ts:sessionFilePath` so every caller is covered.

---

## HIGH

### H1. Full `process.env` is handed to every plugin handler and subprocess regardless of capabilities
**`src/plugins/loader.ts:1355` (dispatch), `:890` (dispatchCommand); `src/plugins/loader/event-subs.ts:129,256`; `src/plugins/loader/fragments.ts:109`; `src/plugins/loader/setups.ts:81`**

Every plugin context builds `env: { ...process.env, TUI_PLUGIN_PROTOCOL: "1", ... }`.
This leaks the host's entire environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
AWS creds, etc.) into every module handler's `ctx.env` and, more dangerously, into
the spawned environment of every subprocess handler, even for plugins that declared
zero `capabilities`. The v2 host goes to great lengths to deny-by-default session/blob
access, then ships all secrets in `ctx.env` next to it.
**Fix:** pass an allowlisted env (PATH, HOME, LANG, TERM, the `MINIMAL_AGENT_*`
identity vars, palette) by default; gate any broader env behind an explicit
capability/manifest opt-in. At minimum strip known-secret keys.

### H2. Module (in-process) plugins have no isolation, so the capability host is an organization boundary, not a security one
**`src/plugins/v2/host.ts` (whole), `src/plugins/loader/helpers.ts:178-213`**

Module handlers are loaded with `await import(abs)` and run in the host process,
sharing its heap and globals. Such a plugin can `import("../../some-host-module")`,
read/patch globals, or reach the registry mutators directly, completely bypassing
the `PluginHostV2` deny-by-default surface. The header comments frame the host as a
trust/least-privilege control ("a plugin that forgot to declare `sessions:read`
cannot reach the session store even though the code for it is loaded in-process"),
which is not true for a malicious module plugin. The capability host only
meaningfully constrains *subprocess* handlers.
**Fix:** document explicitly that module plugins are fully trusted and the host is a
code-decoupling/ergonomics boundary; reserve the security claims for the subprocess
path. If real isolation is wanted for untrusted plugins, they must run as subprocesses
(or workers) with a brokered RPC, not as in-process imports.

### H3. `models:read` exposes live, mutable registry records — a read capability that grants writes
**`src/plugins/v2/host.ts:64-73`, `src/plugins/v2/host-capabilities.ts:317-331`**

`models.list()/find()/resolve()` return the registry's own `ModelEntry` objects
(`findModel`, `resolveModel`, `listRegisteredModels` are passed through verbatim).
The interface doc says "treat them as read-only," but nothing enforces it: a plugin
holding only `models:read` can mutate pricing/tags/ports in place, corrupting shared
host state for the whole process. `host.ts:11` also claims the host is "deep-frozen,"
but `Object.freeze` is applied only to the host and each sub-API object — not
recursively, and not to method return values.
**Fix:** return defensive copies (or deep-frozen snapshots) from the `models:read`
methods, and soften the "deep-frozen" comment to "shallow-frozen surface."

---

## MEDIUM

### M1. `dispatch()` never clears its timeout timer and assigns the wrong value to `timer`
**`src/plugins/loader.ts:1330-1332,1384-1391`**

`const timer = setTimeout(() => ctrl.abort(), this.timeoutMs).unref?.()` stores the
*result of `.unref()`* (in Bun, `undefined`) into `timer`, and the `finally` block
(1384-1391) never calls `clearTimeout`. So every tool dispatch leaves a live
`this.timeoutMs` (default 5 min) timer that fires `ctrl.abort()` on an
already-settled controller. Compare `dispatchCommand` (873-875, 933), which keeps the
timer reference and clears it correctly. Harmless abort, but a per-dispatch timer leak
and an inconsistency that will bite if the controller is ever reused.
**Fix:** `const timer = setTimeout(...); timer.unref?.()` then `clearTimeout(timer)` in
the `finally`, mirroring `dispatchCommand`.

### M2. Event/live-area subprocess handlers have no timeout, abort, or output cap
**`src/plugins/loader/event-subs.ts:319-358` (event), `:446-460` (live-area)**

`invokeEventSubprocess` spawns a child, writes stdin, then
`await new Response(proc.stdout).text(); await proc.exited` with no abort wiring,
no timeout, and no size cap. A plugin subprocess that never closes stdout hangs that
promise forever (leaking the process + pipe), and one that floods stdout can exhaust
host memory. The live-area subprocess (446) is the same and additionally resolves a
`timeoutMs` default (helpers via `resolveLiveAreaSlot`, line 383) that is never applied
here. Contrast `invokeSubprocess` in `helpers.ts:299-329`, which does race an abort
signal and group-kill the tree.
**Fix:** reuse the abort-race + SIGTERM/SIGKILL escalation from `invokeSubprocess`,
enforce the slot's `timeoutMs`, and bound the stdout read (cap bytes, like the
scanner's `maxSpanBytes`).

### M3. Unbounded subprocess stdout reads across all four spawn sites
**`src/plugins/loader/helpers.ts:317`, `event-subs.ts:339,456`, `fragments.ts:166`**

Every `new Response(proc.stdout).text()` reads to EOF with no ceiling. A plugin
(buggy or hostile) returning gigabytes of stdout will OOM the host. This is the only
plugin output path lacking the size discipline the inline-tag scanner already enforces.
**Fix:** read with a byte cap and truncate/error past it.

### M4. No per-plugin teardown; subscription unsubscribe handles are discarded
**`src/plugins/loader/event-subs.ts:175,292`; `src/plugins/loader.ts` (no `dispose()`)**

`bus.on(...)` (event-subs 175) and `hooks.on(...)` (event-subs 292) both return an
unsubscribe `Disposer`, and both are thrown away. `PluginLoader` has no `dispose()`
and no way to unload a single plugin; replay-renderer and turn-attachment factories
are registered into *global* registries (`replay-renderers.ts:105`,
`turn-attachments.ts:115`) with no rollback. Fine for boot-once, but it means a
failed/late-disabled plugin's listeners stay live, and calling `load()` twice (tests,
re-init) accumulates global registrations. The task's "event subscription leak"
concern is real here.
**Fix:** keep the returned disposers per plugin, add `PluginLoader.dispose()` that
unsubscribes everything and disposes the buses, and make the global registries
load-scoped (or clearable).

### M5. `getPromptBlockAsync` has no in-flight dedup, contradicting its own docstring
**`src/plugins/loader.ts:1094-1104`**

The docstring promises "the second call ... awaits the same in-flight resolution," but
the implementation only memoizes the *result* (`asyncBlockCache`). Two concurrent
callers before the cache is set both run `resolveFragments()` (each starting its own
per-fragment timeout timers in 1128-1136) and both `buildBlock`. Because a fragment can
resolve-vs-timeout differently between the two races, the two assembles can diverge,
and the last writer wins — risky given the comment that this block sits on a
prompt-cache breakpoint and must be byte-stable.
**Fix:** memoize the in-flight `Promise<string|null>` itself (set `asyncBlockCache` to
the promise, await it), so all callers share one resolution.

### M6. Inconsistent manifest validation: several parsers don't reject unknown keys
**`src/plugins/manifest.ts:554-632` (parseMode), `:249-281` (parseCommand), `:783-843` (parseHandler), `:845-910` (parseTrigger/tool)**

`parseLiveAreaSlot` (360), `parsePromptFragment` (412), `parseHookSub` (471),
`parseEventSub` (530), `parseModeStyle` (680), and `parseSurfaceStyle` (708) all
reject unknown keys so typos surface early — good. But `parseMode`, `parseCommand`,
`parseHandler`, and the `tool` trigger object do not, so a typo'd `disallowedTool`,
`agrHint`, or `inpuit_schema` is silently dropped. (The top-level `parseManifest`
can't easily reject unknowns because `replayRenderers`/`turnAttachments` are
intentionally read from raw later — worth a comment, but the per-entry parsers have no
such excuse.)
**Fix:** add the same `for (const k of Object.keys(obj))` unknown-key guard to the four
inconsistent parsers.

### M7. Six near-identical "import module + validate default export" resolvers
**`helpers.ts:178-213` (resolveHandler), `event-subs.ts:59-89` (resolveEventSub), `:197-230` (resolveHookSub), `:527-568` (resolveCommand), `:373-430` (resolveLiveAreaSlot), `fragments.ts:116-144` (runFragment)**

Each repeats: `resolvePath` → `existsSync` check + log → `await import` in try/catch +
log → `typeof mod.default !== "function"` check + log → wrap `invoke`. This is the
clearest duplication in the subsystem. A single
`resolveModuleDefault<T>(packageDir, relPath, logger): Promise<T | null>` (plus a small
`resolveExecutable` for the subprocess arm) would collapse all six and keep the
error/log policy in one place.
**Fix:** extract a shared module-resolver helper; have each resolver call it and add
only its own context wrapping.

### M8. Duplicated plugin-context/env construction (no Factory/Builder)
**`src/plugins/loader.ts:885-925,1351-1372`; `event-subs.ts:124-167,252-284`; `fragments.ts:109-141`; `setups.ts:78-90`**

The "`{ ...process.env, TUI_PLUGIN_PROTOCOL, MINIMAL_AGENT_PALETTE, ...agentContextToEnv(agent) }`"
env block and the shape-aware `emit` closure are copy-pasted across dispatch,
dispatchCommand, event subs, hook subs, fragments, and setups. Besides DRY, this is why
H1 (env leak) has to be fixed in six places.
**Fix:** a `buildPluginEnv(agent)` and a `buildShapeAwareEmit(eventBus, hooks, label)`
factory used by all six sites (a small Facade over the two buses).

### M9. System-prompt section body is not fenced; a plugin can forge sibling `<ma::sys::*>` blocks
**`src/plugins/loader.ts:1224-1229`**

`buildBlock` escapes only the section `name` attribute (via `escapeTagAttr`) and emits
the raw `PROMPT.md` body inside `<ma::sys::ROLE name="...">…</ma::sys::ROLE>`. The
`<ma::sys::*>` namespace is documented as authoritative, host-authored, read-only
instructions to the model. Because the body is unescaped, a plugin whose `PROMPT.md`
contains `</ma::sys::tool>\n<ma::sys::mode name="ask">…` can close its own wrapper and
inject forged host sections (a fake mode, behavior mandate, etc.) that the model treats
as first-class agent instructions, with a role/name the classifier never assigned.
Plugins are semi-trusted, but this defeats the role attribution the wrapper is supposed
to provide.
**Fix:** detect/escape `</ma::sys::` (and stray `<ma::sys::`) sequences in the body, or
wrap bodies in a fence the composer controls, so a plugin can't emit sibling host
sections.

### M10. God modules: `loader.ts` (1465 lines) and `manifest.ts` (955 lines)
**`src/plugins/loader.ts:436-805` (the `load` method), `src/plugins/manifest.ts` (whole)**

Despite the good extraction into `loader/*`, `PluginLoader` still owns discovery
orchestration, collision resolution, index building, dispatch, prompt assembly,
fragment racing, command dispatch, setup running, and host caching. The static `load`
method alone is ~370 lines and the collision/resolution loop (505-724) is a single
200-line block. `manifest.ts` is one flat file of hand-rolled validators. Cohesion is
low (SRP).
**Fix:** pull the collision/index pass into a `PluginRegistry`/`PluginResolver` class
and the prompt assembly into a `PromptComposer`; consider splitting `manifest.ts` per
section. Not urgent, but it's the main maintainability drag.

### M11. `err` helpers are typed `=> void` instead of `=> never`, forcing unsafe casts
**`src/plugins/manifest.ts:70-72,256-258,...` and `requireString` `:946-955`**

Every parser's `err(msg)` throws but is typed `(msg: string) => void`, so TypeScript
can't treat the line after `err(...)` as unreachable and can't narrow. That's why the
file is full of `obj.x as string` / `raw as Record<string, unknown>` casts right after
a validation call — the casts paper over a narrowing the compiler would do for free if
`err` returned `never`. `requireString` has the same issue (it calls `err` then returns
`obj[key] as string`).
**Fix:** type the throwing helpers as `(msg: string) => never`; many of the `as` casts
in the file then become unnecessary, tightening type safety at the trust boundary.

---

## LOW

### L1. `plugin-sdk.ts` is a dead parallel experiment full of `any`/`Function`
**`src/plugins/v2/plugin-sdk.ts:14-21`, `src/plugins/v2/bash-tool-plugin.ts:13-16`**

`logger: any`, `registerTool(t: any)`, `registerHook(e: string, h: Function)`,
`execute: async (input: any)`. The `host-capabilities.ts` header itself notes plugin-sdk
is "a separate, older `activate()/registerTool()` experiment and is unrelated." Dead,
weakly-typed code in the same `v2/` dir invites someone to wire it and punch an `any`
hole through the boundary. `bash-tool-plugin.ts` is its only consumer and runs an
arbitrary shell command with `input: any`.
**Fix:** delete both, or move them out of `v2/` and mark clearly deprecated; replace
`any`/`Function` with real types if kept.

### L2. `agentContextFromEnv` accepts `pid: 0`, which `createAgentContext` rejects
**`src/plugins/agent-context.ts:189-194` vs `:97-100`**

The factory throws on `pid <= 0`; the env rehydrator falls back to `0`. The documented
"round-trips to a structurally equal value" only holds for valid input, and a
subprocess plugin can observe an `agent.pid` of `0` that the constructor would never
produce.
**Fix:** either reject/normalize `pid: 0` consistently or document the asymmetry on
`agentContextFromEnv`.

### L3. Stream subscriber's `next()` resolver is overwritten if called twice before a push
**`src/plugins/hooks/hook-bus.ts:242-244`**

In `openStream`, the iterator's `next()` stores `sub.resolveNext = res` when the queue
is empty. A consumer that calls `next()` twice before any `push` overwrites the first
resolver, so that first promise never settles (hang). A standard `for await` won't
trigger it, but it's a latent footgun for any manual consumer.
**Fix:** queue pending resolvers (array) instead of a single slot, or reject/throw on
concurrent `next()`.

---

## NIT

- **N1.** `isToolAvailable` fails open (keeps the tool visible) when a plugin's
  `available` predicate throws (`loader.ts:1005-1016`). Documented as intentional, but
  a throwing gate silently advertising a tool is worth a second look for least-privilege.
- **N2.** Unterminated inline-tag captures are flushed verbatim with no tag event, so a
  plugin side effect is silently skipped (`scanner.ts:139` docstring). Acceptable and
  documented; consider a diagnostic when a capture hits `maxSpanBytes`/EOF mid-span so
  authors notice.
- **N3.** Free-form manifest strings (`name`, `description`, mode `label`/`statusLabel`,
  tool `description`) are unsanitized (`manifest.ts:80-83,572-587,857`); tool
  `description` reaches the model API verbatim. Low risk for semi-trusted plugins, but
  worth a control-char/length guard.

---

## Test-coverage gaps (risky logic worth covering)

- **`sid` path-traversal (C1):** add tests asserting `blobs.read("../x", ...)` and
  `sessions.window("../../x", ...)` return `null`/empty rather than touching files
  outside the sessions dir.
- **`dispatch` timer cleanup (M1):** assert no pending timer remains after a dispatch
  resolves (and that a slow handler is actually aborted at `timeoutMs`).
- **Event/live-area subprocess hang + flood (M2/M3):** a handler that never closes
  stdout, and one that emits >cap bytes.
- **`getPromptBlockAsync` concurrency (M5):** two concurrent calls must return the same
  block and not double-run fragment producers.
- **System-prompt section breakout (M9):** a `PROMPT.md` containing `</ma::sys::...>`
  must not be able to emit a sibling host section.
