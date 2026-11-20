/**
 * Single-tool execution round for the agent's agentic loop.
 *
 * Extracted from `src/agent.ts` (the body of its per-tool `for` loop) to keep
 * that file under the `max-lines` lint budget. {@link executeToolRound} owns
 * everything that happens between "the model asked for tool X" and "the
 * tool_result block is ready to send back": the mode dispatch gate, the
 * built-in `Mode` tool, plugin dispatch, built-in execution with live Bash
 * output, the tool view events (no rows: a host builds those), the
 * `tool.didInvoke` plugin chain, blob-store capture, the TUI-elision and
 * active-mode annotations, and JSONL persistence of the result.
 *
 * Deliberately closure-free: every collaborator the original loop body pulled
 * from `Agent`'s fields or the `run()` scope arrives through
 * {@link ToolRoundContext}, so this module never reaches back into the class.
 * The agent calls it once per `tool_use` block and pushes the returned
 * `tool_result` onto the outgoing user message.
 *
 * @module loops/tool-round
 */

import type {
  HostHints,
  ToolAnnotation,
  ToolOutcome,
} from "../../plugin-api/src/types/tool-outcome.ts"
import type { ToolResultPhase } from "../../plugin-api/src/types/tool-result-chain.ts"
import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type {
  PluginToolView,
  ToolViewEvent,
  ToolViewOutcome,
  ToolViewPort,
} from "../agent/tool-view-port.ts"
import type { StructuredData } from "../bus/diagnostic-bus.ts"
import { NOOP_STATUS_PORT, type StatusPort } from "../bus/status-port.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import { resolveToolMediaContext } from "../media/tool-context.ts"
import type { ModeManager } from "../modes/modes.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import { cleanHookContext } from "../sdk/hook-context.ts"
import {
  collectAdditionalContext,
  isDenied,
  type LifecyclePort,
  NOOP_LIFECYCLE,
  type ToolDidInvokeResult,
} from "../sdk/lifecycle.ts"
import { PolicyHookFailedError } from "../sdk/policy-hook-failed.ts"
import type { ToolCallGates } from "../sdk/ports.ts"
import type { ToolEnvPort } from "../sdk/tool-env.ts"
import { type Finding, makeToolDidInvokePayload } from "../sdk/tool-lifecycle.ts"
import { attachPersistedOutcome } from "../sdk/tool-outcome-record.ts"
import type { BlobStore, BlobWriteResult } from "../session/blob-store.ts"
import type { FileTrackingStore } from "../session/file-tracking-store.ts"
import type { SessionStore } from "../session/session-store.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import type { ReadonlySidebandRegistry, SidebandApi } from "../sideband/types.ts"
import {
  classifyBinaryText,
  formatBinaryOptInContent,
  formatBinaryResultMessage,
  isBinaryOptIn,
} from "../tools/binary-guard.ts"
import { scrubEmbeddedPayloads } from "../tools/embedded-payload-scrub.ts"
import type { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"
import { normalizeToolInput, validateToolInput } from "../tools/tool-input.ts"
import {
  abortedText,
  nonToolResultText,
  policyDeniedText,
  policyHookFailedText,
  policyRewriteNoteText,
} from "../tools/tool-result-text.ts"
import {
  executeTool,
  toolStreamsOutput as streamsOutput,
  type ToolResultMediaBlock,
} from "../tools/tools.ts"
import { truncateToolOutputParts } from "../tools/truncation-parts.ts"

import { type ToolHookFacts, toolHookFacts } from "./tool-hook-facts.ts"
import {
  appendAnnotations,
  cancelWhenEmpty,
  diagnosticsAnnotation,
  modeActiveAnnotation,
  outputPreviewAnnotation,
  outputStreakAnnotation,
  outputTruncatedAnnotation,
  policyAnnotations,
  rawOutputAnnotation,
  replaceBodyClearAnnotations,
} from "./tool-outcome-annotations.ts"
import { finalizeOutcome, joinOutcome } from "./tool-outcome-finalize.ts"
import { liftBuiltIn, liftClamped, liftText } from "./tool-outcome-lift.ts"
import type { TextRenderer, ToolResultChainEntry } from "./tool-result-chain.ts"
import { hasChainPhase, runChainPhase, sidebandMark } from "./tool-result-chain-glue.ts"

/**
 * Everything {@link executeToolRound} needs from the agent. The original
 * loop body captured these via closure over `Agent` fields and `run()`
 * locals; the explicit bag keeps the extraction compile-safe and the module
 * free of any dependency on the `Agent` class itself.
 */
export interface ToolRoundContext {
  /**
   * Host view of the tool call (spec S24). The round emits plain events
   * here. Omitted or `null`: no events (headless hosts).
   */
  toolView?: ToolViewPort | null
  /** Plugin loader for plugin-tool dispatch + the didInvoke hook chain. */
  loader: PluginLoader | null
  /** Mode manager for the dispatch gate, `Mode` tool, and mode stamps. */
  modeManager: ModeManager | null
  /** Per-session raw-output blob store (null disables blob capture). */
  blobStore: BlobStore | null
  /** Tools whose output is excluded from clamping + blob persistence. */
  blobSkipTools: ReadonlySet<string>
  /** Streak tracker behind the consecutive-truncation `[note: …]` hint. */
  feedbackTracker: ToolFeedbackTracker
  /** Active model id, used to resolve media (vision) capabilities. */
  model: string
  /** Append-only session store for tool_result persistence (optional). */
  store: SessionStore | null
  /** Durable per-session file observations for Read/Edit/Write safety. */
  fileTrackingStore?: FileTrackingStore
  /** Per-turn cancellation signal forwarded into tool execution. */
  signal?: AbortSignal | undefined
  /**
   * Lifecycle / policy port (beforeTool / afterTool). Defaults to
   * {@link NOOP_LIFECYCLE}. Hosts wire a HookBus adapter so plugin
   * `tool.willInvoke` listeners can deny or rewrite input.
   */
  lifecycle?: LifecyclePort
  /** Optional agent id when this round runs inside a sub-agent worker. */
  agentId?: string
  /** Lead session id when `agentId` is set. */
  leadSid?: string
  /** Session id for the tool hook payloads (from the core `sessionFacts`). */
  sid?: string
  /**
   * Env values for a spawned tool (spec S24). Forwarded to
   * {@link executeTool} unchanged. This module never reads `process.stdout`.
   */
  toolEnv?: ToolEnvPort
  /**
   * Live status port (spec S23) for the `running_tool` row. Defaults to
   * {@link NOOP_STATUS_PORT}. This module never writes a module status bus.
   */
  statusPort?: StatusPort
  /**
   * Tool-result transform chain (spec R-API-3), built by the plugin loader
   * and passed by assemble. Omitted: empty, the round runs only its inline
   * code.
   */
  toolResultChain?: readonly ToolResultChainEntry[]
  /** Sideband registry for the `kind` check of the stamp phase. */
  sidebandRegistry?: Pick<ReadonlySidebandRegistry, "kind">
  /** Text codec for owner rule 5. Omitted: a registered-kind plugin annotation is dropped. */
  sideband?: TextRenderer
  /**
   * The one sideband API of the session (design step 5). Core code of the
   * round that emits or reads a tag uses this, not a global. Omitted: a
   * caller with no loader (`NO_SIDEBAND` semantics). The core annotation
   * tags of the round (`diagnostics`, `raw-output`, `policy`) render here.
   */
  sidebandApi?: SidebandApi
  /**
   * Injected diagnostics handle (S20). The round also passes it to the chain
   * runner, which emits `tool-result-chain.stage-failed` when a stage fails.
   * Omitted: neither the drop diagnostic nor the stage-failed diagnostic is
   * emitted, and the chain still fails open.
   */
  diagnostics?: Diagnostics
  /**
   * Synthetic text resolver (G3) for the result texts of this round. The
   * core passes its one resolver. Omitted: no provider, so every text is
   * "" (bare core).
   */
  text?: SyntheticTextResolver
  /**
   * The scheduler gates of this tool call (only in a batch with a wave).
   * The round calls `admitted` after admission and `ran` when the run
   * ends. The steps after `ran` (result chain, `tool.didInvoke`, blob
   * write, the `outcome` view event) run one call at a time in end order.
   * Then `inCallOrder` waits for the earlier calls: the mode stamp and the
   * save run in call order. Omitted: the round runs as one piece, as before.
   */
  gates?: ToolCallGates
  /**
   * True when the scheduler runs this call in a wave of 2 or more calls.
   * The `started` view event carries `concurrent: true` only when the call
   * also passed the per-input check. Omitted: the call runs alone.
   */
  concurrent?: boolean
  /**
   * Test seam. Default: the real {@link executeTool}. Not for hosts.
   * @internal
   */
  executeTool?: typeof executeTool
}

/**
 * Convert a canonical media block (currently an image) returned by a
 * media-aware tool into the legacy wire {@link ContentBlock} the agent's
 * message history speaks. Kept tiny + local so the agent doesn't reach into the
 * adapter's private encoders; the canonical→wire image source mapping is the
 * same trichotomy (`base64`/`url`/`file_id`→`file`) the adapter uses.
 */
function mediaBlockToLegacy(block: ToolResultMediaBlock): ContentBlock {
  const src = block.source
  switch (src.kind) {
    case "base64":
      return {
        type: "image",
        source: { type: "base64", media_type: src.mediaType, data: src.data },
      }
    case "url":
      return { type: "image", source: { type: "url", url: src.url } }
    case "file_id":
      return { type: "image", source: { type: "file", file_id: src.fileId } }
    default:
      throw new Error(`unhandled media source: ${JSON.stringify(src satisfies never)}`)
  }
}

/**
 * Fire the `tool.didInvoke` chain so plugins can augment a just-finished
 * tool result, then split the union into host-facing and model-facing
 * forms. Returns `null` when there's no loader, no subscriber, or the
 * plugins added nothing (the common, zero-cost path).
 *
 * - `findings`: the plugins' structured findings, for the host view.
 * - `notes` and `scope`: the plugins' model-facing notes and the scope of
 *   the first finding that has one. The round makes the `diagnostics`
 *   annotation from them (`diagnosticsAnnotation`).
 * - `context`: the clean `additionalContext` lines for the policy fold.
 *
 * This is the ONLY agent-side coupling to the diagnostics feature, and even
 * it is generic: the agent knows about `findings`/`notes`, not about LSP,
 * linters, or formatters. All failure modes are contained by the HookBus.
 */
async function runToolDidInvokeChain(
  lifecycle: LifecyclePort,
  toolName: string,
  execInput: Record<string, unknown>,
  isError: boolean | undefined,
  facts: ToolHookFacts,
): Promise<{
  findings: Finding[]
  notes: string[]
  scope: string | undefined
  context: string[]
} | null> {
  const filePath = typeof execInput.file_path === "string" ? execInput.file_path : undefined
  const payload = makeToolDidInvokePayload({
    tool: toolName,
    input: execInput,
    cwd: process.cwd(),
    ok: !isError,
    ...(filePath !== undefined ? { filePath } : {}),
    ...facts,
  })

  let result: ToolDidInvokeResult
  try {
    result = lifecycle.afterTool ? await lifecycle.afterTool(payload) : payload
  } catch {
    return null
  }

  const findings: Finding[] = Array.isArray(result.findings) ? result.findings : []
  const notes: string[] = Array.isArray(result.notes) ? result.notes : []
  const context = cleanHookContext(result.additionalContext)
  if (findings.length === 0 && notes.length === 0) {
    return context.length > 0 ? { findings, notes: [], scope: undefined, context } : null
  }

  return { findings, notes, scope: findings.find((f) => f.scope)?.scope, context }
}

/**
 * Sorted key names whose value differs between two tool inputs (added,
 * removed, or changed). Used for the policy-rewrite note: key names only,
 * values never leave this function.
 */
function changedInputKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  const changed: string[] = []
  for (const key of keys) {
    // A throw while comparing (exotic values) counts as "changed": the
    // diff must never break the tool round.
    let same: boolean
    try {
      const inBefore = before != null && Object.hasOwn(before, key)
      const inAfter = after != null && Object.hasOwn(after, key)
      same = inBefore === inAfter && deepEqual(before?.[key], after?.[key])
    } catch {
      same = false
    }
    if (!same) changed.push(key)
  }
  return changed.sort()
}

