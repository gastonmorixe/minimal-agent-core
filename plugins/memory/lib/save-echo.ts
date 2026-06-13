/**
 * Save-echo plumbing — closing the loop on "the model saved a memory but
 * doesn't know its id".
 *
 * Pipeline:
 *
 * ```
 *   inline-tag handler   ──emit("memory.saved")──►   global EventBus
 *           │                                              │
 *           │   tool handler (Phase 4)                     │
 *           │   ──emit("memory.saved")──────────►          │
 *           │                                              ▼
 *           │                                    SaveEchoCollector
 *           │                                              │
 *           │                              consumeAll() ──┘
 *           │                                              ▼
 *           │                              prepended to next user turn as
 *           │                              <ma::agent::memory-saved scope="…" id="…">…</ma::agent::memory-saved>
 * ```
 *
 * The agent owns one {@link SaveEchoCollector}. At the start of every
 * user message it constructs (initial + loop seams in `agent.ts`), it
 * calls `consumeAll()` and appends the resulting blocks AFTER the
 * `<mode-change>` attachment, BEFORE the user text. The model's very
 * next turn carries the id of every memory it just saved, so it can
 * later edit/remove by id without a separate `MemoryTool({action:"list"})`
 * round-trip.
 *
 * Why a bus event (not a return value) — the inline-tag handler is
 * invoked by the loader's stream-scanner, which runs DEEP inside the
 * agent's response stream. The handler has no path back to the agent's
 * message construction. The bus is the seam that already exists for
 * exactly this kind of cross-cutting plugin↔agent signal (see
 * `src/quota-broadcast.ts` for the established pattern).
 *
 * @module memory/lib/save-echo
 */

// ---------------------------------------------------------------------------
// Host structural slices (decoupling contract: import nothing from src/)
// ---------------------------------------------------------------------------

/**
 * LOCAL structural slice of the host's `ContentBlock` (source of truth:
 * `src/client/types.ts#TextBlock`). The collector only ever emits text
 * blocks, so the single-variant slice is sufficient; TypeScript's
 * structural typing makes the host's `ContentBlock` registry accept it
 * unchanged. Re-declared here so this module imports nothing from the
 * host repo (the Wave D decoupling contract).
 */
export interface AttachmentTextBlock {
  type: "text"
  text: string
}

/** Unsubscribe handle returned by {@link EventBusSlice.on}. */
export type Unsubscribe = () => void

/**
 * LOCAL structural slice of the host's `EventBus` (source of truth:
 * `src/plugins/event-bus.ts#EventBus`). Only the `on(event, listener)`
 * subscribe method is consumed here; the listener receives an
 * {@link EventContextSlice}. The real frozen host bus satisfies this at
 * runtime via structural typing.
 */
export interface EventBusSlice {
  on(event: string, listener: (ctx: EventContextSlice) => void): Unsubscribe
}

/** LOCAL structural slice of the host bus's listener invocation context. */
export interface EventContextSlice {
  readonly payload: unknown
}

/**
 * LOCAL structural slice of the host bus's emit side. The inline-tag save
 * handler fires `memory.saved` onto this so the {@link SaveEchoCollector}
 * (subscribed via {@link SaveEchoCollector.attach}) buffers it for the
 * next turn. The real host bus satisfies both this and {@link EventBusSlice}.
 */
export interface EmitBusSlice {
  emit(event: string, payload?: unknown): void
}

// ---------------------------------------------------------------------------
// Plugin-local bus pointer (replaces the old `src/global-bus.ts` singleton)
// ---------------------------------------------------------------------------

/**
 * Plugin-owned pointer to the host event bus, set by the save-echo
 * turn-attachment factory (`handlers/turn_attachment_save_echo.ts`) when
 * the host hands it `ctx.bus` at boot. The inline-tag save handler reads
 * it to emit `memory.saved`.
 *
 * Why this exists: a `TUIContext` carries no event bus and the
 * decoupling contract forbids importing `src/global-bus.ts`. In
 * production the host wires BOTH the collector AND this pointer from the
 * SAME `loader.bus()` (index.ts: `setGlobalEventBus(loader.bus())` ran
 * beside `instantiateTurnAttachments({ bus: loader.bus() })`), so the
 * emit and the subscription meet on one bus exactly as before. When no
 * bus was plumbed through (ad-hoc tests), the pointer is `null` and the
 * emit is a no-op — the save itself never depends on the echo.
 */
let saveBus: EmitBusSlice | null = null

/**
 * Set (or clear, with `null`) the plugin-local bus the inline-tag save
 * handler emits `memory.saved` on. Idempotent. Called by the save-echo
 * turn-attachment factory; tests call it directly to wire a fake bus.
 */
export function setSaveBus(bus: EmitBusSlice | null): void {
  saveBus = bus
}

