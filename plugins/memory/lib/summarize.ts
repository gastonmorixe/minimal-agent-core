/**
 * Memory summarizer — LLM wrapper.
 *
 * One job: given the raw text of a `memory.md` file, return a compressed
 * markdown summary suitable for injection into the system prompt.
 *
 * ## INVARIANT — DO NOT BREAK
 *
 * The function signature is intentionally `(memoryMd, cfg) -> summary`.
 * There is NO `previousSummary` parameter and there must never be one.
 *
 * Why: if the summarizer ever ingests its own previous output, lossy
 * compression compounds across regens — summary-of-summary-of-summary
 * monotonically degrades fidelity. By rederiving from `memory.md` (the
 * source of truth) on every regen, we get exactly one lossy step
 * between source and view, regardless of how many regens have happened.
 *
 * See docs/changes/2026-05-14-feat-memory-summary-refresh.md for the
 * full rationale.
 *
 * @module memory/lib/summarize
 */

// RESIDUAL host coupling (Wave D-7): the summary pipeline needs an
// authenticated LLM call at prompt-fragment time. There is no `auth` or
// `llm:send` capability on the plugin host yet, and the prompt-fragment
// context exposes no `ctx.host` at all, so these two RUNTIME helpers stay
// imported from `src/` until that capability lands. Their TYPES are
// DERIVED from the runtime values (`ReturnType`/`Parameters`) below, so
// the plugin re-declares no host wire-types and adds no extra src/ site.
import { defaultSummaryModel } from "./memory-config.ts"
import { promptPath, renderPrompt } from "./prompt-io.ts"

/**
 * One-shot host-brokered completion, matching the `llm:complete` capability
 * (`ctx.host.llm.complete`). The plugin passes a system prompt + a single
 * user text and gets the model's full response back, WITHOUT importing
 * `getAuth` / `canonicalSendFn` from `src/` — the host owns the whole
 * auth → send → drain pipeline. The handler injects the real
 * `ctx.host.llm.complete`; tests inject a fake.
 */
export type CompleteFn = (req: {
  model?: string
  system: string
  userText: string
  maxTokens?: number
  timeoutMs?: number
}) => Promise<string>

/** Configuration for one summarize() call. */
export interface SummarizeOptions {
  /** Model id used for the LLM call. */
  model: string
  /**
   * Scope label, only used to seed the system prompt with the right
   * framing ("this codebase" vs "this user across projects"). Doesn't
   * change behavior materially; helps the model produce slightly more
   * apt cluster names.
   */
  scope: "global" | "project"
  /**
   * Max wall-clock ms before we abort the LLM call. Defaults to 30_000.
   * Hard ceiling to keep session-start latency bounded.
   */
  timeoutMs?: number
}

/**
 * Injectable dependencies. Production callers pass nothing; tests
 * inject fakes to avoid hitting the real credential store / API.
 */
export interface SummarizeDeps {
  /**
   * One-shot host-brokered completion (the `llm:complete` capability, i.e.
   * `ctx.host.llm.complete`). Required in production — the handler injects
   * `ctx.host.llm.complete`; tests inject a fake. When absent (an older host
   * that didn't grant the capability), {@link summarize} throws `send-failed`
   * so the caller falls back to the last-good summary.
   */
  completeFn?: CompleteFn
}

/**
 * Thrown by {@link summarize} on any failure that should make the caller
 * fall back to the last-good summary (or to verbatim injection).
 *
 * Carries a `kind` discriminator so the caller can log appropriately.
 */
export class SummarizeError extends Error {
  readonly kind:
    | "auth-failed"
    | "send-failed"
    | "timeout"
    | "empty-output"
    | "too-short"
    | "too-long"
  constructor(kind: SummarizeError["kind"], message: string) {
    super(message)
    this.name = "SummarizeError"
    this.kind = kind
  }
}

/** Default timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Floor and ceiling on output length, as a fraction of input length.
 * The summary must compress *and* not vanish.
 */
export const MIN_OUTPUT_RATIO = 0.05
export const MAX_OUTPUT_RATIO = 1.0

/**
 * Build the system prompt sent to the model. Exported for tests. The prose
 * lives in `plugins/memory/prompts/`; the scope branch (which framing line)
 * stays here as control flow. See `src/prompts/README.md`.
 *
 * @param scope - Which memory scope is being summarized.
 * @returns The rendered summarizer system prompt.
 */
export function buildSystemPrompt(scope: "global" | "project"): string {
  const framingFile = scope === "global" ? "framing.global.md" : "framing.project.md"
  const scopeFraming = renderPrompt(promptPath(import.meta, "..", "prompts", framingFile))
  return renderPrompt(promptPath(import.meta, "..", "prompts", "summarize.tmpl.md"), {
    scopeFraming,
  })
}

/**
 * Wrap a promise with a timeout. If `ms` elapses first, the returned
 * promise rejects with a {@link SummarizeError} of kind `"timeout"`.
 * The underlying work is NOT canceled (the send fn doesn't accept
 * an AbortSignal in its current shape) — it just stops being awaited.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new SummarizeError("timeout", `LLM call exceeded ${ms}ms`))
    }, ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/**
 * Compress the raw `memory.md` text into a structured summary.
 *
 * Throws {@link SummarizeError} on any failure mode (auth, network,
 * timeout, empty/short/long output). Callers should catch and fall
 * back to the last-good summary or to verbatim injection.
 */
export async function summarize(
  memoryMd: string,
  opts: SummarizeOptions,
  deps: SummarizeDeps = {},
): Promise<string> {
  const complete = deps.completeFn
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (!complete) {
    throw new SummarizeError(
      "send-failed",
      "no llm:complete capability granted (host.llm.complete missing)",
    )
  }

  let output: string
  try {
    output = await withTimeout(
      complete({
        model: opts.model ?? defaultSummaryModel(),
        system: buildSystemPrompt(opts.scope),
        userText: memoryMd,
        maxTokens: 8192,
        timeoutMs,
      }),
      timeoutMs,
    )
  } catch (e) {
    if (e instanceof SummarizeError) throw e
    throw new SummarizeError("send-failed", `LLM call failed: ${(e as Error).message}`)
  }

  // Sanity checks.
  const trimmed = output.trim()
  if (trimmed.length === 0) {
    throw new SummarizeError("empty-output", "LLM returned empty response")
  }
  const inputLen = memoryMd.length
  const outputLen = trimmed.length
  if (outputLen < inputLen * MIN_OUTPUT_RATIO) {
    throw new SummarizeError(
      "too-short",
      `output ${outputLen} chars is < ${Math.floor(inputLen * MIN_OUTPUT_RATIO)} (${MIN_OUTPUT_RATIO * 100}% of input ${inputLen})`,
    )
  }
  if (outputLen > inputLen * MAX_OUTPUT_RATIO) {
    throw new SummarizeError(
      "too-long",
      `output ${outputLen} chars exceeds input ${inputLen} — didn't compress`,
    )
  }

  return trimmed
}