/**
 * Structural equality, insensitive to object key order. Cycle-safe: a
 * pair already on the compare stack counts as equal.
 */
function deepEqual(a: unknown, b: unknown, seen: [object, object][] = []): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (seen.some(([x, y]) => x === a && y === b)) return true
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length) return false
  const next: [object, object][] = [...seen, [a, b]]
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i] as string
    if (k !== kb[i]) return false
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], next)) {
      return false
    }
  }
  return true
}

/**
 * Deep copy of a tool input so no handler can reach history through a
 * nested reference. Falls back to a JSON round trip, then to a shallow
 * copy, when the value cannot be cloned.
 */
function cloneToolInput<T>(input: T): T {
  if (input === null || typeof input !== "object") return input
  try {
    return structuredClone(input)
  } catch {
    try {
      return JSON.parse(JSON.stringify(input)) as T
    } catch {
      // Shallow copy: nested objects stay shared, so the no-mutation
      // guarantee is lost here. Reachable only for inputs with a function
      // or a cycle that JSON cannot encode, never for model JSON.
      return (Array.isArray(input) ? [...input] : { ...input }) as T
    }
  }
}

const POLICY_KEY_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const POLICY_KEY_CAP = 16

/**
 * Key names for the policy note. Hook keys are untrusted text inside a
 * tag, so keep only safe names, cap the list, and count the rest.
 */
function policyKeyFacts(keys: string[]): { keys: string; dropped: number } {
  const shown = keys.filter((k) => POLICY_KEY_NAME.test(k)).slice(0, POLICY_KEY_CAP)
  return { keys: shown.join(", "), dropped: keys.length - shown.length }
}

