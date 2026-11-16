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

import type { ToolResultPhase } from "../../plugin-api/src/types/tool-result-chain.ts"
import { computeTuiElision, formatDiagnosticsAnnotation } from "../agent/tool-preview-budget.ts"
import type {
  PluginToolView,
  ToolViewEvent,
  ToolViewOutcome,
  ToolViewPort,
} from "../agent/tool-view-port.ts"
import { NOOP_STATUS_PORT, type StatusPort } from "../bus/status-port.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import { resolveToolMediaContext } from "../media/tool-context.ts"
import type { ModeManager } from "../modes/modes.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import { cleanHookContext, wrapHookContext } from "../sdk/hook-context.ts"
import {
  collectAdditionalContext,
  isDenied,
  type LifecyclePort,
  NOOP_LIFECYCLE,
  type ToolDidInvokeResult,
} from "../sdk/lifecycle.ts"
import type { ToolEnvPort } from "../sdk/tool-env.ts"
import { type Finding, makeToolDidInvokePayload } from "../sdk/tool-lifecycle.ts"
import {
  type BlobStore,
  type BlobWriteResult,
  formatRawOutputFooter,
} from "../session/blob-store.ts"
import type { FileTrackingStore } from "../session/file-tracking-store.ts"
import type { SessionStore } from "../session/session-store.ts"
import type { ReadonlySidebandRegistry } from "../sideband/types.ts"
import {
  classifyBinaryText,
  formatBinaryOptInContent,
  formatBinaryResultMessage,
  isBinaryOptIn,
} from "../tools/binary-guard.ts"
import { scrubEmbeddedPayloads } from "../tools/embedded-payload-scrub.ts"
import type { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"
import { outputPreviewAnnotation, tuiPreviewHint } from "../tools/PROMPTS.ts"
import { normalizeToolInput, validateToolInput } from "../tools/tool-input.ts"
import {
  executeTool,
  toolStreamsOutput as streamsOutput,
  type ToolResultMediaBlock,
} from "../tools/tools.ts"
import { type TruncationInfo, truncateToolOutput } from "../tools/truncation.ts"

import { type ToolHookFacts, toolHookFacts } from "./tool-hook-facts.ts"
import type { ToolResultChainEntry } from "./tool-result-chain.ts"
import { applyChainPhase, hasChainPhase, sidebandMark } from "./tool-result-chain-glue.ts"

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
   * Tool-result transform chain (spec R-API-3). Omitted: empty, the round
   * runs only its inline code. The loader does not pass it yet.
   */
  toolResultChain?: readonly ToolResultChainEntry[]
  /** Sideband registry for the `kind` check of the stamp phase. */
  sidebandRegistry?: Pick<ReadonlySidebandRegistry, "kind">
  /** Injected diagnostics handle (S20). Omitted: the drop diagnostic is not emitted. */
  diagnostics?: Diagnostics
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
 * - `annotation`: the `<ma::agent::diagnostics>` block (or `""`) built from
 *   the plugins' model-facing `notes`, to append to `tool_result.content`.
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
): Promise<{ findings: Finding[]; annotation: string; context: string[] } | null> {
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
    return context.length > 0 ? { findings, annotation: "", context } : null
  }

  const diagScope = findings.find((f) => f.scope)?.scope
  return {
    findings,
    annotation: formatDiagnosticsAnnotation(notes, diagScope),
    context,
  }
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
function formatPolicyKeyNames(keys: string[]): string {
  const shown = keys.filter((k) => POLICY_KEY_NAME.test(k)).slice(0, POLICY_KEY_CAP)
  const dropped = keys.length - shown.length
  return dropped > 0 ? [...shown, `+${dropped} more`].join(", ") : shown.join(", ")
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
  const { signal } = ctx
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

  let content = ""
  let isError: boolean | undefined
  /** A plugin body, or the binary-output summary. Host-facing only. */
  let display: string | undefined
  /** A plugin footer. Host-facing only. */
  let displayFooter: string | undefined
  /** The plain unified diff of an Edit or Write call. */
  let diffPatch: string | undefined
  let diffNewFile = false
  let truncInfo: TruncationInfo | undefined
  let aborted = false
  /**
   * Non-text content blocks (currently images) a media-aware tool
   * attached to its result : e.g. `Read` on a screenshot for a vision
   * model. They ride into the `tool_result` content alongside the text
   * caption (converted to legacy wire blocks below) so the model
   * actually sees the pixels. Empty for the overwhelming majority of
   * tool calls. See `src/tools.ts` :: `ToolExecResult.blocks` and
   * `src/media/read-file.ts`.
   */
  let mediaBlocks: ToolResultMediaBlock[] | undefined
  /**
   * Pre-clamp body the agent should persist via the blob store.
   * Set from `executeTool` result's `_raw` field when the universal
   * truncation clamp fired (built-in path). Left undefined for the
   * plugin path: the plugin result's `content` IS the full body in
   * that case, so the agent falls back to `content` for the blob.
   * See `src/tools.ts` :: `executeTool` and `src/blob-store.ts`.
   */
  let rawForBlob: string | undefined
  /**
   * Outcome of the blob write, populated inside the else-execute
   * branch and read after the if-refused/else-execute structure
   * when building the JSONL record. `null` when no blob was
   * written (store disabled, body too small, tool on skip list,
   * write failure, etc.).
   */
  let blobWrite: BlobWriteResult | null = null

  /** Run one chain phase over the locals. No stage for it: nothing runs. */
  const chainPhase = async (phase: ToolResultPhase) => {
    const entries = ctx.toolResultChain
    if (entries === undefined || !hasChainPhase(entries, phase)) return undefined
    const meta = {
      tool: tool.name,
      toolUseId: tool.id,
      input: execInput,
      blob: blobWrite ?? undefined,
    }
    const r = await applyChainPhase(
      phase,
      entries,
      { content, isError, aborted, truncInfo, rawForBlob, display },
      meta,
    )
    ;({ content, isError, aborted, truncInfo, rawForBlob, display } = r.vars)
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
  const prepError = validateToolInput(tool.name, execInput)

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
    gate.allowed && !prepError,
    gate.allowed ? (prepError ?? undefined) : gate.message,
  )
  if (!gate.allowed) {
    content = gate.message
    isError = true
    // Tell the host what got blocked. The host owns how a refusal looks.
    // Core supplies the message and the refusing mode's id.
    await emit({
      type: "refused",
      tool: viewTool(),
      message: content,
      refusedBy: ctx.modeManager?.activeId() ?? "mode",
    })
  } else if (prepError) {
    content = prepError
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
    content = JSON.stringify(result, null, 2)
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
          content =
            will.action === "deny" || will.action === "ask"
              ? will.reason
              : "Tool blocked by lifecycle policy hook."
          isError = true
          await emit({ type: "refused", tool: viewTool(), message: content, refusedBy: "policy" })
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
            lifecycleNotes.push(`input rewritten by policy: ${formatPolicyKeyNames(changed)}`)
          }
          const rewriteError = validateToolInput(tool.name, execInput)
          if (rewriteError) {
            policyDenied = true
            content = rewriteError
            isError = true
            await emit({ type: "refused", tool: viewTool(), message: content, refusedBy: "policy" })
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
          policyDenied = true
          content = `Tool blocked by lifecycle policy hook. The approval hook failed (${msg}).`
          isError = true
          await emit({ type: "refused", tool: viewTool(), message: content, refusedBy: "policy" })
        }
      }
    }

    if (policyDenied) {
      // Skip execution; content/isError already set. Fold lifecycle notes below.
      if (lifecycleNotes.length > 0) {
        content = `${content}\n${wrapHookContext(lifecycleNotes)}`
      }
    } else {
      // Tell the host the call starts now. The host decides when to show
      // the header: a built-in tool or a plugin tool with a header key
      // can show it at once. Other plugin tools can wait for the plugin
      // header text in the `plugin_result` event.
      const pluginTool = ctx.loader?.hasTool(tool.name) ?? false
      await emit({ type: "started", tool: viewTool(), pluginTool })
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
            content = pluginResult.content
            isError = pluginResult.is_error
            display = pluginResult.display
            displayFooter = pluginResult.displayFooter
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
            if (!ctx.blobSkipTools.has(tool.name)) {
              const preClamp = content
              const { content: clamped, info } = truncateToolOutput(preClamp, {
                tool: tool.name,
              })
              content = clamped
              truncInfo = info
              if (info.truncated) rawForBlob = preClamp
            }
            await chainPhase("clamp")
          } else {
            content = `Plugin tool "${tool.name}" returned a non-tool_result value`
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

          const result = await executeTool(tool.name, execInput, {
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
          })
          content = result.content
          isError = result.is_error
          diffPatch = result._displayPatch
          diffNewFile = result._displayNewFile === true
          truncInfo = result._truncInfo
          mediaBlocks = result.blocks
          // Pre-clamp body, present only when the universal clamp
          // fired (see `src/tools.ts` :: `executeTool`). The agent's
          // blob-store hook below prefers this over the clamped
          // `content` so the persisted file is the FULL output.
          rawForBlob = result._raw
          await chainPhase("clamp")

          // Propagate _aborted so the host view knows the call was
          // cancelled. The flag is stripped before the result is sent
          // back to the API as a tool_result block.
          if ((result as { _aborted?: boolean })._aborted) {
            aborted = true
            // If the executor surfaced partial output (e.g. Bash captured
            // some stdout before SIGTERM landed), keep it : both for the
            // user (transcript body) and for the model (so it sees what
            // ran before the abort). Only fall back to the canned
            // "canceled" string when there's literally nothing to show.
            if (!content) content = "canceled"
          } else {
            // Layer 3 of the size-feedback design: streak tracker.
            // After N consecutive truncations on the same tool, append
            // a soft `[note: ...]` to the model-facing content so the
            // model sees the *pattern*, not just per-call hints.
            // Skipped on aborted calls (no tool work happened) and on
            // plugin-tool branches (those don't go through executeTool
            // so we have no _truncInfo to consult anyway).
            const streakNote = ctx.feedbackTracker.observe(tool.name, truncInfo?.truncated ?? false)
            if (streakNote) content = `${content}\n\n${streakNote}`
          }

          // The host view can close a live output body here.
          await emit({
            type: "executed",
            tool: viewTool(),
            isError,
            ...(truncInfo !== undefined ? { truncInfo } : {}),
          })
        }
      } finally {
        toolStatus.clear()
      }
      await chainPhase("pre-outcome")

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
      if (!aborted && !mediaBlocks?.length && typeof content === "string" && content.length > 0) {
        const sourceForClass = rawForBlob ?? content
        if (!sourceForClass.includes("<ma::agent::binary-result")) {
          const verdict = classifyBinaryText(sourceForClass)
          if (verdict.binary) {
            if (rawForBlob == null) rawForBlob = sourceForClass
            binaryGuard = {
              mime: verdict.mime,
              sizeBytes: Buffer.byteLength(sourceForClass, "utf8"),
              optedIn: isBinaryOptIn(execInput),
              source: sourceForClass,
            }
            // Host-facing body: short clean summary, never the raw body.
            display = `${verdict.mime} · ${binaryGuard.sizeBytes} bytes (binary; withheld from model)`
            // Placeholder model content for the preview paint; the real
            // rewrite (with blob path) lands after blob capture below.
            content = formatBinaryResultMessage({
              mime: binaryGuard.mime,
              sizeBytes: binaryGuard.sizeBytes,
              tool: tool.name,
            })
            truncInfo = undefined
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
      if (
        !aborted &&
        !binaryGuard &&
        !mediaBlocks?.length &&
        !isBinaryOptIn(execInput) &&
        typeof content === "string" &&
        content.length > 0 &&
        !content.includes("<ma::agent::binary-result")
      ) {
        const preScrub = content
        const scrubbed = scrubEmbeddedPayloads(preScrub, { tool: tool.name })
        if (scrubbed.changed) {
          if (rawForBlob == null) rawForBlob = preScrub
          content = scrubbed.text
          if (typeof display === "string" && display.includes("data:")) {
            const d = scrubEmbeddedPayloads(display, { tool: tool.name })
            if (d.changed) display = d.text
          }
        }
      }

      // Tool-lifecycle extension point (generic seam, NOT diagnostics-
      // specific). Fire the `tool.didInvoke` CHAIN so any plugin can
      // augment a just-finished tool result: a plugin pushes structured
      // `findings` (the host view shows them) and model-facing
      // `notes` (folded into a `<ma::agent::diagnostics>` annotation on
      // `content`). The `diagnostics` plugin (LSP/linter/formatter
      // feedback) is the first consumer; the shape is tool-agnostic.
      //
      // Decoupled by construction: the agent never imports the plugin,
      // the plugin never imports the agent — they meet only at the
      // `ToolDidInvokePayload` shape. Listener errors/timeouts are
      // absorbed by the HookBus, so a misbehaving plugin can never break
      // the tool loop. Skipped when no plugin subscribes (zero cost) and
      // for aborted runs (no completed work to react to).
      let findings: Finding[] = []
      if (!aborted) {
        const augmented = await runToolDidInvokeChain(
          lifecycle,
          tool.name,
          execInput,
          isError,
          hookFacts,
        )
        if (augmented) {
          if (augmented.annotation) content = `${content}${augmented.annotation}`
          findings = augmented.findings
          // tool.didInvoke context rides the same fold as the beforeTool notes.
          lifecycleNotes.push(...augmented.context)
        }
      }

      // The call is complete: give the host its outcome. The host builds
      // its rows from it. Core builds no rows and adds no colors.
      const outcome: ToolViewOutcome = {
        content,
        isError,
        aborted,
        ...(truncInfo !== undefined ? { truncInfo } : {}),
        ...(display !== undefined ? { display } : {}),
        ...(displayFooter !== undefined ? { displayFooter } : {}),
        ...(diffPatch ? { diff: { patch: diffPatch, newFile: diffNewFile } } : {}),
        findings,
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
      if (ctx.blobStore !== null && !ctx.blobSkipTools.has(tool.name) && !aborted) {
        const rawBody = rawForBlob ?? content
        // Async write: keeps the (potentially multi-MB) body's fs write
        // off the synchronous critical section so the TUI/input loop
        // doesn't freeze while a big Fetch body is persisted (Bug 4).
        // We're already inside an async function here, so the await is
        // free; the tool_result it produces is returned below either way.
        blobWrite = await ctx.blobStore.writeAsync(tool.id, rawBody)
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
          content = `${content}\n\n${formatRawOutputFooter(blobWrite)}`
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
          content = formatBinaryOptInContent({
            bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            mime: binaryGuard.mime,
            path,
            sha256,
            tool: tool.name,
          })
        } else {
          content = formatBinaryResultMessage({
            mime: binaryGuard.mime,
            sizeBytes: binaryGuard.sizeBytes,
            path,
            sha256,
            tool: tool.name,
          })
        }
      }

      await chainPhase("post-blob")

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
      if (!display && !diffPatch && !aborted) {
        const e = computeTuiElision(content, tool.name)
        if (e) {
          // When a raw-output blob was written for this same result (above),
          // thread its path into BOTH the hint prose and a machine-readable
          // `path="…"` attribute, so the elision flag carries its own recovery
          // pointer instead of stranding the model with "you saw less than the
          // model did" and no destination. `blobWrite` is the write outcome
          // from the blob-store hook a few lines up; null when nothing spilled
          // (body under `minBytesToPersist`, store disabled, skip-listed tool).
          const rawPath = blobWrite?.path
          const hint = tuiPreviewHint(tool.name, rawPath)
          content = outputPreviewAnnotation({
            content,
            shown: e.shown,
            total: e.total,
            tool: tool.name,
            path: rawPath,
            hint,
          })
        }
      }

      // Fold the tool.willInvoke and tool.didInvoke context onto the text.
      // `content` is always a string here. With media blocks it becomes the
      // leading text block of the block array below, so no context is lost.
      if (lifecycleNotes.length > 0) {
        content = `${content}\n${wrapHookContext(lifecycleNotes)}`
      }
      await chainPhase("final")
    } // end !policyDenied
  }

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
  const stampStage = await chainPhase("stamp")
  const modeStamp = ctx.modeManager?.buildActiveModeStamp() ?? null
  if (modeStamp) {
    content = content.length > 0 ? `${content}\n\n${modeStamp}` : modeStamp
  }

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
  // Persist the result. New records carry no presentation fields (spec
  // S29): a host replay derives its own view from the stored record.
  ctx.store?.appendToolResult(
    resultBlock,
    undefined,
    blobWrite
      ? { path: blobWrite.path, bytes: blobWrite.bytes, sha256: blobWrite.sha256 }
      : undefined,
  )
  return resultBlock
}
