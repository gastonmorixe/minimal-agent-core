/**
 * Canonical tool-lifecycle payload vocabulary shared by the SDK and plugin hooks.
 *
 * @module sdk/tool-lifecycle
 */

/** Severity of a {@link Finding}. Mirrors LSP's error/warning/info trio. */
export type FindingSeverity = "error" | "warning" | "info"

/**
 * One structured result attached at a source location. Deliberately generic:
 * a type error, lint violation, formatting deviation, or any future finding.
 */
export interface Finding {
  /** Producer id, e.g. `"tsgo"`, `"biome"`, `"oxlint"`. Free-form. */
  source: string
  severity: FindingSeverity
  /** 1-based line, when the finding has a location. */
  line?: number
  /** 1-based column, when the finding has a location. */
  col?: number
  /** Rule / diagnostic code, e.g. `"TS2322"`, `"eslint(no-debugger)"`. */
  code?: string
  /** Human-readable, single-line message. */
  message: string
  /** Absolute or repo-relative path, when it differs from the tool's file. */
  path?: string
  /** Finding scope, such as `"project"` or `"ad-hoc"`. */
  scope?: string
}

/**
 * Payload threaded through the post-tool lifecycle. The first fields are
 * invocation facts while `findings` and `notes` are mutable accumulators.
 */
export interface ToolDidInvokePayload {
  /** Tool name as dispatched, e.g. `"Edit"`, `"Write"`, `"Bash"`. */
  tool: string
  /** The parsed tool input (schema-shaped per tool). */
  input: Record<string, unknown>
  /** The agent's current working directory at invocation time. */
  cwd: string
  /** True when the tool succeeded (`!is_error`). */
  ok: boolean
  /** The file the tool mutated, when known (Edit/Write). Absent otherwise. */
  filePath?: string
  /** Structured results for the agent to render. Seeded empty. */
  findings: Finding[]
  /** Model-facing one-liners for the agent to annotate. Seeded empty. */
  notes: string[]
}

/** Read-only facts an emitter supplies to {@link makeToolDidInvokePayload}. */
export interface ToolDidInvokeSeed {
  tool: string
  input: Record<string, unknown>
  cwd: string
  ok: boolean
  filePath?: string
}

/** Build a post-tool payload with empty finding and note accumulators. */
export function makeToolDidInvokePayload(seed: ToolDidInvokeSeed): ToolDidInvokePayload {
  return {
    tool: seed.tool,
    input: seed.input,
    cwd: seed.cwd,
    ok: seed.ok,
    ...(seed.filePath !== undefined ? { filePath: seed.filePath } : {}),
    findings: [],
    notes: [],
  }
}

/**
 * Append a finding, dropping malformed entries so blank rows cannot enter the
 * result panel. Mutates the payload accumulator in place.
 */
export function addFinding(payload: ToolDidInvokePayload, finding: Finding): void {
  if (!finding || typeof finding.message !== "string" || finding.message.length === 0) return
  if (typeof finding.source !== "string" || finding.source.length === 0) return
  payload.findings.push(finding)
}

/** Append a non-empty model-facing note to the payload accumulator. */
export function addNote(payload: ToolDidInvokePayload, note: string): void {
  if (typeof note !== "string" || note.trim().length === 0) return
  payload.notes.push(note)
}
