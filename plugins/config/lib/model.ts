/**
 * Config model — the editable state behind the `/config` overlay.
 *
 * Responsibilities:
 *   - Read the current `config.jsonc` text + parse it to a value map.
 *   - Resolve each schema field's CURRENT value (or "unset").
 *   - Stage in-memory edits (set / clear a field) without touching disk.
 *   - Produce the NEW jsonc text on save, applying every staged edit through
 *     the comment-preserving editor, and write it back via an injected sink.
 *
 * Pure-ish: all I/O goes through injected `FsDeps`, so the model is fully
 * unit-testable with an in-memory fake and has zero host coupling. The
 * handler layer wires `FsDeps` to real `node:fs` + the resolved config path.
 *
 * @module config/lib/model
 */

import { removeKeyPath, setKeyPath } from "./jsonc-edit.ts"
import { parseJsonc } from "./mini-jsonc.ts"
import { type Field, SCHEMA } from "./schema.ts"

/** Injected filesystem surface (keeps the model host-free + testable). */
export interface FsDeps {
  /** Absolute path of the config file (may not exist yet). */
  path: string
  /** Read the file, or null when absent/unreadable. */
  read(): string | null
  /** Write the full file text. */
  write(text: string): void
}

/** Options for {@link ConfigModel.load}. */
export interface ModelOptions {
  /**
   * The field list to edit. Defaults to the static {@link SCHEMA}; the
   * handler passes `[...SCHEMA, ...pluginFields(...)]` so discovered-plugin
   * toggles edit through the same machinery.
   */
  fields?: Field[]
}

/** A field's resolved value for display + editing. */
export interface FieldValue {
  field: Field
  /** Parsed current value, or `undefined` when the key is unset. */
  current: unknown
  /** Staged value: `undefined` = no pending edit; sentinel `UNSET` = clear. */
  staged: unknown
  /** True when a pending edit differs from `current`. */
  dirty: boolean
}

/** Sentinel meaning "stage a removal of this key". */
export const UNSET: unique symbol = Symbol("config.unset")

/** Read a nested key path out of a parsed value map. */
function readPath(root: unknown, path: string[]): unknown {
  let cur = root
  for (const seg of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * Holds the loaded document + staged edits. One instance per overlay open.
 */
export class ConfigModel {
  private text: string
  private parsed: Record<string, unknown>
  /** fieldId → staged value (or UNSET sentinel). */
  private readonly stage = new Map<string, unknown>()
  private parseError: string | null = null
  /** The fields this model edits (static schema + dynamic plugin toggles). */
  private readonly fields: Field[]

  private constructor(
    private readonly deps: FsDeps,
    text: string,
    fields: Field[],
  ) {
    this.fields = fields
    this.text = text
    this.parsed = {}
    try {
      const v = text.trim().length === 0 ? {} : parseJsonc(text)
      if (v && typeof v === "object" && !Array.isArray(v)) {
        this.parsed = v as Record<string, unknown>
      } else if (text.trim().length > 0) {
        this.parseError = "config root is not an object"
      }
    } catch (e) {
      this.parseError = e instanceof Error ? e.message : String(e)
    }
  }

  /** Load the model from disk (or an empty doc when the file is absent). */
  static load(deps: FsDeps, opts: ModelOptions = {}): ConfigModel {
    const raw = deps.read()
    return new ConfigModel(deps, raw ?? "", opts.fields ?? SCHEMA)
  }

  /** The fields this model edits, in display order. */
  fieldList(): readonly Field[] {
    return this.fields
  }

  /** Absolute config path (for display). */
  get path(): string {
    return this.deps.path
  }

  /** Non-null when the on-disk file failed to parse (editing is blocked). */
  get error(): string | null {
    return this.parseError
  }

  /** Resolve one field's display + edit state. */
  value(field: Field): FieldValue {
    const current = readPath(this.parsed, field.path)
    const staged = this.stage.get(field.id)
    const hasStage = this.stage.has(field.id)
    const dirty = hasStage && !sameValue(stagedToConcrete(staged), current)
    return {
      field,
      current,
      staged: hasStage ? staged : undefined,
      dirty,
    }
  }

  /** All field values in display order. */
  values(): FieldValue[] {
    return this.fields.map((f) => this.value(f))
  }

  /** Number of staged edits that actually differ from disk. */
  dirtyCount(): number {
    return this.values().filter((v) => v.dirty).length
  }

  /** Stage a concrete value for a field (replaces any prior stage). */
  set(fieldId: string, value: unknown): void {
    this.stage.set(fieldId, value)
  }

  /** Stage a removal (clear) of a field's key. */
  clear(fieldId: string): void {
    this.stage.set(fieldId, UNSET)
  }

  /** Drop a field's staged edit (revert to disk value). */
  revert(fieldId: string): void {
    this.stage.delete(fieldId)
  }

  /** Discard every staged edit. */
  revertAll(): void {
    this.stage.clear()
  }

  /**
   * Apply all staged edits to the document text and write it to disk.
   * Returns the new text. Throws if the document can't be edited (e.g. a
   * parse error on load) — callers surface this as an error notice.
   */
  save(): string {
    if (this.parseError) {
      throw new Error(`cannot save: config file has a parse error (${this.parseError})`)
    }
    let next = this.text
    for (const f of this.fields) {
      if (!this.stage.has(f.id)) continue
      const staged = this.stage.get(f.id)
      if (staged === UNSET) {
        next = removeKeyPath(next, f.path)
      } else {
        next = setKeyPath(next, f.path, staged)
      }
    }
    // Ensure a trailing newline (POSIX-friendly).
    if (!next.endsWith("\n")) next += "\n"
    this.deps.write(next)
    // Reload our in-memory view so a subsequent save is a no-op.
    this.text = next
    this.parsed = ((): Record<string, unknown> => {
      try {
        const v = parseJsonc(next)
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
      } catch {
        return {}
      }
    })()
    this.stage.clear()
    return next
  }
}

/** Convert a staged sentinel/value into the concrete value (UNSET → undefined). */
function stagedToConcrete(staged: unknown): unknown {
  return staged === UNSET ? undefined : staged
}

/** Structural equality good enough for config scalars + string lists. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => x === b[i])
  }
  return false
}
