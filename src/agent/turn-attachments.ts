/**
 * Turn-attachment provider registry — the core side of the A-1 seam.
 *
 * Historically `src/index.ts` statically imported attachment producers
 * from `plugins/{memory,sub-agents,tasks}` (SaveEchoCollector,
 * ShortTermSnapshot, TasksAttachment, SubagentsAttachment, parseFile) —
 * six I2 violations. This module replaces that coupling with a
 * registry: plugins declare `turnAttachments` entries in their
 * `manifest.json`, the loader resolves each module through its blessed
 * runtime-discovery seam (computed dynamic import — see
 * `src/plugins/loader/turn-attachments.ts`) and registers the
 * default-export FACTORY here. The boot path then calls
 * {@link instantiateTurnAttachments} with the live session context and
 * hands the resulting producers/drains to the Agent's existing
 * `turnAttachments` / `saveEcho` constructor params.
 *
 * Two contribution shapes, sniffed structurally off the factory's
 * return value:
 *
 *   - **producer** — `{ toAttachment(): ContentBlock | null }`.
 *     Called once per `Agent.run` at the initial user-content seam;
 *     `null` means "nothing this turn" (zero token cost when idle).
 *     This is the shape of ShortTermSnapshot / TasksAttachment /
 *     SubagentsAttachment.
 *   - **drain** — `{ consumeAll(): ContentBlock[] }`. Drained at every
 *     user-message seam (initial AND loop); the queue refills between
 *     drains. This is the shape of the memory plugin's
 *     SaveEchoCollector.
 *
 * A factory may return an object implementing both; it is then wired
 *  into both lists.
 *
 * Missing plugin = graceful degradation: an empty registry yields zero
 * producers and zero drains, and the Agent runs exactly as if the
 * feature didn't exist. Errors are lenient throughout (log + skip) —
 * a buggy attachment plugin must never break boot.
 *
 * Module-level registry by design, mirroring
 * `src/session-replay-derivers.ts`'s replay-renderer registry (unit
 * A-2): the loader registers at boot, the boot path consumes once,
 * and no loader handle needs threading through.
 *
 * @module agent/turn-attachments
 */

import type { ContentBlock } from "../llm/messages.ts"
import type { ReplaySidecarTask } from "../host/session-replay-derivers.ts"

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * Per-turn attachment producer — the shape `Agent`'s `turnAttachments`
 * param already consumes (see `src/agent.ts`). Called at the initial
 * user-content seam of each `Agent.run`; `null` contributes nothing.
 */
export interface TurnAttachmentProducer {
  toAttachment(): ContentBlock | null
}

/**
 * Per-seam content drain — the shape `Agent`'s `saveEcho` param already
 * consumes. Drained at every user-message seam (initial + loop).
 */
export interface TurnContentDrain {
  consumeAll(): ContentBlock[]
}

/**
 * Context handed to every factory at instantiation time. Deliberately
 * small: plugins re-declare the slice they consume (structural typing,
 * the session-history host-types idiom) and must not assume more.
 */
export interface TurnAttachmentContext {
  /** The live session id, or `null` when no session is plumbed through. */
  sessionId: string | null
  /**
   * The loader's event bus, when the host has one. Typed `unknown` on
   * purpose — core does not export a bus contract through this seam;
   * a plugin that wants the bus re-declares the structural slice it
   * uses (e.g. `{ on(event, fn): () => void }`).
   */
  bus?: unknown
}

/**
 * A plugin-supplied factory: receives the {@link TurnAttachmentContext}
 * and returns the producer/drain instance (or a promise of one). A
 * return value that implements neither shape is logged and dropped.
 */
export type TurnAttachmentFactory = (ctx: TurnAttachmentContext) => unknown

interface RegisteredFactory {
  key: string
  factory: TurnAttachmentFactory
  /** Sort key: lower = earlier in the producers array. Default 100. */
  order: number
  /** Registration sequence — tie-break for equal `order`. */
  seq: number
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Registered factories, keyed by `<pluginId>/<entryId>`. Module-level
 * by design (see module doc). Insertion order is preserved as the
 * secondary sort key.
 */
const factories = new Map<string, RegisteredFactory>()
let registrationSeq = 0

/**
 * Register a turn-attachment factory under a stable key
 * (`<pluginId>/<entryId>` by convention from the loader). A second
 * registration for the same key replaces the first (the loader's
 * first-wins collision policy is settled BEFORE this is called).
 * Returns an unregister handle that removes the factory only if it is
 * still the active one for that key.
 */
export function registerTurnAttachmentFactory(
  key: string,
  factory: TurnAttachmentFactory,
  opts: { order?: number } = {},
): () => void {
  const entry: RegisteredFactory = {
    key,
    factory,
    order: opts.order ?? 100,
    seq: registrationSeq++,
  }
  factories.set(key, entry)
  return () => {
    if (factories.get(key) === entry) factories.delete(key)
  }
}

/** Drop every registered factory. Test hygiene helper. */
export function clearTurnAttachmentFactories(): void {
  factories.clear()
}

/** Structural sniff: does the value implement the producer shape? */
function isProducer(v: unknown): v is TurnAttachmentProducer {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { toAttachment?: unknown }).toAttachment === "function"
  )
}

/** Structural sniff: does the value implement the drain shape? */
function isDrain(v: unknown): v is TurnContentDrain {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { consumeAll?: unknown }).consumeAll === "function"
  )
}

