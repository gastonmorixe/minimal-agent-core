/**
 * Declarative config schema.
 *
 * One source of truth for every field the `/config` overlay can edit. The
 * schema is pure DATA — no host imports, no I/O. The model, FSM, renderer,
 * and the JSONC writer all read from it, so adding a new knob is a
 * one-entry change here (plus, for a real effect, the matching reader in
 * `src/config.ts`, which the agent owns).
 *
 * Mirrors `UserConfig` in `src/config.ts`. Kept in lockstep by hand: this
 * is the user-facing editing surface, the host type is the parsing
 * contract. A field present here but unknown to the host is simply ignored
 * by the loader (the host parser drops unknown keys), so drift degrades
 * gracefully rather than breaking.
 *
 * @module config/lib/schema
 */

/** The widget used to edit a field's value. */
export type FieldKind =
  | "enum" // pick one of `choices`
  | "boolean" // tri-state: true / false / unset
  | "string" // free text (edited in the prompt buffer)
  | "string-list" // comma/space-separated free text → string[]
  | "number" // integer entered as text

/** One editable field. */
export interface Field {
  /** Stable id, unique in the schema. Also the slug shown in the list. */
  id: string
  /** Short label rendered in the list. */
  label: string
  /** One-line help shown under the selected row. */
  help: string
  /** Editing widget. */
  kind: FieldKind
  /**
   * The object key path into `config.jsonc` this field reads/writes.
   * e.g. `["effort"]` or `["statusBar", "segments"]`.
   */
  path: string[]
  /** For `enum`: the allowed values, in display order. */
  choices?: string[]
  /**
   * What the agent's built-in default is when the key is absent, shown as
   * a dim hint. Purely cosmetic; never written unless the user picks it.
   */
  defaultHint?: string
  /** Section grouping for the list header. */
  section: string
}

/**
 * The full schema. Order here is the display order within each section.
 * Sections render in first-seen order.
 */
export const SCHEMA: Field[] = [
  // ── Model & reasoning ────────────────────────────────────────────────
  {
    id: "model",
    label: "model",
    help: "Model id sent on the wire, e.g. claude-opus-4-8[1m]. Empty = CLI/default.",
    kind: "string",
    path: ["model"],
    section: "Model & reasoning",
    defaultHint: "(cli/env/default)",
  },
  {
    id: "effort",
    label: "effort",
    help: "Reasoning effort. The server validates; common: low/medium/high/max.",
    kind: "enum",
    path: ["effort"],
    choices: ["low", "medium", "high", "xhigh", "max"],
    section: "Model & reasoning",
    defaultHint: "high",
  },
  {
    id: "thinkingDisplay",
    label: "thinkingDisplay",
    help: "summarized = stream plaintext thinking; omitted = signatures only.",
    kind: "enum",
    path: ["thinkingDisplay"],
    choices: ["summarized", "omitted"],
    section: "Model & reasoning",
    defaultHint: "(provider default)",
  },

  // ── Session behavior ─────────────────────────────────────────────────
  {
    id: "mode",
    label: "mode",
    help: "Initial mode id (e.g. ask). Use 'none' to force no mode.",
    kind: "string",
    path: ["mode"],
    section: "Session behavior",
    defaultHint: "(plugin default)",
  },
  {
    id: "autoAsk",
    label: "autoAsk",
    help: "Auto-flip into ASK mode on confident questions. Unset = on.",
    kind: "boolean",
    path: ["autoAsk"],
    section: "Session behavior",
    defaultHint: "on",
  },
  {
    id: "skipQuota",
    label: "skipQuota",
    help: "Skip the startup quota check.",
    kind: "boolean",
    path: ["skipQuota"],
    section: "Session behavior",
    defaultHint: "off",
  },
  {
    id: "header",
    label: "header",
    help: "Show the startup tree (banner + rows). Unset = auto by session kind.",
    kind: "boolean",
    path: ["header"],
    section: "Session behavior",
    defaultHint: "(auto)",
  },

  // ── Terminal & rendering ─────────────────────────────────────────────
  {
    id: "spinner",
    label: "spinner",
    help: "Spinner preset name for the activity row.",
    kind: "string",
    path: ["spinner"],
    section: "Terminal & rendering",
    defaultHint: "(default)",
  },
  {
    id: "formatter",
    label: "formatter",
    help: "Formatter executable/command (overrides auto-resolved mdstream).",
    kind: "string",
    path: ["formatter"],
    section: "Terminal & rendering",
    defaultHint: "(auto mdstream)",
  },
  {
    id: "formatterArgs",
    label: "formatterArgs",
    help: "Extra args appended to the formatter, e.g. --table-fit. Space/comma list.",
    kind: "string-list",
    path: ["formatterArgs"],
    section: "Terminal & rendering",
    defaultHint: "(none)",
  },
  {
    id: "nerdGlyphCells",
    label: "nerdGlyphCells",
    help: "PUA glyph cell width for the spinner gap: 1, 2, or auto.",
    kind: "enum",
    path: ["nerdGlyphCells"],
    choices: ["auto", "1", "2"],
    section: "Terminal & rendering",
    defaultHint: "auto",
  },
  {
    id: "statusBarSegments",
    label: "statusBar.segments",
    help: "Ordered footer segments: quota, context, model, sid. Space/comma list.",
    kind: "string-list",
    path: ["statusBar", "segments"],
    section: "Terminal & rendering",
    defaultHint: "quota context model sid",
  },
]

/** Look up a field by id. */
export function fieldById(id: string): Field | undefined {
  return SCHEMA.find((f) => f.id === id)
}

/** Distinct sections, in first-seen order. */
export function sections(): string[] {
  const seen: string[] = []
  for (const f of SCHEMA) if (!seen.includes(f.section)) seen.push(f.section)
  return seen
}
