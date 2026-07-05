# Audit: The AgentCore boundary — what belongs in the core, what stays in the host

Date: 2026-07-05
Author: Elizabeth (session b24cee2f)
Status: AUDIT / discussion doc. No code changes proposed here beyond classification.
Related: `docs/phase5-agentcore-wire-in.md` (the tactical `--json` wire-in plan),
`src/sdk/agent-core.ts`, `src/sdk/ports.ts`, `src/agent/agent.ts`.

## Why this doc exists

Two agent loops exist side by side:

- **`src/agent/agent.ts`** (~1767 lines) — the real product loop. Fully wired to
  the TUI/CLI: status bus, live-area repaint, formatter subprocess, plugins,
  modes, session store, preflight, model-picker. Every actual run uses it. It is
  NOT junk; it is the *coupled, feature-complete* loop. "Legacy" here means
  "predates the port extraction", not "crufty".
- **`src/sdk/agent-core.ts`** (~767 lines) — the same loop with every host
  dependency replaced by a port (`src/sdk/ports.ts`). It already emits the full
  structured `AgentEvent` stream. It runs **only in tests today**.

The open question, raised by Gaston: **not everything should collapse into
AgentCore.** Some behavior (keyboard handling is the clearest case) is
platform-specific and has no business in a platform-agnostic core. The boundary
is a spectrum, not a black-and-white "move it all in". This doc classifies each
coupling and proposes where the line should sit.

## The guiding principle

> AgentCore owns the **conversation**: the agentic loop, message history, tool
> orchestration, prompt assembly, provider dispatch, and the *semantic* event
> stream that describes what happened. It must run unchanged on a CLI, a web
> server, a test harness, or an SDK embed.
>
> The host owns **presentation and interaction**: how bytes hit a terminal, how
> keys are read, how a status bar is painted, how a subprocess formatter is
> spun. These differ per platform and must never leak into the core.

The test for "does X belong in the core?" is a single question:

**Would X still make sense if the agent ran headless on a server with no
terminal, no keyboard, and no human watching?**

- Yes → core (or a core-level port the host implements).
- No → host, full stop. It never enters AgentCore.

## Three tiers, not two

Gaston's instinct is right: two layers ("core" vs "TUI") is too coarse. There
are three.

### Tier 1 — `AgentCore` (platform-agnostic conversation engine)

Runs identically everywhere. Depends only on `src/sdk/*`, `src/llm/*`, and
neutral core modules. Emits `AgentEvent`s. Never imports a terminal, a keyboard,
`process.stdout`, or a UI type.

Owns: message history; the send/tool loop; prompt assembly (system prompt +
per-turn attachments); provider dispatch via the transport port; tool
orchestration (which tool, in what order, join results back); reflection cadence
*logic*; max-tokens continuation *logic*; the semantic event stream; session
persistence *through a port*.

### Tier 2 — an interactive host layer (call it `InteractiveSession` / host loop)

The shared-across-interactive-frontends layer. A TUI CLI and a future web UI both
need this, but a headless `--json` script and an SDK embed do not. It consumes
AgentCore's event stream and adds interaction: an editor/input source, an abort
control, a queue of pending user input, a status/activity feed, a model-picker,
mid-turn cooldown-skip. It is platform-*family*-agnostic (works for any
interactive frontend) but NOT headless-agnostic.

This is the tier that does not exist yet as a named seam. Today its
responsibilities are *fused into `agent.ts`*. Gaston's "AgentInteractiveCore or
whatever" is exactly this tier.

### Tier 3 — the concrete frontend (TUI, web, …)

The actual terminal: `Compositor`, `EditorController`, `RawInput`, ANSI styling,
the mdstream formatter subprocess, keyboard byte decoding, DECSTBM scroll
regions. A web frontend would replace ALL of tier 3 with DOM/websocket code and
reuse tiers 1-2. Keyboard handling lives here and ONLY here — Gaston is correct
that AgentCore has no business decoding keystrokes.

## The coupling inventory

Every host touch-point currently inside `agent.ts` (and its extracted siblings
`tool-round.ts`, `repl.ts`, `repl-live-area.ts`), classified by tier and by
whether a port already exists.

