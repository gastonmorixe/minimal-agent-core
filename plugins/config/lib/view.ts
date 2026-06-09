/**
 * View-model bridge.
 *
 * Pure functions that derive the FSM's {@link Row} list and the renderer's
 * {@link RenderModel} from a {@link ConfigModel} + FSM {@link State}. Keeping
 * this glue here (rather than in the handlers) means the handlers stay a thin
 * imperative shell and the projection is independently testable.
 *
 * @module config/lib/view
 */

import type { Row, State } from "./fsm.ts"
import type { ConfigModel, FieldValue } from "./model.ts"
import { UNSET } from "./model.ts"
import type { RenderModel, RenderRow } from "./render.ts"
import type { Field } from "./schema.ts"

/** The three trailing action rows, in order. */
export const ACTION_ROWS: Row[] = [
  { type: "action", action: "save" },
  { type: "action", action: "revert" },
  { type: "action", action: "close" },
]

/** Resolve a field's EFFECTIVE value (staged if pending, else on-disk). */
export function effectiveValue(v: FieldValue): unknown {
  if (v.staged === undefined) return v.current
  return v.staged === UNSET ? undefined : v.staged
}

/**
 * The selectable rows the FSM navigates: one per field (in model order),
 * then the action rows. Section headers are NOT selectable, so they're not
 * here (the renderer interleaves them separately).
 */
export function fsmRows(model: ConfigModel): Row[] {
  const fieldRows: Row[] = model.values().map((v) => {
    const row: Row = {
      type: "field",
      fieldId: v.field.id,
      fieldKind: v.field.kind,
      effective: effectiveValue(v),
    }
    if (v.field.choices) row.choices = v.field.choices
    return row
  })
  return [...fieldRows, ...ACTION_ROWS]
}

/** Pretty-print an effective value for the list (never edit form). */
export function formatValue(field: Field, value: unknown): { text: string; unset: boolean } {
  if (value === undefined || value === null) {
    return { text: field.defaultHint ? `unset → ${field.defaultHint}` : "unset", unset: true }
  }
  if (typeof value === "boolean") return { text: value ? "true" : "false", unset: false }
  if (Array.isArray(value)) {
    return { text: value.length === 0 ? "[]" : value.join(", "), unset: false }
  }
  return { text: String(value), unset: false }
}

/** Affordance hint for a field row (how it's edited). */
function affordanceFor(field: Field): string {
  switch (field.kind) {
    case "enum":
    case "boolean":
      return "←/→ change"
    default:
      return "⏎ edit"
  }
}

/**
 * Build the renderer's model. Interleaves section headers, maps the FSM's
 * selectable index to the renderer's selectable index (they share the same
 * field-then-action ordering), and threads phase + dirty count.
 */
export function renderModel(
  model: ConfigModel,
  state: Extract<State, { kind: "open" }>,
  cols: number,
  maxRows: number,
): RenderModel {
  const values = model.values()
  const rows: RenderRow[] = []
  let lastSection = ""
  for (const v of values) {
    if (v.field.section !== lastSection) {
      lastSection = v.field.section
      rows.push({ type: "section", label: v.field.section })
    }
    const eff = effectiveValue(v)
    const { text, unset } = formatValue(v.field, eff)
    rows.push({
      type: "field",
      label: v.field.label,
      valueText: text,
      dirty: v.dirty,
      unset,
      affordance: affordanceFor(v.field),
    })
  }
  // Action rows (no section header).
  rows.push({ type: "action", label: "Save changes", tone: "save" })
  rows.push({ type: "action", label: "Revert all", tone: "revert" })
  rows.push({ type: "action", label: "Close", tone: "close" })

  // Phase projection: surface the selected field's label when editing.
  let phase: RenderModel["phase"] = { kind: "browse" }
  if (state.phase.kind === "edit") {
    const editFieldId = state.phase.fieldId
    const f = model.fieldList().find((x) => x.id === editFieldId)
    phase = { kind: "edit", label: f?.label ?? "", draft: state.phase.draft }
  }

  return {
    path: model.path,
    rows,
    selectedSelectableIndex: state.selectedIndex,
    dirtyCount: model.dirtyCount(),
    phase,
    error: model.error,
    cols,
    maxRows,
  }
}
