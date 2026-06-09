/**
 * Tool-lifecycle hook payload contract — the GENERIC seam plugins attach to.
 *
 * The agent emits {@link ToolDidInvokePayload} on the `tool.didInvoke` chain
 * channel right after a tool returns, BEFORE rendering the result and pushing
 * it to the model. Plugins (the `diagnostics` plugin is the first consumer, but
 * the shape is deliberately tool-agnostic) receive the payload, may run their
 * own work, and push entries into the two accumulators:
 *
 *  - {@link ToolDidInvokePayload.findings}: STRUCTURED results the AGENT renders
 *    into its own gutter/palette chrome (the agent owns the TUI; plugins provide
 *    data — never pre-rendered ANSI).
 *  - {@link ToolDidInvokePayload.notes}: model-facing one-liners the agent wraps
 *    in a `<ma::agent::diagnostics>` annotation on the `tool_result` content.
 *
 * Why a chain (not broadcast): a chain lets the emitter read the mutated payload
 * back synchronously after all listeners ran, which is exactly "let plugins
 * augment this tool result, then I render the union." Listener errors/timeouts
 * are absorbed by the bus, so a misbehaving plugin can never break the tool loop.
 *
 * This module has ZERO dependencies on agent or plugin internals: it is a pure
 * data contract + tiny guard helpers, unit-testable in isolation. Both the agent
 * (emitter) and any plugin (listener) agree on it structurally.
 *
 * @module plugins/hooks/tool-lifecycle
 */

/** Severity of a {@link Finding}. Mirrors LSP's error/warning/info trio. */
export type FindingSeverity = "error" | "warning" | "info"

/**
 * One structured result a plugin attached at a source location. Deliberately
 * generic ("a tool found something somewhere"): a type error, a lint violation,
 * a formatting deviation, or anything a future plugin wants the agent to render.
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
}

/**
 * Payload threaded on the `tool.didInvoke` chain. The first six fields are
 * read-only facts the agent fills; `findings` and `notes` are the accumulators
 * plugins push into and the agent reads back after the chain settles.
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

/**
 * Build a payload with empty accumulators. The agent calls this immediately
 * before `emitChain("tool.didInvoke", payload)`.
 */
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
 * Append a {@link Finding}, dropping malformed entries (empty message or
 * missing source) so a sloppy plugin can't inject blank rows into the panel.
 * Mutates `payload.findings` in place (the chain threads one payload object).
 */
export function addFinding(payload: ToolDidInvokePayload, finding: Finding): void {
  if (!finding || typeof finding.message !== "string" || finding.message.length === 0) return
  if (typeof finding.source !== "string" || finding.source.length === 0) return
  payload.findings.push(finding)
}

/**
 * Append a model-facing note, dropping empty strings. Mutates `payload.notes`
 * in place.
 */
export function addNote(payload: ToolDidInvokePayload, note: string): void {
  if (typeof note !== "string" || note.trim().length === 0) return
  payload.notes.push(note)
}