| # | Coupling in `agent.ts` today | Belongs in tier | Port exists? | Verdict |
| - | --- | --- | --- | --- |
| 1 | Message history, send loop | 1 Core | n/a (is the core) | already in AgentCore |
| 2 | Tool orchestration (order, join, results) | 1 Core | `ToolRegistry`/`ToolExecutor` | port exists; adapter net-new (the hard one) |
| 3 | Prompt assembly (system + attachments) | 1 Core | `PromptContributor` | port exists; adapter net-new |
| 4 | Provider/transport dispatch | 1 Core | `TransportFn` | port exists, pass-through |
| 5 | Session persistence | 1 Core (via port) | `SessionPersistence` | port exists; adapter net-new |
| 6 | Media resolution (inline `@file`) | 1 Core (via port) | `MediaResolver` | port exists; adapter net-new |
| 7 | Reflection cadence + max-tokens continuation | 1 Core | n/a (pure logic) | already in AgentCore |
| 8 | Semantic event stream | 1 Core | `EventSink` | already in AgentCore |
| 9 | **Plugins** (tools, prompt fragments, modes, live-area slots) | **split, see below** | partial | **the interesting case** |
| 10 | Mode gating (`ModeManager`) | 1 Core logic + 2 interaction | `ModeProvider` | port exists; adapter net-new |
| 11 | Status/activity bus (`GLOBAL_STATUS_BUS`) | 2 Interactive (emit) + 3 render | NO port | net-new port; see below |
| 12 | Reflection **cooldown** (the wall-clock pause + Esc-to-skip) | 2 Interactive | partial (`AbortSignalProvider`) | needs an interaction port |
| 13 | Keyboard / `inputCaptureStack` | **3 Frontend ONLY** | NO — and must NOT get one in core | never enters AgentCore |
| 14 | Formatter subprocess (mdstream) block boundaries | 3 Frontend | `onTextStop` hook exists | frontend concern; core emits the boundary event |
| 15 | Live-area repaint / `Compositor.writeStream` | 3 Frontend | `TranscriptSink` (partial) | frontend concern behind the sink |
| 16 | ANSI styling (`c`, `faintThinkingChunk`) | 3 Frontend | n/a | never in core; core emits plain text/events |
| 17 | Model-picker modal | 2 Interactive | NO port | net-new interaction port |
| 18 | Preflight pipeline (`askUser`) | 1 Core logic + 2 interaction | `AskUserFn` (exists) | logic in core, prompt UI in tier 2/3 |
| 19 | `toolTimeTracker` (cosmetic header time-hint) | 3 Frontend | injected value | cosmetic; drop in headless |

### The clear-cut ones

