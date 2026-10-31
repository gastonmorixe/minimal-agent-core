/**
 * Presentation ports for the tool transcript.
 *
 * The engine (`agent/tool-round.ts`) decides WHAT to show for a tool call:
 * the header, the body preview, the stream rows, refusals, and the
 * diagnostics panel. A host decides HOW those rows look. A host gives a
 * {@link ToolTranscriptFormatter} to style the rows (frames, colors, soft
 * splits). When the host gives none, core uses its plain-text default
 * (`./plain-tool-transcript.ts`): no ANSI and no code highlight.
 *
 * Hosts import these types from `@minimal-agent/core/host-kit/tool-executor-adapter`.
 *
 * The rows never reach the model. Model-facing text (annotations, the
 * diagnostics block) stays in the engine.
 *
 * @module agent/tool-transcript-port
 */

import type { ToolUseBlock } from "../llm/messages.ts"
import type { Finding } from "../sdk/tool-lifecycle.ts"
import type { TruncationInfo } from "../tools/truncation.ts"

/** One code-highlight request: the source text and its language id. */
export interface CodeHighlightRequest {
  language: string
  code: string
}

/** Semantic colors accepted by the unified-diff highlight mode. */
export interface UnifiedDiffColors {
  inserted?: string
  deleted?: string
}

/** Mixed syntax + unified-diff highlight request. */
export interface UnifiedDiffHighlightRequest extends CodeHighlightRequest {
  colors?: UnifiedDiffColors
  diffStyle?: "marker-fg" | "bg-wash"
}

/**
 * Fail-closed port for presentation-only tool-output highlighting. The
 * host owns the implementation. Each method returns `null` on any failure,
 * so the plain render stays.
 */
export interface CodeHighlighter {
  /** Start syntax/theme initialization before the first tool result needs it. */
  warmup(): Promise<boolean>
  highlight(request: CodeHighlightRequest): Promise<string | null>
  /** Optional native mixed-diff mode. Null means unsupported or failed. */
  highlightUnifiedDiff?(request: UnifiedDiffHighlightRequest): Promise<string | null>
  close(): Promise<void>
}

/**
 * Cosmetic per-tool presentation hints. The registry strips them from tool
 * definitions before they go on the model wire.
 */
export interface ToolPresentation {
  /** Glyph drawn before the tool name in the transcript header. */
  icon?: string
  /** Host palette key for the icon and label color. */
  color?: string
  /**
   * Input field whose value can headline the transcript header before the
   * handler returns.
   */
  headerKey?: string
}

/** Options for {@link ToolTranscriptFormatter.formatToolHeaderRows}. */
export interface ToolHeaderRowsOptions {
  tool: ToolUseBlock
  presentation?: ToolPresentation | null
  headerOverride?: string
  timeText?: string
  cols?: number
}

/** Options for {@link ToolTranscriptFormatter.formatToolPreview}. */
export interface ToolPreviewOptions {
  tool?: string
  info?: TruncationInfo
  footer?: string
  cols?: number
  /** Content already carries balanced syntax-highlighting ANSI. */
  ansiContent?: boolean
}

/** Options for {@link ToolTranscriptFormatter.renderStreamedTail}. */
export interface StreamedTailOptions {
  bufferedLastLine: string | null
  bufferedLastLineRaw?: string | null
  streamedLineCount: number
  budget: number
  truncInfo?: TruncationInfo
  isError?: boolean
  writeTranscript: (line: string) => void
  cols?: number
}

/**
 * Host formatter for the tool transcript rows. The method names match the
 * CLI's `ui/tool-transcript/format.ts` exports, so the CLI can pass that
 * module as is.
 */
export interface ToolTranscriptFormatter {
  /** Header rows of a tool block (title row, continuation rows, spacer). */
  formatToolHeaderRows(opts: ToolHeaderRowsOptions): string[]
  /** Body preview rows plus the closing row. */
  formatToolPreview(
    content: string,
    isError?: boolean,
    display?: string,
    opts?: ToolPreviewOptions,
  ): string[]
  /** Rows for a tool that the active mode or a policy refused. */
  formatRefusalRows(message: string, refusedBy: string): string[]
  /** Closing row for the built-in `Mode` tool. */
  formatModeCloseRow(labelDisplay: string): string
  /** One live stream body row. */
  formatStreamBodyRow(line: string): string
  /** Clamp one stream body line to `maxWidth` cells. */
  clampBodyWithHint(line: string, maxWidth: number): string
  /** Safe body line width for the current (or given) terminal width. */
  effectiveBodyLineWidth(cols?: number): number
  /** Write the closing rows of a streamed body. */
  renderStreamedTail(opts: StreamedTailOptions): void
  /** Turn the closing row of a block into a continuation row. */
  reopenFrameCloser(line: string): string
  /** Rows of the plugin diagnostics panel. Empty for no findings. */
  renderFindingsPanel(findings: Finding[], opts?: { cols?: number; maxRows?: number }): string[]
  /** Language id for code highlight, or `null` for none. */
  resolveFileLanguage(input: { path?: string | null; content?: string | null }): string | null
  /** Highlight a numbered `Read` body. `null` keeps the plain body. */
  highlightReadBody(
    numberedBody: string,
    language: string,
    highlighter: CodeHighlighter,
  ): Promise<string | null>
  /** Highlight an Edit/Write unified diff. `null` keeps the plain display. */
  highlightUnifiedDiff(
    patch: string,
    language: string,
    highlighter: CodeHighlighter,
    title?: string,
  ): Promise<string | null>
}
