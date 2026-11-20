/**
 * Origins of the core system-prompt blocks.
 *
 * The system-prompt builders record, per block text, which core slot owns
 * which UTF-16 range of that text. A host (the verbose `--debug` request
 * dump) reads it back with {@link describeSystemBlock} to show where each
 * line of a system block came from. Data only: slot ids and offsets.
 *
 * The registry is keyed by the full block text, so many sessions in one
 * process do not collide. It holds at most {@link MAX_RECORDS} entries and
 * evicts the oldest. A block rewritten downstream (a lifecycle hook) has a
 * different text, so it reads back as `undefined`. A block that a provider
 * hook adds is recorded as slot `providerPreamble` with the provider id.
 *
 * @module llm/system-block-origins
 */

/** A core-owned slot of the system prompt. */
export type SystemSlotId =
  | "identity"
  | "instructions"
  | "toolOutputConventions"
  | "afterInstructions"
  | "sessionContext"
  /**
   * A block that a provider `resolveSystemPrompt` hook added (not a core
   * body block passed through). The span carries `providerId`.
   */
  | "providerPreamble"

/** One slot range inside a system block text. */
export interface SystemSlotSpan {
  /** The slot that owns the range. */
  readonly slot: SystemSlotId
  /** UTF-16 offset in the block text where the range starts. */
  readonly start: number
  /** UTF-16 offset where the range ends (exclusive). */
  readonly end: number
  /** True when a `SystemPromptOverrides` entry replaced the default text. */
  readonly overridden: boolean
  /** Provider id that added the block. Set only for slot `providerPreamble`. */
  readonly providerId?: string
}

/** Most block texts the registry keeps. */
const MAX_RECORDS = 16

/**
 * Most UTF-16 units of a block text the registry keeps as the map key.
 *
 * {@link MAX_RECORDS} bounds the record COUNT, not the bytes, and an
 * instructions block can be tens of KB. Nothing longer than this is retained:
 * the key is `"<length>:<prefix>"`, so two texts of different length still get
 * different keys, and the map stays near `MAX_RECORDS * MAX_KEY_CHARS` units.
 */
const MAX_KEY_CHARS = 4096

/** Distinct span sets kept per key, so a collision can be detected. */
const MAX_VARIANTS = 2

/**
 * One registry entry: the distinct span sets recorded for one key.
 *
 * Two blocks can carry equal text while belonging to different slots. Text is
 * the only lookup handle the exported API has, so the entry keeps both and
 * {@link describeSystemBlock} refuses to answer instead of answering wrongly.
 */
interface Entry {
  /** Up to {@link MAX_VARIANTS} distinct span sets, newest first. */
  readonly variants: ReadonlyArray<readonly SystemSlotSpan[]>
}

const records = new Map<string, Entry>()

/** Map key of one block text: bounded in size, distinct for distinct lengths. */
function keyOf(text: string): string {
  return `${text.length}:${text.length <= MAX_KEY_CHARS ? text : text.slice(0, MAX_KEY_CHARS)}`
}

/** True when two span lists describe the same slots and offsets. */
function sameSpans(a: readonly SystemSlotSpan[], b: readonly SystemSlotSpan[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.slot !== y.slot ||
      x.start !== y.start ||
      x.end !== y.end ||
      x.overridden !== y.overridden ||
      x.providerId !== y.providerId
    ) {
      return false
    }
  }
  return true
}

/**
 * Record the slot spans of one system block text. Internal to core: the
 * system-prompt builders call it. A repeat record of the same text and spans
 * moves the entry to the newest position without adding a variant.
 *
 * @param text - The full block text, as sent.
 * @param spans - The slot ranges inside `text`.
 */
export function recordSystemBlock(text: string, spans: readonly SystemSlotSpan[]): void {
  const key = keyOf(text)
  const previous = records.get(key)
  records.delete(key)
  const variants =
    previous === undefined
      ? [spans]
      : previous.variants.some((v) => sameSpans(v, spans))
        ? previous.variants
        : [spans, ...previous.variants].slice(0, MAX_VARIANTS)
  records.set(key, { variants })
  while (records.size > MAX_RECORDS) {
    const oldest = records.keys().next()
    if (oldest.done) break
    records.delete(oldest.value)
  }
}

/**
 * The slot spans recorded for a system block text.
 *
 * Returns `undefined` in three cases: core never recorded this text, the text
 * was rewritten downstream, or two different slots recorded the same text (a
 * text-only key cannot tell the two blocks apart, so no slot is claimed).
 *
 * @param text - The full block text, as sent.
 * @returns The spans, or `undefined` when the record is missing or ambiguous.
 */
export function describeSystemBlock(text: string): readonly SystemSlotSpan[] | undefined {
  const entry = records.get(keyOf(text))
  if (entry === undefined) return undefined
  return entry.variants.length === 1 ? entry.variants[0] : undefined
}
