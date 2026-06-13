/**
 * Pure overlay state machine for the `/config` interactive editor.
 *
 * # Design
 *
 * Functional core / imperative shell. This module is the core: no I/O, no
 * globals, no clocks, no host imports. The handlers (`handlers/on_key.ts`,
 * `handlers/on_buffer_changed.ts`, `handlers/cmd_config.ts`) are the shell —
 * they observe the editor + own the {@link ConfigModel}, call
 * `transition()`, and apply the returned {@link Effect}s.
 *
 * # Modal input ownership (no shared prompt buffer)
 *
 * `/config` opens as a MODAL overlay: it emits `editor.overlay.open` so the
 * host hides the prompt row + cursor and routes EVERY key — including
 * printable characters and Backspace — through the `editor.key` hook. So the
 * FSM owns its own text input; it never shares the editor's prompt buffer
 * (that sharing was the old bug where the typed value appeared in both the
 * prompt AND the field). Two phases:
 *
 *   - **browse**: nav keys move the selection, cycle enum/boolean values in
 *     place, and activate the action rows (save / revert / close).
 *   - **edit**: entered for free-text fields (string / list / number). The
 *     FSM seeds `phase.draft` with the current value; printable chars append
 *     to the draft, Backspace trims it, Enter confirms, Esc cancels. The
 *     draft lives ONLY in FSM state and is rendered inline in the overlay.
 *
 * # Effects, not pixels
 *
 * Unlike the slash-menu FSM (which emits ready-made footer lines), this FSM
 * emits SEMANTIC effects (`stage-set`, `save`, `repaint`, …). The shell owns
 * the stateful {@link ConfigModel}, applies the effects, then re-renders
 * from the post-mutation model. Keeping `transition` free of the model's
 * mutation keeps it pure and exhaustively testable.
 *
 * @module config/lib/fsm
 */

import type { FieldKind } from "./schema.ts"

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Editing phase while the overlay is open. */
export type Phase =
  | { kind: "browse" }
  | { kind: "edit"; fieldId: string; fieldKind: FieldKind; draft: string }

export type State =
  | { readonly kind: "closed" }
  | {
      readonly kind: "open"
      readonly selectedIndex: number
      readonly scrollOffset: number
      readonly phase: Phase
    }

export const CLOSED: State = { kind: "closed" }

// ---------------------------------------------------------------------------
// Events (driven by the shell)
// ---------------------------------------------------------------------------

export type KeyName =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Enter"
  | "Escape"
  | "Tab"
  | "Backspace"

export type Event =
  | { kind: "open" }
  | { kind: "key"; name: KeyName }
  /** A printable character typed while editing a free-text field. */
  | { kind: "char"; ch: string }
  /**
   * @deprecated Legacy: a full-buffer replacement from the old shared-prompt
   * input path. The modal overlay drives edits via `char` / `Backspace`
   * instead. Kept so older callers/tests don't break; sets the draft whole.
   */
  | { kind: "buffer"; text: string }
  | { kind: "close" }

// ---------------------------------------------------------------------------
// Row snapshot (what the shell tells the core about the current list)
// ---------------------------------------------------------------------------

export interface FieldRow {
  type: "field"
  fieldId: string
  fieldKind: FieldKind
  choices?: string[]
  /** Currently-shown value (staged if pending, else on-disk). */
  effective: unknown
}

export interface ActionRow {
  type: "action"
  action: "save" | "revert" | "close"
}

export type Row = FieldRow | ActionRow

export interface TransitionCtx {
  /** Every navigable row, in display order (fields then action rows). */
  rows: readonly Row[]
}

// ---------------------------------------------------------------------------
// Effects (applied by the shell)
// ---------------------------------------------------------------------------

export type Effect =
  | { kind: "halt" } // swallow the key (don't let the editor handle it)
  | { kind: "repaint" } // shell re-renders from model + state and paints footer
  | { kind: "close" } // shell clears footer + resets buffer
  | { kind: "set-buffer"; text: string } // prime / clear the editor buffer
  | { kind: "stage-set"; fieldId: string; value: unknown }
  | { kind: "stage-clear"; fieldId: string }
  | { kind: "revert-all" } // drop every staged edit
  | { kind: "save" } // model.save() + scrollback confirmation