/** Read the plugin-local emit bus, or `null` when none was wired. */
export function getSaveBus(): EmitBusSlice | null {
  return saveBus
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** Bus event name. Stable string — both the emitter and collector reference it. */
export const MEMORY_SAVED = "memory.saved"

/**
 * Payload shape for the `memory.saved` bus event.
 *
 * Emitted by:
 *   - the inline-tag handler (`<ma::emit::memory …>` save)
 *   - the tool handler's `add` action (Phase 4)
 *   - any future plugin that mutates a memory file
 *
 * `evicted` is the count of bullets that were evicted to make room
 * (short-term FIFO cap only — always 0 for global/project saves).
 */
export interface MemorySavedPayload {
  scope: "global" | "project" | "short-term"
  id: string
  /** Body, single line. Used to generate a short preview in the echo. */
  body: string
  /** Count of bullets evicted alongside this save. 0 unless short-term overflow. */
  evicted?: number
}

/**
 * Type guard. Accepts any `unknown` payload (the bus is loosely typed)
 * and narrows it to a {@link MemorySavedPayload} on a successful match.
 *
 * Strict: rejects unknown fields silently (we're forgiving) but
 * requires `scope`, `id`, and `body` to be the right primitive types.
 * A malformed event is dropped on the floor — the model never sees it.
 */
export function isMemorySavedPayload(p: unknown): p is MemorySavedPayload {
  if (p === null || typeof p !== "object") return false
  const o = p as Record<string, unknown>
  if (o.scope !== "global" && o.scope !== "project" && o.scope !== "short-term") return false
  if (typeof o.id !== "string" || o.id.length === 0) return false
  if (typeof o.body !== "string") return false
  if (o.evicted !== undefined && typeof o.evicted !== "number") return false
  return true
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/**
 * Buffers `memory.saved` events between turns. The agent drains via
 * {@link consumeAll} at the start of each user message.
 *
 * Lifecycle:
 *   - Construct via {@link SaveEchoCollector.attach}, passing the bus.
 *   - Agent calls {@link consumeAll} at every user-message boundary.
 *   - Process exit (or test teardown) calls {@link detach} to remove
 *     the bus listener so a re-attached collector doesn't double-fire.
 */
export class SaveEchoCollector {
  private queue: MemorySavedPayload[] = []
  private off: Unsubscribe | null = null

  // No explicit constructor: the default no-arg public constructor is
  // sufficient for both tests (manual `new SaveEchoCollector()`) and the
  // {@link attach} static factory used in production.

  /**
   * Subscribe to `memory.saved` on the given bus and start buffering
   * events until consumed. Returns the collector instance (chain-friendly).
   */
  static attach(bus: EventBusSlice): SaveEchoCollector {
    const c = new SaveEchoCollector()
    c.off = bus.on(MEMORY_SAVED, (ctx) => {
      if (isMemorySavedPayload(ctx.payload)) c.queue.push(ctx.payload)
    })
    return c
  }

  /**
   * Manually push a payload into the queue (without going through the
   * bus). Useful for tests and for any future tool handler that wants
   * a synchronous, deterministic emit. Production callers prefer the
   * bus path so other listeners (logger, audit) see the event too.
   */
  enqueue(p: MemorySavedPayload): void {
    this.queue.push(p)
  }

  /**
   * Drain the queue into {@link AttachmentTextBlock}[] (structurally a
   * host `ContentBlock[]`). Returns `[]` when empty so the caller can
   * splat into a list builder unconditionally.
   *
   * One block per queued payload, rendered as
   * `<ma::agent::memory-saved scope="…" id="…"[ evicted="N"]>preview</ma::agent::memory-saved>`.
   * Preview is the body trimmed to 60 chars with `…` ellipsis on overflow.
   */
  consumeAll(): AttachmentTextBlock[] {
    if (this.queue.length === 0) return []
    const out = this.queue.map((p) => ({
      type: "text" as const,
      text: renderEcho(p),
    }))
    this.queue = []
    return out
  }

  /** Drop the bus subscription. Safe to call multiple times. */
  detach(): void {
    this.off?.()
    this.off = null
    this.queue = []
  }

  /** Test introspection: peek at the queue without draining it. */
  pendingCount(): number {
    return this.queue.length
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 60

/**
 * Render a single payload to the inline `<ma::agent::memory-saved>` text the model
 * sees. Exported for tests; the collector uses this internally.
 */
export function renderEcho(p: MemorySavedPayload): string {
  const evicted = p.evicted && p.evicted > 0 ? ` evicted="${p.evicted}"` : ""
  // Single-line preview. The body is already collapsed-to-one-line by
  // the store's `formatBullet`, but defensively normalize whitespace
  // here too in case a tool emits an event without round-tripping
  // through the store.
  const oneLine = p.body.replace(/\s+/g, " ").trim()
  const preview = oneLine.length > PREVIEW_MAX ? `${oneLine.slice(0, PREVIEW_MAX - 1)}…` : oneLine
  // Escape `<` and `>` in the preview so it can't be mis-parsed as a
  // child tag inside `<ma::agent::memory-saved>…</ma::agent::memory-saved>`. We don't bother
  // with `&` (would have to escape only those that aren't already part
  // of a valid entity, which is fiddly) — the model handles `&` in
  // body text without tag-syntax confusion.
  const safe = preview.replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return `<ma::agent::memory-saved scope="${p.scope}" id="${escapeAttr(p.id)}"${evicted}>${safe}</ma::agent::memory-saved>`
}

/** Escape `"` and `&` in an attribute value. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}