/** Emit observation-only permission-checked (best-effort). */
function emitPermissionChecked(
  loader: PluginLoader | null,
  tool: string,
  allowed: boolean,
  reason?: string,
): void {
  if (!loader || typeof loader.hooks !== "function") return
  try {
    loader.hooks().emitAsync("tool.permissionChecked", {
      tool,
      allowed,
      ...(reason !== undefined ? { reason } : {}),
    })
  } catch {
    /* catalog/shape — ignore */
  }
}

/**
 * Execute ONE `tool_use` block end-to-end and return the matching
 * `tool_result` block, ready to be pushed onto the next user message.
 *
 * Covers the full original per-tool pipeline: mode dispatch gate, the
 * built-in `Mode` tool, plugin dispatch (with universal output clamping),
 * built-in execution with live Bash streaming, transcript rendering, the
 * `tool.didInvoke` plugin chain, blob-store raw capture, the
 * `<ma::agent::output-preview>` and active-mode annotations, and JSONL
 * persistence (including presentation overrides for session replay).
 *
 * @param tool - The `tool_use` block the model emitted.
 * @param ctx - Collaborators threaded in from the agent (see
 *   {@link ToolRoundContext}).
 * @returns The `tool_result` block pairing `tool.id`.
 */
export async function executeToolRound(
  tool: ToolUseBlock,
  ctx: ToolRoundContext,
): Promise<ToolResultBlock> {
  // `sb`: the sideband API of the session. The core tags of this round render here.
  const { signal, sidebandApi: sb = NO_SIDEBAND } = ctx
  const view = ctx.toolView ?? null
  /** The tool block with the input the round runs with at this moment. */
  const viewTool = (): ToolUseBlock => ({ ...tool, input: execInput })
  /** Send one event to the host view. The view can never break the round. */
  const emit = async (event: ToolViewEvent): Promise<void> => {
    if (!view) return
    try {
      await view.onToolEvent(event)
    } catch {
      /* presentation only: ignore */
    }
  }

  /**
   * The wire `is_error` (lead decision Q5). A separate local: it is
   * `undefined` when the tool gave no flag and no chain phase ran, as
   * before. After a chain phase it is `o.isError`.
   */
  let isError: boolean | undefined
  /**
   * The tool result as a `ToolOutcome` (SPEC v6.1 D2-D6). Each path below
   * lifts the handler result into it. The round then appends the core
   * annotations, runs the chain phases on it, and makes the model text
   * from it at one place (`finalizeOutcome`). One writer for each field
   * (lead decision D5): the lift, a chain phase, or the core step that
   * names the field.
   */
  let o: ToolOutcome = liftText("")
  /**
   * Outcome of the blob write, read after the if-refused/else-execute
   * structure for the JSONL record. `null` when no blob was written (store
   * disabled, body too small, tool on skip list, write failure, etc.).
   */
  let blobWrite: BlobWriteResult | null = null
  /** The resolver of the clamp, the lift and the core annotations. */
  const R = ctx.text ?? EMPTY_SYNTHETIC_TEXT
  /** The rule 4 drop keys of this round (one diagnostic per plugin and kind). */
  const droppedKinds = new Set<string>()
  // The scheduler gates (only in a batch with a wave). Each gate is called
  // at most one time. Without gates they are no-ops.
  const gates = ctx.gates
  const called = { admit: false, ran: false, inCallOrder: false }
  /** True when the call runs in the wave (it passed the per-input check). */
  const admit = async (input: Record<string, unknown> | null): Promise<boolean> => {
    if (!gates || called.admit) return false
    called.admit = true
    return (await gates.admitted(input)) === true
  }
  const ran = async (): Promise<void> => {
    if (!gates || called.ran) return
    called.ran = true
    await gates.ran()
  }
  const inCallOrder = async (): Promise<void> => {
    if (!gates || called.inCallOrder) return
    called.inCallOrder = true
    await gates.inCallOrder()
  }
  /**
   * The steps of the run that must run one call at a time with gates (the
   * clamp chain phase and the streak tracker). Without gates they run in
   * place, as before. With gates they run after {@link ran}, in end order.
   */
  let afterRun: (() => Promise<void>) | null = null
  const runAfterRun = async (steps: () => Promise<void>): Promise<void> => {
    if (gates) afterRun = steps
    else await steps()
  }

  /** Run one chain phase over `o`. No stage for it: nothing runs. */
  const chainPhase = async (phase: ToolResultPhase) => {
    const entries = ctx.toolResultChain
    if (entries === undefined || !hasChainPhase(entries, phase)) return undefined
    const r = await runChainPhase(
      phase,
      entries,
      o,
      { tool: tool.name, toolUseId: tool.id, input: execInput },
      {
        signal,
        diagnostics: ctx.diagnostics,
        sidebandRegistry: ctx.sidebandRegistry,
        sideband: ctx.sideband,
        droppedKinds,
      },
    )
    o = r.outcome
    isError = o.isError
    return r.stage
  }

  // Canonicalize documented built-in aliases (e.g. Cursor `path` ->
  // `file_path`) before mode/policy/hooks see the input. Custom and
  // plugin tools are left untouched. Validation rejects missing/
  // mistyped required fields before any filesystem side effect.
  //
  // The round runs on a local copy (`execInput`). `tool.input` is the
  // block already in history and on disk: it is never written, so
  // history keeps exactly what the model wrote and `--resume` sees the
  // same bytes as the live session.
  // Deep copy first: normalizeToolInput returns the same object for
  // custom and plugin tools, hooks get execInput by reference, and a
  // handler must not mutate history, not even a nested value.
  const modelInput = tool.input as Record<string, unknown>
  let execInput: Record<string, unknown> = normalizeToolInput(tool.name, cloneToolInput(modelInput))
  const prepError = validateToolInput(tool.name, execInput, ctx.text)

  // Mode dispatch gate. Tools stay registered in the request body
  // (so the cached prefix is mode-independent), but the harness
  // refuses to actually invoke a tool the active mode disallows.
  // The synthesized error tool_result teaches the model how to
  // adapt : see ManifestMode.refusalHint. No spinner, no execution
  // side effects.
  const lifecycle = ctx.lifecycle ?? NOOP_LIFECYCLE
  const gate = ctx.modeManager?.isToolAllowed(tool.name, execInput) ?? { allowed: true as const }
  // A refused tool is refused whatever its input: the mode or CLI gate
  // wins over input validation, so the model never gets field-level
  // advice for a tool it may not call. Allowed tools are still validated
  // before any filesystem side effect.
  emitPermissionChecked(
    ctx.loader,
    tool.name,
    gate.allowed && prepError === null,
    gate.allowed ? (prepError ?? undefined) : gate.message,
  )
  if (!gate.allowed) {
    o = liftText(gate.message, { isError: true })
    isError = true
    // Tell the host what got blocked. The host owns how a refusal looks.
    // Core supplies the message and the refusing mode's id.
    await emit({
      type: "refused",
      tool: viewTool(),
      message: gate.message,
      refusedBy: ctx.modeManager?.activeId() ?? "mode",
    })
  } else if (prepError !== null) {
    o = liftText(prepError, { isError: true })
    isError = true
    await emit({ type: "input_error", tool: viewTool(), message: prepError })
  } else if (tool.name === "Mode" && ctx.modeManager) {
    // Built-in `Mode` tool. Returns the live mode + effective
    // permissions as a small JSON blob. Intercepted here (not in
    // `executeTool`) because `tools.ts` does not (and should not)
    // import the agent's ModeManager.
    //
    // The result is small, deterministic, side-effect-free, and
    // doesn't need a spinner or the bash-streaming machinery. It
    // ships through the same `tool_result` shape as everything
    // else and picks up the trailing `<ma::agent::mode-active>` stamp
    // below.
    const mm = ctx.modeManager
    const active = mm.active()
    const since = mm.activeSince()
    const perms = active ? mm.effectivePermissions(active.id) : null
    const result = {
      id: active?.id ?? null,
      label: active?.label ?? null,
      since: since ? since.toISOString() : null,
      permissions: perms
        ? {
            tools: perms.tools.map((t) => {
              const entry: Record<string, unknown> = { tool: t.tool, allow: t.allow }
              if (t.refusalHint) entry.refusalHint = t.refusalHint
              return entry
            }),
            source: perms.source,
          }
        : { tools: [{ tool: "*", allow: true }], source: "default" },
    }
    // Text only in M1 (lead decision L3): no `body.data` before M4.
    o = liftText(JSON.stringify(result, null, 2), { isError: false })
    isError = false
    // The model gets the structured details. The host only needs the
    // label to show that the model checked.
    await emit({
      type: "mode",
      tool: viewTool(),
      label: active ? (active.label ?? active.id) : "default",
    })
  } else {
    // Lifecycle beforeTool (tool.willInvoke): deny or rewrite input.
    // Runs AFTER the hard mode/CLI gate; hooks cannot allow a refused tool.
    let policyDenied = false
    let lifecycleNotes: string[] = []
    const hookFacts = toolHookFacts(ctx.modeManager, ctx.sid)
    // With gates, get the run slot first: a call that passes tool.willInvoke
    // (an approval can ask a human) can then start at once. An abort while
    // the call waits rejects here, before any hook. This code runs one time.
    if (gates?.beforeAdmission) await gates.beforeAdmission()
    if (lifecycle.beforeTool) {
      // Snapshot before the hook: a listener can edit execInput in place
      // and return the same object, so the diff needs its own baseline.
      const preHookInput = cloneToolInput(execInput)
      try {
        const will = await lifecycle.beforeTool({
          tool: tool.name,
          toolUseId: tool.id,
          input: execInput,
          cwd: process.cwd(),
          ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
          ...(ctx.leadSid !== undefined ? { leadSid: ctx.leadSid } : {}),
          ...hookFacts,
        })
        lifecycleNotes = collectAdditionalContext(will)
        if (isDenied(will)) {
          policyDenied = true
          const message =
            will.action === "deny" || will.action === "ask"
              ? will.reason.trim() || policyDeniedText(ctx.text, "tool.willInvoke")
              : policyDeniedText(ctx.text, "tool.willInvoke")
          o = liftText(message, { isError: true })
          isError = true
          await emit({ type: "refused", tool: viewTool(), message, refusedBy: "policy" })
        } else if (will.action === "allow") {
          // updatedInput: replace the local execInput (never tool.input)
          // so dispatch and executeTool see the rewritten args. Re-normalize
          // aliases and re-validate so a rewrite cannot bypass the input
          // contract. Tell the model which keys changed, never the values.
          const rewritten = normalizeToolInput(
            tool.name,
            will.payload.input as Record<string, unknown>,
          )
          const changed = changedInputKeys(preHookInput, rewritten)
          execInput = rewritten
          if (changed.length > 0) {
            const { keys, dropped } = policyKeyFacts(changed)
            const note = policyRewriteNoteText(ctx.text, keys, dropped)
            if (note) lifecycleNotes.push(note)
          }
          const rewriteError = validateToolInput(tool.name, execInput, ctx.text)
          if (rewriteError !== null) {
            policyDenied = true
            o = liftText(rewriteError, { isError: true })
            isError = true
            await emit({
              type: "refused",
              tool: viewTool(),
              message: rewriteError,
              refusedBy: "policy",
            })
          }
        }
      } catch (e) {
        // Port failures must not brick the tool loop. Proceed with the
        // pre-hook input, so a port that mutated it and then threw cannot
        // run an unvalidated, un-noted rewrite.
        execInput = preHookInput
        // An approval gate is on the chain: deny this tool call only.
        if (lifecycle.hasFailClosedToolHook?.() === true) {
          const msg = e instanceof Error ? e.message : String(e)
          const label = e instanceof PolicyHookFailedError ? { label: e.label } : {}
          policyDenied = true
          const message = policyHookFailedText(ctx.text, {
            hook: "tool.willInvoke",
            detail: msg,
            ...label,
          })
          o = liftText(message, { isError: true })
          isError = true
          await emit({ type: "refused", tool: viewTool(), message, refusedBy: "policy" })
        }
      }
    }

    if (policyDenied) {
      // Skip execution; `o` and isError already set. Fold the lifecycle
      // notes as `policy` annotations (rule P).
      o = appendAnnotations(o, ...policyAnnotations(sb, lifecycleNotes))
    } else {
      // Admission is complete. With gates, the scheduler can make the call
      // wait here for a slot or for the earlier calls (a serial call).
      const inWave = await admit(execInput)
      // Tell the host the call starts now. The host decides when to show
      // the header: a built-in tool or a plugin tool with a header key
      // can show it at once. Other plugin tools can wait for the plugin
      // header text in the `plugin_result` event. `concurrent` only for a
      // call of a wave of 2 or more that passed the per-input check.
      const pluginTool = ctx.loader?.hasTool(tool.name) ?? false
      await emit({
        type: "started",
        tool: viewTool(),
        pluginTool,
        ...(inWave && ctx.concurrent === true ? { concurrent: true } : {}),
      })
      const toolStartedAt = Date.now()
      // Byte and stall activity is only for tools that STREAM chunks
      // (`STREAMING_BUILTIN_TOOLS` in tools.ts, today Bash). A tool that
      // never calls `onChunk` (every plugin tool: Fetch, WebSearch, …)
      // gets a neutral `idle` activity. Seeding `direction:"down"` for it
      // would make the host's stall check fire on a healthy call. The
      // same predicate gates the `onStdout`/`onStderr` wiring below, so
      // "seeds stall" and "wires onChunk" cannot drift apart.
      const toolStreamsOutput = streamsOutput(tool.name, pluginTool)
      // The host maps the phase to its own label ("Running <tool>").
      const toolStatus = (ctx.statusPort ?? NOOP_STATUS_PORT).open({
        phase: "running_tool",
        toolName: tool.name,
      })
      // When chunks DO start arriving (onChunk below), `lastChunkAt`
      // is bumped and the stalled state clears, giving way to
      // `↓ 1.2 KB · 12 B/s` etc.
      toolStatus.updateActivity(
        toolStreamsOutput
          ? {
              direction: "down",
              startedAt: toolStartedAt,
              recvBytes: 0,
              lastChunkAt: toolStartedAt,
            }
          : { direction: "idle", startedAt: toolStartedAt },
      )

      try {
        if (ctx.loader?.hasTool(tool.name)) {
          // Plugin-provided tool: delegate to the loader dispatcher. Plugin
          // handlers may draw their own interactive UI; we do not preview
          // their stdout here.
          const pluginResult = await ctx.loader.dispatch(
            {
              type: "tool",
              name: tool.name,
              input: execInput,
              tool_use_id: tool.id,
            },
            process.cwd(),
            // Forward the per-turn AbortSignal so Esc / Ctrl+C can
            // cancel a long-running plugin tool (Fetch, WebSearch, …).
            // Without this, abort no-ops until the manifest timeoutMs
            // fires — see loader.test.ts "dispatch external AbortSignal".
            signal,
          )
          let pluginView: PluginToolView = { suppressToolTime: false }
          if (pluginResult.kind === "tool_result") {
            isError = pluginResult.is_error
            pluginView = {
              ...(pluginResult.display !== undefined ? { display: pluginResult.display } : {}),
              ...(pluginResult.displayHeader !== undefined
                ? { displayHeader: pluginResult.displayHeader }
                : {}),
              ...(pluginResult.displayFooter !== undefined
                ? { displayFooter: pluginResult.displayFooter }
                : {}),
              suppressToolTime: pluginResult.suppressToolTime ?? false,
            }

            // Universal post-hoc clamp for plugin tools. Mirrors what
            // `executeTool` already does for built-in tools (Bash/Read/…).
            // Plugin handlers (Fetch, WebSearch, …) used to bypass the
            // clamp entirely, so a 5 MiB markdown from Fetch would ship
            // straight to the API. Now plugin output is clamped to the
            // same 64 KB / 1000-line budgets and the FULL pre-clamp body
            // is preserved in `rawForBlob` for the blob-store hook
            // below. Recoverable via the `<ma::agent::raw-output …/>` pointer
            // footer the agent appends a few lines down.
            //
            // Tools that want full plugin control over the
            // model-facing body (tasks, ShowDiff, LockStatus,
            // MemoryTool) live on the `skipTools` list resolved at
            // construction. A plugin body alone does NOT disable the
            // clamp: a plugin can set a short host-facing body while
            // `content` carries the full body, and we genuinely want
            // that body clamped.
            //
            // See `src/tools/truncation.ts` and `src/blob-store.ts`.
            // The host hints are the one writer of the host body, footer
            // and header (lead decision L6).
            const hints: HostHints = {
              ...(pluginResult.display !== undefined ? { view: pluginResult.display } : {}),
              ...(pluginResult.displayHeader !== undefined
                ? { header: pluginResult.displayHeader }
                : {}),
              ...(pluginResult.displayFooter !== undefined
                ? { footer: pluginResult.displayFooter }
                : {}),
              ...(pluginResult.suppressToolTime !== undefined
                ? { hideDuration: pluginResult.suppressToolTime }
                : {}),
            }
            const lift = {
              isError: pluginResult.is_error === true,
              ...(Object.keys(hints).length > 0 ? { hostHints: hints } : {}),
            }
            const body = pluginResult.content
            if (!ctx.blobSkipTools.has(tool.name)) {
              const parts = truncateToolOutputParts(body, { tool: tool.name }, R)
              o = liftClamped(parts, {
                ...lift,
                text: R,
                ...(parts.facts.truncated ? { rawForBlob: body } : {}),
              })
            } else {
              o = liftText(body, lift)
            }
            await runAfterRun(async () => {
              await chainPhase("clamp")
            })
          } else {
            o = liftText(nonToolResultText(ctx.text, tool.name), { isError: true })
            isError = true
          }
          await emit({ type: "plugin_result", tool: viewTool(), view: pluginView })
        } else {
          // Live-stream Bash stdout/stderr to the host view as the
          // child writes it, instead of waiting for the process to
          // exit. The host splits the chunks into lines and decides
          // how many to show. Reuse the same streaming predicate that
          // seeded the stall activity above, so "seeds stall" and
          // "wires onChunk" can never drift apart.
          const streams = toolStreamsOutput

          // Track bytes streamed AND timestamp the most recent chunk so
          // the live-area status row renders `↓ 1.2 KB · 12 B/s` while
          // bash is producing output, AND flips to `⋯ stalled · last
          // byte Ns ago` when the subprocess goes quiet (which the user
          // observes as "Bash is frozen with no feedback" -- common
          // when the command pipes through a buffering filter like
          // `tail -N` or `head -N` that holds all output until EOF).
          let recvBytes = 0
          const onChunk = (s: string) => {
            recvBytes += Buffer.byteLength(s, "utf8")
            toolStatus.updateActivity({
              direction: "down",
              recvBytes,
              lastChunkAt: Date.now(),
            })
            if (!view) return
            // Not awaited: the chunk callback is sync. A throw or a
            // rejection is ignored, like every view event.
            try {
              const pending = view.onToolEvent({ type: "output", tool: viewTool(), chunk: s })
              if (pending instanceof Promise) pending.catch(() => {})
            } catch {
              /* presentation only: ignore */
            }
          }

          const result = await (ctx.executeTool ?? executeTool)(tool.name, execInput, {
            signal,
            // Active-model media capability context : lets `Read` hand back
            // an image block for a screenshot the model can actually see
            // instead of UTF-8 mojibake. Provider-neutral; resolved from
            // the registry. `undefined` for unknown models keeps the
            // legacy text-only behavior.
            media: resolveToolMediaContext(ctx.model),
            onStdout: streams ? onChunk : undefined,
            onStderr: streams ? onChunk : undefined,
            fileTrackingStore: ctx.fileTrackingStore,
            toolEnv: ctx.toolEnv,
            ...(ctx.text ? { text: ctx.text } : {}),
          })
          // The lift reads `_truncParts`, `_raw` (pre-clamp body for the
          // blob), `_displayPatch`, `blocks` and `_aborted`. A lift that
          // cannot use the clamp parts keeps `content` as the body and
          // emits `tool-outcome.lift-fallback` (lead decision L7).
          o = liftBuiltIn(result, {
            text: R,
            onFallback: (reason) =>
              ctx.diagnostics?.warn("tool-outcome.lift-fallback", "", { tool: tool.name, reason }),
          })
          isError = result.is_error
          await runAfterRun(async () => {
            await chainPhase("clamp")

            // `aborted` tells the host view that the call was cancelled.
            if (o.aborted) {
              // If the executor surfaced partial output (e.g. Bash captured
              // some stdout before SIGTERM landed), keep it : both for the
              // user (transcript body) and for the model (so it sees what
              // ran before the abort). Only fall back to the canned
              // "canceled" string when the finalized text is empty (C-9).
              o = cancelWhenEmpty(o)
            } else {
              // Layer 3 of the size-feedback design: streak tracker.
              // After N consecutive truncations on the same tool, append
              // a soft `[note: ...]` to the model-facing content so the
              // model sees the *pattern*, not just per-call hints.
              // Skipped on aborted calls (no tool work happened) and on
              // plugin-tool branches (those don't go through executeTool
              // so we have no _truncInfo to consult anyway). With gates
              // it runs one call at a time in end order (SPEC X5): inside a
              // wave the streak follows the order in which the runs end.
              const streakNote = ctx.feedbackTracker.observe(
                tool.name,
                o.truncInfo?.truncated ?? false,
                ctx.text,
              )
              o = appendAnnotations(
                o,
                outputStreakAnnotation(streakNote, tool.name, ctx.feedbackTracker.streakThreshold),
              )
            }
          })

          // The host view can close a live output body here. With gates
          // this event comes when the run ends (end order), before the
          // clamp chain phase, so its `truncInfo` is the value before a
          // clamp stage.
          await emit({
            type: "executed",
            tool: viewTool(),
            isError,
            ...(o.truncInfo !== undefined ? { truncInfo: o.truncInfo } : {}),
          })
        }
      } finally {
        toolStatus.clear()
      }
      // The run ended. With gates, wait here for the post-run section: the
      // steps below (result chain, tool.didInvoke, the outcome event, blob
      // write) run one call at a time in end order (SPEC X3, decision 3').
      // A rejection (only with gates: an abort while the call waits, or a
      // loop failure) ends the call here. The host view still gets an
      // aborted outcome, so it can close the block of this call.
      await ran().catch(async (error: unknown) => {
        // The same outcome as an aborted run with no output (no annotations).
        const content = joinOutcome(cancelWhenEmpty(liftText(abortedText(ctx.text))))
        const outcome = { bodyEnd: content.length, annotations: [] }
        const view = { content, isError: true, aborted: true, findings: [], outcome }
        await emit({ type: "outcome", tool: viewTool(), outcome: view })
        throw error
      })
      if (afterRun) await (afterRun as () => Promise<void>)()
      const textBeforePreOutcome = o.body.text
      await chainPhase("pre-outcome")
      const preOutcomeChangedText = o.body.text !== textBeforePreOutcome

      // Detect binary tool output BEFORE the outcome event so the user never
      // sees mojibake, and so we can (a) force the full body into the blob
      // store even under the clamp threshold, and (b) rewrite the
      // model-facing text AFTER the blob write with the real on-disk path.
      // Media blocks (Read image embeds) and user-message document uploads
      // are untouched — those are the supported multimodal paths. Plugin
      // tools that already emitted `<ma::agent::binary-result` are left alone.
      let binaryGuard:
        | {
            mime: string
            sizeBytes: number
            optedIn: boolean
            source: string
          }
        | undefined
      // The classify reads the finalize prefix, not `body.text` (E7).
      const classifyPrefix = joinOutcome(o)
      if (!o.aborted && !o.media?.length && classifyPrefix.length > 0) {
        const sourceForClass = o.rawForBlob ?? classifyPrefix
        if (!sourceForClass.includes("<ma::agent::binary-result")) {
          const verdict = classifyBinaryText(sourceForClass)
          if (verdict.binary) {
            binaryGuard = {
              mime: verdict.mime,
              sizeBytes: Buffer.byteLength(sourceForClass, "utf8"),
              optedIn: isBinaryOptIn(execInput),
              source: sourceForClass,
            }
            // Placeholder model text for the preview paint; the real
            // rewrite (with blob path) lands after blob capture below. It
            // clears all annotations (W2-PLAN Q9) and the clamp numbers.
            const placeholder = formatBinaryResultMessage({
              mime: binaryGuard.mime,
              sizeBytes: binaryGuard.sizeBytes,
              tool: tool.name,
              ...(ctx.text ? { text: ctx.text } : {}),
            })
            const { truncInfo: _cleared, ...rest } = replaceBodyClearAnnotations(o, placeholder)
            o = {
              ...rest,
              rawForBlob: o.rawForBlob ?? sourceForClass,
              // Host-facing body: short clean summary, never the raw body.
              hostHints: {
                ...o.hostHints,
                view: `${verdict.mime} · ${binaryGuard.sizeBytes} bytes (binary; withheld from model)`,
              },
            }
          }
        }
      }

      // Embedded data-URI scrub BEFORE the outcome event so the user never
      // sees multi-KB base64 in the TUI, and so `content` is already clean
      // for the model. Whole-body binary (above) is a different path.
      // Capture pre-scrub bytes into `rawForBlob` so the blob store keeps
      // high-fidelity recovery material. Skipped when the call opted into
      // binary delivery or when multimodal image blocks are present.
      // Idempotent: re-scrub of already-clean text is a no-op.
      // The guard reads the finalize prefix. The scrub changes `body.text`
      // only (SPEC D5): no core annotation holds a data URI. The blob keeps
      // the prefix before the scrub (E7).
      const scrubPrefix = joinOutcome(o)
      if (
        !o.aborted &&
        !binaryGuard &&
        !o.media?.length &&
        !isBinaryOptIn(execInput) &&
        scrubPrefix.length > 0 &&
        !scrubPrefix.includes("<ma::agent::binary-result")
      ) {
        const scrubbed = scrubEmbeddedPayloads(o.body.text, { tool: tool.name })
        if (scrubbed.changed) {
          o = {
            ...o,
            body: { ...o.body, text: scrubbed.text },
            rawForBlob: o.rawForBlob ?? scrubPrefix,
          }
          const view = o.hostHints?.view
          if (typeof view === "string" && view.includes("data:")) {
            const d = scrubEmbeddedPayloads(view, { tool: tool.name })
            if (d.changed) o = { ...o, hostHints: { ...o.hostHints, view: d.text } }
          }
        }
      }

      // Tool-lifecycle extension point (generic seam, NOT diagnostics-
      // specific). Fire the `tool.didInvoke` CHAIN so any plugin can
      // augment a just-finished tool result: a plugin pushes structured
      // `findings` (the host view shows them) and model-facing
      // `notes` (a core `diagnostics` annotation on `o`). The `diagnostics` plugin (LSP/linter/formatter
      // feedback) is the first consumer; the shape is tool-agnostic.
      //
      // Decoupled by construction: the agent never imports the plugin,
      // the plugin never imports the agent — they meet only at the
      // `ToolDidInvokePayload` shape. Listener errors/timeouts are
      // absorbed by the HookBus, so a misbehaving plugin can never break
      // the tool loop. Skipped when no plugin subscribes (zero cost) and
      // for aborted runs (no completed work to react to).
      let findings: Finding[] = []
      if (!o.aborted) {
        const augmented = await runToolDidInvokeChain(
          lifecycle,
          tool.name,
          execInput,
          isError,
          hookFacts,
        )
        if (augmented) {
          o = appendAnnotations(o, diagnosticsAnnotation(sb, augmented.notes, augmented.scope))
          findings = augmented.findings
          // tool.didInvoke context rides the same fold as the beforeTool notes.
          lifecycleNotes.push(...augmented.context)
        }
      }

      // The call is complete: give the host its outcome. The host builds
      // its rows from it. Core builds no rows and adds no colors.
      // The host bytes come from the outcome: the text from the finalize
      // prefix, the host body, footer and diff from `o.hostHints` (L6).
      const hints = o.hostHints
      const fin = finalizeOutcome(o)
      const outcome: ToolViewOutcome = {
        content: joinOutcome(o),
        isError,
        aborted: o.aborted,
        ...(o.truncInfo !== undefined ? { truncInfo: o.truncInfo } : {}),
        ...(hints?.view !== undefined ? { display: hints.view } : {}),
        ...(hints?.footer !== undefined ? { displayFooter: hints.footer } : {}),
        ...(hints?.diff?.patch
          ? { diff: { patch: hints.diff.patch, newFile: hints.diff.newFile } }
          : {}),
        findings,
        ...(fin.text === joinOutcome(o)
          ? {
              outcome: {
                bodyEnd: fin.bodyEnd,
                annotations: fin.spans.map((s) =>
                  s.attrs !== undefined
                    ? { kind: s.kind, attrs: s.attrs, start: s.start, end: s.end }
                    : { kind: s.kind, start: s.start, end: s.end },
                ),
                ...("data" in o.body && o.body.data !== undefined ? { data: o.body.data } : {}),
              },
            }
          : {}),
      }
      await emit({ type: "outcome", tool: viewTool(), outcome })

      // Raw-output blob capture (design 2026-05-26). The model's
      // `content` may be the clamped body (built-in tools that hit the
      // 64KB/1000L universal cap) OR the full body (plugin tools, OR
      // built-ins under cap). When persistable, write the FULL bytes
      // to `<sid>.blobs/<tool_use_id>.raw` and append a
      // `<ma::agent::raw-output …/>` pointer footer so the model can `Read` the
      // file when the inline body isn't enough.
      //
      // Source of truth for the blob:
      //   - `result._raw` (built-in clamp branch) when set: pre-clamp
      //     body, never includes the trailing `[truncated: …]` notice.
      //   - `content` otherwise: full output (no clamp ran, or plugin
      //     tool which currently doesn't clamp at all).
      //
      // Skipped when:
      //   - blobStore is null (config disabled, or construction failed)
      //   - tool is on the user-configurable skip list (Task,
      //     MemoryTool, ShowDiff, LockStatus). These plugins own
      //     full audience-split and would be mangled by an
      //     after-the-fact blob+footer on the model-facing body.
      //   - tool was aborted (partial output, no point)
      //   - body too small to be useful (gated inside BlobStore.write
      //     via `minBytesToPersist`)
      //
      // A plugin body alone does NOT disable the blob: `content`
      // can carry the full body, and we genuinely want that body
      // persisted. For Edit/Write the `content` is "File written:
      // …" sized, so the `minBytesToPersist` gate inside the store
      // handles them without an explicit guard here.
      //
      // See `src/blob-store.ts`.
      if (ctx.blobStore !== null && !ctx.blobSkipTools.has(tool.name) && !o.aborted) {
        // The blob body is `rawForBlob`, else the finalize prefix (E7).
        const rawBody = o.rawForBlob ?? joinOutcome(o)
        // Async write: keeps the (potentially multi-MB) body's fs write
        // off the synchronous critical section so the TUI/input loop
        // doesn't freeze while a big Fetch body is persisted (Bug 4).
        // We're already inside an async function here, so the await is
        // free; the tool_result it produces is returned below either way.
        blobWrite = await ctx.blobStore.writeAsync(tool.id, rawBody)
        if (blobWrite) {
          o = {
            ...o,
            blob: { path: blobWrite.path, bytes: blobWrite.bytes, sha256: blobWrite.sha256 },
          }
        }
        if (blobWrite && !binaryGuard) {
          // Footer order: existing `[truncated: …]` notice is already
          // inside `content` (appended by truncation.ts when the clamp
          // fired). Our `<ma::agent::raw-output …/>` goes AFTER that and BEFORE
          // the `<ma::agent::output-preview …>` annotation appended below. The
          // model-facing tail therefore reads:
          //   <body>
          //   [truncated: …]               ← only when clamp fired
          //
          //   <ma::agent::raw-output path="<path>" size="85kB" sha256="…" />   ← new
          //
          //   <ma::agent::output-preview shown=… total=…>…</ma::agent::output-preview>   ← only when TUI elided
          //
          // Binary bodies skip this append: the binary-guard rewrite below
          // embeds path/sha256 itself so we never ship both a mojibake body
          // AND a raw-output footer.
          o = appendAnnotations(o, rawOutputAnnotation(sb, blobWrite))
        }
      }

      // Binary-output rewrite (runs AFTER blob capture so the annotation
      // can cite the real path). Replaces mojibake with a structured
      // `<ma::agent::binary-result …/>` summary unless the model opted in
      // via `binary: true` (then base64 under a size cap, else still path).
      if (binaryGuard) {
        const path = blobWrite?.path
        const sha256 = blobWrite?.sha256
        if (binaryGuard.optedIn) {
          const bytes = Buffer.from(binaryGuard.source, "latin1")
          const optIn = formatBinaryOptInContent({
            bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            mime: binaryGuard.mime,
            path,
            sha256,
            tool: tool.name,
            ...(ctx.text ? { text: ctx.text } : {}),
          })
          o = replaceBodyClearAnnotations(o, optIn)
        } else {
          const message = formatBinaryResultMessage({
            mime: binaryGuard.mime,
            sizeBytes: binaryGuard.sizeBytes,
            path,
            sha256,
            tool: tool.name,
            ...(ctx.text ? { text: ctx.text } : {}),
          })
          o = replaceBodyClearAnnotations(o, message)
        }
      }

      const textBeforePostBlob = o.body.text
      await chainPhase("post-blob")
      // Second clamp (SPEC D5, C-5): only when a stage changed `body.text`.
      if (preOutcomeChangedText || o.body.text !== textBeforePostBlob) {
        const parts = truncateToolOutputParts(o.body.text, { tool: tool.name }, R)
        // The grown text above the cut goes to its own blob (never `tool.id`:
        // the first blob is already cited). `blobWrite` then points to it.
        const grown = parts.facts.truncated ? await writeGrownBlob(ctx, tool, o) : null
        if (grown) blobWrite = grown
        o = clampAgain(o, parts, R, grown, sb)
      }

      // Layer 1b of size-feedback (companion to truncation.ts notice and
      // feedback-tracker.ts streak note): when the user's transcript
      // clamped MORE lines than the API cap did (every tool with a tight
      // preview budget : Bash=10, Read=15, Grep=12, Glob=25), append a
      // model-only `<ma::agent::output-preview …>` annotation to `content` BEFORE
      // the result block is built, so the model knows the audiences
      // diverged. Without this, the model sees the full body and
      // assumes the user did too, leading to "as you can see above"
      // claims that desync from what the user actually saw.
      //
      // Model-only by construction: this runs AFTER the outcome event,
      // so the host view never sees it. A host replay strips it from
      // the persisted tool_result history. Skipped when:
      //   - tool was refused by the mode gate (no execution happened),
      //   - the host shows a custom body: a plugin body, the binary
      //     summary, or an Edit/Write diff (shown full by design),
      //   - tool was aborted (partial output, no point nagging),
      //   - body fits the TUI budget.
      if (!o.hostHints?.view && !o.hostHints?.diff?.patch && !o.aborted) {
        // Rule V: the count reads the finalize prefix (the raw-output
        // footer is counted). When a raw-output blob was written for this
        // same result (above), its path goes into BOTH the hint prose and a
        // machine-readable `path="…"` attribute, so the elision flag carries
        // its own recovery pointer. `blobWrite` is null when nothing spilled
        // (body under `minBytesToPersist`, store disabled, skip-listed tool).
        o = appendAnnotations(o, outputPreviewAnnotation(R, o, tool.name, blobWrite?.path))
      }

      // Fold the tool.willInvoke and tool.didInvoke context as `policy`
      // annotations (rule P). With media blocks the text becomes the
      // leading text block of the block array below, so no context is lost.
      o = appendAnnotations(o, ...policyAnnotations(sb, lifecycleNotes))
      await chainPhase("final")
    } // end !policyDenied
  }
  // A refused call (mode gate, input error, policy deny) and the `Mode` tool
  // have no run. With gates, tell the scheduler. Then wait for the place of
  // this call in call order: the mode stamp and the save run in call order.
  // No-ops when the gates were already called.
  await admit(null)
  await ran()
  await inCallOrder()

  // Active-mode stamp on EVERY tool_result. Continuously surfaces
  // the current mode to the model so reasoning inertia from
  // earlier in the same turn can't keep operating under a stale
  // mode. Emitted only when a mode is active : default/no-mode
  // turns are byte-identical to pre-stamp output, so tool_results
  // in unrestricted sessions don't grow.
  //
  // Position: trailing on the tool_result content text. Sits in
  // the rolling-tail cache breakpoint that's invalidated every
  // turn anyway. Zero cache cost.
  //
  // Refusals get the stamp too : the model needs to know which
  // mode produced the refusal so it can adapt deterministically
  // (the refusal message already says "in <LABEL> mode", and the
  // stamp gives the machine-readable id alongside).
  //
  // The stamp is a core annotation added BEFORE the stamp phase (SPEC
  // D5, T4): a stamp stage can read it but not change it. The id, the
  // time (one clock read) and the text come from one value (L1).
  const stampFacts = ctx.modeManager?.activeStampFacts() ?? null
  if (stampFacts) {
    o = appendAnnotations(o, modeActiveAnnotation(stampFacts.text, stampFacts.id, stampFacts.since))
  }
  const stampStage = await chainPhase("stamp")
  // The one place that makes the model text (SPEC D6).
  const content = finalizeOutcome(o).text
  const mediaBlocks = o.media

  // When a media-aware tool attached image blocks (Read on a screenshot
  // for a vision model), the tool_result content becomes a BLOCK ARRAY:
  // the text caption first, then the image block(s). The wire layer
  // (legacy Messages, and the canonical adapter) accepts
  // text+image inside a tool_result. Without media blocks, content stays
  // a plain string : byte-identical to every prior tool_result. The
  // mode stamp / blob footers already folded into `content` above ride
  // along as that leading text block.
  const resultContent: string | ContentBlock[] =
    mediaBlocks && mediaBlocks.length > 0
      ? [
          ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
          ...mediaBlocks.map(mediaBlockToLegacy),
        ]
      : content
  const resultBlock: ToolResultBlock = {
    type: "tool_result",
    tool_use_id: tool.id,
    content: resultContent,
    is_error: isError,
  }
  const mark = sidebandMark(stampStage, ctx.sidebandRegistry, ctx.diagnostics)
  if (mark) resultBlock.sideband = mark
  // The final outcome, the value that finalize joined into the block
  // (W2-PLAN G2). The persisted record holds its structure (SPEC D8); its
  // offsets refer to the block text. Undefined means "no record": the
  // record checks failed, and the report gets one diagnostic. The attach
  // never throws by its contract; the guard keeps the tool result if a
  // hostile value breaks that contract.
  const toolOutcome = o
  const diagnostics = ctx.diagnostics
  let rec: ReturnType<typeof attachPersistedOutcome>
  try {
    rec = attachPersistedOutcome(
      resultBlock,
      toolOutcome,
      diagnostics ? (id, data) => diagnostics.warn(id, "", data as StructuredData) : undefined,
      tool.name,
    )
  } catch {
    rec = undefined
  }
  // Persist the result. New records carry no presentation fields (spec
  // S29): a host replay derives its own view from the stored record.
  ctx.store?.appendToolResult(
    resultBlock,
    undefined,
    blobWrite
      ? { path: blobWrite.path, bytes: blobWrite.bytes, sha256: blobWrite.sha256 }
      : undefined,
    rec,
  )
  return resultBlock
}