export interface TransitionResult {
  state: State
  effects: Effect[]
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Apply one event to the FSM. Pure: same inputs → same output.
 */
export function transition(state: State, event: Event, ctx: TransitionCtx): TransitionResult {
  switch (event.kind) {
    case "open":
      return { state: openState(), effects: [{ kind: "repaint" }] }
    case "close":
      return { state: CLOSED, effects: [{ kind: "close" }] }
    case "key":
      return onKey(state, event.name, ctx)
    case "char":
      return onChar(state, event.ch)
    case "buffer":
      return onBuffer(state, event.text)
    default: {
      throw new Error(`unhandled event: ${JSON.stringify(event satisfies never)}`)
    }
  }
}

function openState(): Extract<State, { kind: "open" }> {
  return { kind: "open", selectedIndex: 0, scrollOffset: 0, phase: { kind: "browse" } }
}

// ---------------------------------------------------------------------------
// key handling
// ---------------------------------------------------------------------------

function onKey(state: State, key: KeyName, ctx: TransitionCtx): TransitionResult {
  if (state.kind !== "open") return { state, effects: [] }
  return state.phase.kind === "edit"
    ? onKeyEdit(state, state.phase, key)
    : onKeyBrowse(state, key, ctx)
}

function onKeyBrowse(
  state: Extract<State, { kind: "open" }>,
  key: KeyName,
  ctx: TransitionCtx,
): TransitionResult {
  const rows = ctx.rows
  const count = rows.length
  if (count === 0) {
    if (key === "Escape") return { state: CLOSED, effects: [{ kind: "close" }, { kind: "halt" }] }
    return { state, effects: [] }
  }
  const sel = clamp(state.selectedIndex, 0, count - 1)

  switch (key) {
    case "ArrowDown": {
      const next = { ...state, selectedIndex: clamp(sel + 1, 0, count - 1) }
      return { state: next, effects: [{ kind: "repaint" }, { kind: "halt" }] }
    }
    case "ArrowUp": {
      const next = { ...state, selectedIndex: clamp(sel - 1, 0, count - 1) }
      return { state: next, effects: [{ kind: "repaint" }, { kind: "halt" }] }
    }
    case "ArrowRight":
      return activateOrCycle(state, rows[sel], 1, false)
    case "ArrowLeft":
      return activateOrCycle(state, rows[sel], -1, false)
    case "Enter":
    case "Tab":
      return activateOrCycle(state, rows[sel], 1, true)
    case "Escape":
      return { state: CLOSED, effects: [{ kind: "close" }, { kind: "halt" }] }
    case "Backspace":
      // No text field active; swallow so it can't reach the hidden prompt.
      return { state, effects: [{ kind: "halt" }] }
    default: {
      throw new Error(`unhandled key: ${JSON.stringify(key satisfies never)}`)
    }
  }
}

/**
 * In browse: cycle an enum/boolean field, enter edit mode for a free-text
 * field, or perform an action row.
 *
 * @param state - The open-config FSM state being acted on.
 * @param row - The currently-selected row (undefined for an empty list).
 * @param dir - cycle direction (Right/Enter = +1, Left = -1).
 * @param enter - true for an Enter/Tab press (vs Left/Right).
 */
function activateOrCycle(
  state: Extract<State, { kind: "open" }>,
  row: Row | undefined,
  dir: 1 | -1,
  enter: boolean,
): TransitionResult {
  if (!row) return { state, effects: [{ kind: "halt" }] }

  if (row.type === "action") {
    // Left/Right on an action row does nothing; only Enter/Tab fire it.
    if (!enter) return { state, effects: [{ kind: "halt" }] }
    switch (row.action) {
      case "save":
        return { state, effects: [{ kind: "save" }, { kind: "repaint" }, { kind: "halt" }] }
      case "revert":
        return { state, effects: [{ kind: "revert-all" }, { kind: "repaint" }, { kind: "halt" }] }
      case "close":
        return { state: CLOSED, effects: [{ kind: "close" }, { kind: "halt" }] }
      default: {
        throw new Error(`unhandled action: ${JSON.stringify(row.action satisfies never)}`)
      }
    }
  }

  // Field row.
  switch (row.fieldKind) {
    case "enum": {
      const eff = cycleEnum(row.fieldId, row.choices ?? [], row.effective, dir)
      return { state, effects: [eff, { kind: "repaint" }, { kind: "halt" }] }
    }
    case "boolean": {
      const eff = cycleBoolean(row.fieldId, row.effective, dir)
      return { state, effects: [eff, { kind: "repaint" }, { kind: "halt" }] }
    }
    case "string":
    case "string-list":
    case "number": {
      if (!enter) return { state, effects: [{ kind: "halt" }] } // Left/Right no-op on text fields
      // Seed the draft with the current value. No prompt-buffer prime — the
      // overlay owns input; printables now arrive as `char` events and the
      // draft is rendered inline. The cursor starts at end-of-draft.
      const draft = valueToDraft(row.fieldKind, row.effective)
      const next: State = {
        ...state,
        phase: { kind: "edit", fieldId: row.fieldId, fieldKind: row.fieldKind, draft },
      }
      return { state: next, effects: [{ kind: "repaint" }, { kind: "halt" }] }
    }
    default: {
      throw new Error(`unhandled field kind: ${JSON.stringify(row.fieldKind satisfies never)}`)
    }
  }
}

function onKeyEdit(
  state: Extract<State, { kind: "open" }>,
  phase: Extract<Phase, { kind: "edit" }>,
  key: KeyName,
): TransitionResult {
  switch (key) {
    case "Enter":
    case "Tab": {
      // Commit the draft. Empty → clear the key; else parse per kind.
      const commit = draftToEffect(phase.fieldId, phase.fieldKind, phase.draft)
      const next: State = { ...state, phase: { kind: "browse" } }
      return { state: next, effects: [commit, { kind: "repaint" }, { kind: "halt" }] }
    }
    case "Escape": {
      // Cancel edit, discard draft, back to browse.
      const next: State = { ...state, phase: { kind: "browse" } }
      return { state: next, effects: [{ kind: "repaint" }, { kind: "halt" }] }
    }
    case "Backspace": {
      // Trim one char off the draft (the overlay owns input; no prompt buffer).
      const draft = phase.draft.length > 0 ? phase.draft.slice(0, -1) : ""
      const next: State = { ...state, phase: { ...phase, draft } }
      return { state: next, effects: [{ kind: "repaint" }, { kind: "halt" }] }
    }
    // Up/Down are swallowed in edit mode so they don't trigger history /
    // queue-nav while the overlay is modal. Left/Right are also swallowed
    // (cursor-in-draft movement isn't supported yet; better to halt than to
    // leak the key to the hidden prompt).
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
      return { state, effects: [{ kind: "halt" }] }
    default: {
      throw new Error(`unhandled key: ${JSON.stringify(key satisfies never)}`)
    }
  }
}

/**
 * A printable character while editing: append to the draft. In browse phase
 * (or closed) it's swallowed by the shell before reaching here, so this only
 * fires in edit phase. Halts so the char never reaches the hidden prompt.
 */
function onChar(state: State, ch: string): TransitionResult {
  if (state.kind !== "open" || state.phase.kind !== "edit") {
    return { state, effects: [{ kind: "halt" }] }
  }
  const draft = state.phase.draft + ch
  const next: State = { ...state, phase: { ...state.phase, draft } }
  return { state: next, effects: [{ kind: "repaint" }, { kind: "halt" }] }
}

// ---------------------------------------------------------------------------
// buffer handling (edit-phase live draft)
// ---------------------------------------------------------------------------

function onBuffer(state: State, text: string): TransitionResult {
  if (state.kind !== "open" || state.phase.kind !== "edit") {
    // Browse phase: ignore stray buffer changes (the prompt stays empty by
    // convention; if a user types, the editor shows it and they can clear
    // it — we don't fight them, and we don't act on it).
    return { state, effects: [] }
  }
  const next: State = { ...state, phase: { ...state.phase, draft: text } }
  return { state: next, effects: [{ kind: "repaint" }] }
}

// ---------------------------------------------------------------------------
// Value cycling + draft (de)serialization — pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Cycle an enum through `[unset, ...choices]`. */
export function cycleEnum(
  fieldId: string,
  choices: string[],
  effective: unknown,
  dir: 1 | -1,
): Effect {
  const seq: (string | undefined)[] = [undefined, ...choices]
  let idx = seq.findIndex((v) => v === effective)
  if (idx < 0) idx = 0
  idx = (idx + dir + seq.length) % seq.length
  const nextV = seq[idx]
  return nextV === undefined
    ? { kind: "stage-clear", fieldId }
    : { kind: "stage-set", fieldId, value: nextV }
}

/** Cycle a boolean through `[unset, true, false]`. */
export function cycleBoolean(fieldId: string, effective: unknown, dir: 1 | -1): Effect {
  const seq: (boolean | undefined)[] = [undefined, true, false]
  let idx = seq.findIndex((v) => v === effective)
  if (idx < 0) idx = 0
  idx = (idx + dir + seq.length) % seq.length
  const nextV = seq[idx]
  return nextV === undefined
    ? { kind: "stage-clear", fieldId }
    : { kind: "stage-set", fieldId, value: nextV }
}

/** Serialize a field value into the editable draft text. */
export function valueToDraft(kind: FieldKind, value: unknown): string {
  if (value === undefined || value === null) return ""
  if (kind === "string-list") {
    return Array.isArray(value) ? value.join(", ") : String(value)
  }
  return String(value)
}

/** Parse a committed draft into a stage effect (clear when empty). */
export function draftToEffect(fieldId: string, kind: FieldKind, draft: string): Effect {
  const trimmed = draft.trim()
  if (trimmed.length === 0) return { kind: "stage-clear", fieldId }
  switch (kind) {
    case "string-list": {
      const parts = trimmed
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      return parts.length === 0
        ? { kind: "stage-clear", fieldId }
        : { kind: "stage-set", fieldId, value: parts }
    }
    case "number": {
      const n = Number.parseInt(trimmed, 10)
      return Number.isFinite(n)
        ? { kind: "stage-set", fieldId, value: n }
        : { kind: "stage-clear", fieldId }
    }
    default:
      return { kind: "stage-set", fieldId, value: trimmed }
  }
}

// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