- **Keyboard handling (#13): tier 3 only.** AgentCore must never see a keystroke.
  What the core CAN see is the *result* of a keystroke expressed as a neutral
  signal: an `AbortSignal` (Esc → abort), or a "user queued more input" string
  through a port. The byte `0x1b` and the `inputCaptureStack` dispatch pipeline
  stay entirely in the frontend. This is the sharpest line in the whole system
  and Gaston named it correctly.
- **ANSI styling, compositor repaint, formatter subprocess (#14-16): tier 3.**
  The core emits `text_delta` / `item_completed` events carrying *plain* text.
  Whether that becomes a green-highlighted markdown render through an mdstream
  child process, or a `<span>` in a browser, or a raw log line, is 100% frontend.

### The spectrum ones (Gaston's real question)

- **Status/activity bus (#11).** This is the "is this too TUI-coupled?" case, and
  the answer is *it's already been split correctly at the bus level, but the
  emission is in the wrong tier.* `src/bus/status.ts` is deliberately
  UI-agnostic: it carries phases (`connect`, `stream`, `thinking`, `tool-run`,
  …) and stores an **"opaque renderer-owned theme payload without importing
  UI/spinner types."** That is a well-designed seam. The problem is only that
  `agent.ts` reaches for the `GLOBAL_STATUS_BUS` *singleton* directly. The fix is
  not "delete status from the core"; it is "the core emits activity as part of
  its semantic event stream (or through a narrow `ActivitySink` port), and tier 2
  translates those into status-bus publishes." A headless run passes no
  `ActivitySink` and the code path is inert. So: **status is a spectrum item —
  the *signal* ("I am now streaming tokens from the model") is a core-level fact;
  the *rendering* (a spinner with a theme) is tier 3.** Split it at the signal.
- **Reflection cooldown (#12).** The *decision* "inject a checkpoint every N
  rounds" is pure core logic (already in AgentCore). The *60-second wall-clock
  pause a human can skip with Esc* is interaction — it only makes sense with a
  human watching. Today they are fused (`runReflectionCooldown` takes
  `statusBus` + `inputCaptureStack`). Split: core decides *when* a checkpoint is
  due and emits a `reflection_checkpoint_due` event; tier 2 owns the pause + the
  skip affordance. Headless runs skip the pause entirely (nothing to interrupt).
- **Preflight / model-picker (#17-18).** The *policy* (a thinking-model mismatch
  needs resolution) is core; the *modal UI* that asks the human is tier 2/3. The
  `askUser` callback port already models this correctly — it is a function the
  host supplies. Keep that shape.

## Plugins: should AgentCore own them? (Gaston's explicit question)

**Is AgentCore handling plugins today?** No. The legacy `Agent` takes a
`PluginLoader` directly (`agent.ts:205 private loader: PluginLoader | null`).
`AgentCore` takes NO loader — it takes the *products* of a loader through ports:
`ToolRegistry` (the tool list), `ToolExecutor` (dispatch), `PromptContributor[]`
(prompt fragments / attachments), `ModeProvider` (modes). The `PluginLoader`
class itself never enters `src/sdk/`.

**Should it?** No — and this is the correct design, keep it. Here is the
distinction that resolves it:

- **The plugin SYSTEM (discovery, loading, the `PluginLoader`, manifest parsing,
  sibling-repo resolution, binary provisioning) is a HOST concern.** It reads the
  filesystem, clones repos, spawns setup — all platform I/O. It belongs in tier 2
  (the host), never in AgentCore.
- **What plugins CONTRIBUTE (tools, prompt text, modes, per-turn attachments) is
  a CORE concern, but expressed through ports.** AgentCore must be able to run
  with plugin-contributed tools without knowing what a "plugin" is. It sees a
  `ToolRegistry`, not a `PluginLoader`.

So the answer is: **AgentCore consumes plugin *outputs* through narrow ports; it
does not own the plugin *machinery*.** The host loads plugins, then hands their
contributions to the core as `ToolRegistry` / `ToolExecutor` /
`PromptContributor[]`. This is already the port design in `ports.ts` — it just
isn't *wired* yet (the adapters are net-new, per the phase-5 plan). Pulling
`PluginLoader` into the core would drag filesystem discovery, git cloning, and
binary provisioning into a "platform-agnostic" engine — the exact coupling we are
trying to remove. Do not do it.

One nuance: **live-area slots** (the quota footer, etc.) are a plugin
contribution that is purely tier-3 presentation. Those never reach AgentCore at
all; they are consumed by the frontend directly. Only tools / prompt / modes /
turn-attachments cross into the core.

## The proposed target architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Tier 3: Frontends (swappable)                                │
│  TUI: Compositor, EditorController, RawInput, ANSI, mdstream │
│  Web (future): DOM, websocket, browser input                 │
│  — keyboard, styling, repaint, formatter subprocess live here│
└───────────────▲─────────────────────────────────────────────┘
                │ neutral signals up (abort, queued text)
                │ events + plain text down
┌───────────────┴─────────────────────────────────────────────┐
│ Tier 2: InteractiveSession (host, shared by all frontends)   │
│  editor loop, abort control, input queue, status translation,│
│  model-picker, reflection-cooldown pause, plugin LOADING     │
│  — consumes AgentCore's event stream; supplies ports down    │
└───────────────▲─────────────────────────────────────────────┘
                │ ports (ToolRegistry, ToolExecutor,            │
                │ PromptContributor, SessionPersistence,        │
                │ ModeProvider, EventSink, AskUserFn, …)        │
┌───────────────┴─────────────────────────────────────────────┐
│ Tier 1: AgentCore (platform-agnostic)                        │
│  history, send/tool loop, prompt assembly, provider dispatch,│
│  reflection/max-token LOGIC, semantic AgentEvent stream      │
│  — no process, no terminal, no keyboard, no UI type          │
└──────────────────────────────────────────────────────────────┘

Headless (--json / SDK): Tier 1 + thin adapters, NO Tier 2/3.
```

## What's missing to get there (the gap list)

Ports that already exist and just need **adapters** (net-new host code, per
`phase5-agentcore-wire-in.md`): `ToolExecutor` (the hard one, over
`executeToolRound`), `ToolRegistry`, `PromptContributor`, `SessionPersistence`,
`ModeProvider`, `MediaResolver`.

Ports that **do not exist yet** and are needed for tier-2 convergence (NOT for
the headless `--json` path — that is why phase 5 can ship without them):

1. **`ActivitySink`** (or fold into the event stream) — for status/phase signals
   (#11). Core emits activity facts; tier 2 translates to `GLOBAL_STATUS_BUS`.
2. **`text_delta` / `thinking_delta` event variants** — for true realtime
   token-level `stream-json` (today AgentCore emits whole-block `item_completed`,
   not per-token deltas; the deltas exist one layer down as transport
   `CanonicalEvent`s and need forwarding up).
3. **An interaction port for the reflection cooldown pause** (#12) — the
   wall-clock + Esc-skip, so tier 2 owns it and headless skips it.
4. **A model-picker / interactive-resolution port** beyond `askUser` (#17), if we
   want the picker on the AgentCore path.

Couplings that must NEVER get a core port (stay tier 3): keyboard/`inputCaptureStack`
(#13), ANSI styling (#16), compositor repaint (#15), formatter subprocess (#14).

## Recommendation / sequencing

This aligns with, and extends, `phase5-agentcore-wire-in.md`:

1. **Phase 5 as already planned**: wire AgentCore into non-interactive `--json`
   only, with a `JsonlEventSink`. Builds the tier-1 adapter set (ToolExecutor
   first, behind a golden-parity test). Proves the core in production on the
   lowest-risk surface. **Ships `stream-json`'s foundation.** No tier-2 ports
   needed.
2. **Add `text_delta` / `thinking_delta`** to the event union and forward them
   from the transport. This is what upgrades `--json` from "final answer as one
   line" to true realtime `--output-format stream-json`. Pure addition.
3. **Extract tier 2 (`InteractiveSession`)** as a named seam: move the editor
   loop, abort, queue, status translation, model-picker, cooldown out of
   `agent.ts` into an explicit interactive-host layer that consumes the event
   stream. Add the `ActivitySink` + cooldown-interaction ports here.
4. **Cut the REPL over to AgentCore + tier 2 adapters**, deleting the duplicated
   loop in `agent.ts`. Highest blast radius, done last, behind everything above
   being green. This is where "not legacy anymore" is actually achieved.
5. **Delete the string-yield channel** once every host is a reducer over the
   event stream — events become the single output.

The key correction to a naive "collapse everything into AgentCore" plan:
**stop at the tier boundary.** Keyboard, styling, repaint, and the formatter
subprocess stay in tier 3 forever. Status is split at the signal (fact in core,
render in frontend). Plugins are loaded by the host and consumed by the core
through ports — the `PluginLoader` never moves inward. AgentCore stays a
conversation engine, not a UI framework.

## Open questions for Gaston

1. Name for tier 2: `InteractiveSession`? `AgentInteractiveCore`? `HostLoop`?
2. Should status/activity ride the *same* `AgentEvent` stream (one channel) or a
   separate `ActivitySink` (two channels)? One channel is cleaner (event sourcing)
   but mixes semantic events with cosmetic activity; a separate sink keeps the
   `--json` contract free of spinner noise. Leaning: separate `ActivitySink`, so
   the `--json` event stream stays purely semantic.
3. Is a web frontend actually on the roadmap? If yes, tier 2 extraction (step 3)
   earns its keep immediately. If the CLI is the only frontend ever, steps 3-4
   are still worth it for testability but the urgency drops.