/**
 * Save the grown text (`body.text` before the second cut) in `<id>_grown.raw`.
 * Same guards as the first blob write. Null when the store is off, the tool is
 * on the skip list, the call was aborted, the text is under the minimum, or
 * the write failed. Never throws.
 */
async function writeGrownBlob(
  ctx: ToolRoundContext,
  tool: ToolUseBlock,
  o: ToolOutcome,
): Promise<BlobWriteResult | null> {
  if (ctx.blobStore === null || ctx.blobSkipTools.has(tool.name) || o.aborted) return null
  try {
    return await ctx.blobStore.writeAsync(`${tool.id}_grown`, o.body.text)
  } catch {
    return null
  }
}

/**
 * The second clamp (SPEC D5, C-5, lead decision L2). Run it only when a
 * `pre-outcome` or `post-blob` stage changed `body.text`. `parts` is the pure
 * cut of the grown text. When it cut, `body.text` is the kept text, `truncInfo`
 * is the new info, and the core `output-truncated` annotation is replaced in
 * place, else added at index 0. It also runs for a tool on the blob skip list.
 * When `grown` (the blob of the grown text) is given, `o.blob` points to it and
 * the core `raw-output` annotation is replaced in place, else added right after
 * `output-truncated`. Order stays: notice, raw-output, preview.
 *
 * Known limit: the `outcome` event that the host already got keeps the old
 * `truncInfo`.
 */