/**
 * Instantiate every registered factory against the live session
 * context and classify the results.
 *
 * Factories run in `(order, registration seq)` order; the returned
 * `producers` array preserves that order (it becomes the model-visible
 * attachment order in the first user message). A factory that throws,
 * rejects, or returns a value implementing neither shape is logged via
 * `logger` and skipped — boot never fails because of one bad plugin.
 */
export async function instantiateTurnAttachments(
  ctx: TurnAttachmentContext,
  logger: (msg: string) => void = () => {},
): Promise<{ producers: TurnAttachmentProducer[]; drains: TurnContentDrain[] }> {
  const producers: TurnAttachmentProducer[] = []
  const drains: TurnContentDrain[] = []
  const ordered = Array.from(factories.values()).sort((a, b) => a.order - b.order || a.seq - b.seq)
  for (const f of ordered) {
    let instance: unknown
    try {
      instance = await f.factory(ctx)
    } catch (err) {
      logger(
        `turn attachment "${f.key}": factory threw: ` +
          `${err instanceof Error ? err.message : String(err)}; skipping`,
      )
      continue
    }
    const producer = isProducer(instance)
    const drain = isDrain(instance)
    if (!producer && !drain) {
      if (instance != null) {
        logger(
          `turn attachment "${f.key}": factory returned neither a producer ` +
            `({toAttachment}) nor a drain ({consumeAll}); skipping`,
        )
      }
      continue
    }
    if (producer) producers.push(instance as TurnAttachmentProducer)
    if (drain) drains.push(instance as TurnContentDrain)
  }
  return { producers, drains }
}

/**
 * Fold multiple drains into the single `{consumeAll}` the Agent's
 * `saveEcho` param accepts. Returns `null` for an empty list so the
 * caller can pass it straight through (`saveEcho: null` = feature off).
 */
export function combineTurnDrains(drains: readonly TurnContentDrain[]): TurnContentDrain | null {
  if (drains.length === 0) return null
  if (drains.length === 1) return drains[0] as TurnContentDrain
  return {
    consumeAll(): ContentBlock[] {
      const out: ContentBlock[] = []
      for (const d of drains) out.push(...d.consumeAll())
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// Replay sidecar parsing (core-local structural mirror)
// ---------------------------------------------------------------------------

/**
 * Parse the tasks plugin's per-session sidecar JSONL
 * (`~/.minimal-agent/sessions/<sid>.tasks.jsonl`) into the core-local
 * {@link ReplaySidecarTask} slice.
 *
 * Core-local mirror of `plugins/tasks/lib/parse.ts`'s `parseFile` —
 * re-implemented here (not imported) per the I2 invariant. The replay
 * path only needs read-side tolerance, so this validates exactly what
 * the plugin parser validates and silently drops anything else:
 * corruption must degrade to "no sidecar", never break `--resume`.
 * v1 lines (no `started_at` / `last_resumed_at` / `active_ms`) parse
 * forward-compatibly with the v2 fields defaulted to `null` / `0`,
 * matching the plugin parser byte for byte.
 */
export function parseReplaySidecarTasks(content: string): ReplaySidecarTask[] {
  const out: ReplaySidecarTask[] = []
  for (const line of content.split("\n")) {
    const t = parseSidecarLine(line)
    if (t !== null) out.push(t)
  }
  return out
}

const SIDECAR_ID_RE = /^[0-9a-f]{6}([a-z])?$/
const SIDECAR_STATUSES = new Set(["todo", "doing", "done", "canceled"])

function parseSidecarLine(line: string): ReplaySidecarTask | null {
  const trimmed = line.trim()
  if (trimmed === "") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  if (typeof o.id !== "string" || !SIDECAR_ID_RE.test(o.id)) return null
  if (o.parent !== null && (typeof o.parent !== "string" || !SIDECAR_ID_RE.test(o.parent))) {
    return null
  }
  if (typeof o.status !== "string" || !SIDECAR_STATUSES.has(o.status)) return null
  if (typeof o.title !== "string") return null
  if (typeof o.created_at !== "string") return null
  if (o.done_at !== null && o.done_at !== undefined && typeof o.done_at !== "string") return null
  if (o.reason !== null && o.reason !== undefined && typeof o.reason !== "string") return null
  if (o.started_at !== null && o.started_at !== undefined && typeof o.started_at !== "string") {
    return null
  }
  if (
    o.last_resumed_at !== null &&
    o.last_resumed_at !== undefined &&
    typeof o.last_resumed_at !== "string"
  ) {
    return null
  }
  if (o.active_ms !== undefined) {
    if (typeof o.active_ms !== "number" || !Number.isFinite(o.active_ms) || o.active_ms < 0) {
      return null
    }
  }
  return {
    id: o.id,
    parent: (o.parent as string | null | undefined) ?? null,
    status: o.status as ReplaySidecarTask["status"],
    title: o.title,
    created_at: o.created_at,
    done_at: (o.done_at as string | null | undefined) ?? null,
    reason: (o.reason as string | null | undefined) ?? null,
    started_at: (o.started_at as string | null | undefined) ?? null,
    last_resumed_at: (o.last_resumed_at as string | null | undefined) ?? null,
    active_ms: typeof o.active_ms === "number" ? o.active_ms : 0,
  }
}