function clampAgain(
  o: ToolOutcome,
  parts: ReturnType<typeof truncateToolOutputParts>,
  text: SyntheticTextResolver,
  grown: BlobWriteResult | null,
  sb: SidebandApi,
): ToolOutcome {
  if (!parts.facts.truncated) return o
  const notice = outputTruncatedAnnotation(text, parts.facts)
  const isCore = (kind: string) => (a: ToolAnnotation) => a.kind === kind && a.owner === "core"
  const at = o.annotations.findIndex(isCore("output-truncated"))
  let annotations =
    at >= 0 ? o.annotations.map((a, i) => (i === at ? notice : a)) : [notice, ...o.annotations]
  // No codec: no footer for the grown blob (the `blob` field still cites it).
  const raw = grown ? rawOutputAnnotation(sb, grown) : null
  const rawAt = annotations.findIndex(isCore("raw-output"))
  if (raw && rawAt >= 0) annotations = annotations.map((a, i) => (i === rawAt ? raw : a))
  else if (raw) {
    const after = annotations.findIndex(isCore("output-truncated")) + 1
    annotations = [...annotations.slice(0, after), raw, ...annotations.slice(after)]
  }
  return {
    ...o,
    body: { ...o.body, text: parts.kept },
    annotations,
    truncInfo: { ...parts.info },
    ...(grown ? { blob: { path: grown.path, bytes: grown.bytes, sha256: grown.sha256 } } : {}),
  }
}
