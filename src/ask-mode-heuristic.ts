/**
 * Question-vs-action heuristic for the auto-ASK feature.
 *
 * Pure, allocation-light, regex-based. Returns a signed integer score:
 *
 * - Positive  ⇒ the buffer reads like a question / read-only ask.
 * - Negative  ⇒ the buffer reads like an imperative / change request.
 * - Near zero ⇒ ambiguous; caller should NOT auto-flip.
 *
 * The consumer ({@link AutoAskController}) flips to ASK at `score >= +2`
 * and reverts to default at `score <= -2`. The deadband in between is
 * intentional — partial typing like "fi" or "what " sits at zero and the
 * mode stays put.
 *
 * Design rules (battle-tested while writing this — try not to relax them):
 *
 * 1. NEVER auto-flip on a buffer that contains BOTH question and action
 *    signals. "fix the bug — what's the cleanest approach?" is a request
 *    for change, even though it ends in `?`. The score collapses toward
 *    zero in mixed cases, which is the correct outcome.
 * 2. Bare "can you …" / "could you …" / "should I …" / "what if …" are
 *    classified as AMBIGUOUS, not question. They're frequently followed
 *    by an imperative ("can you fix …", "what if we just …"). If the
 *    user actually wants ASK they can Shift+Tab manually.
 * 3. Imperative verbs ONLY count when they appear as the first token of
 *    the buffer (or right after a leading "please"). "What does fix do?"
 *    is a question, not an action.
 *
 * @module ask-mode-heuristic
 */

const WH_LEAD = /^(?:please\s+)?(what|why|how|where|when|who|which)\b/i

/**
 * Modal/auxiliary verbs that, when they LEAD the sentence, suggest a
 * yes/no question. Excludes "can/could/should/would" because those are
 * ambiguous (they're polite imperatives in practice).
 */
const MODAL_LEAD = /^(?:please\s+)?(is|are|was|were|do|does|did|will)\b/i

/**
 * Imperative verbs at the START of the buffer (or right after "please").
 * These are our strongest "this is a change request" signal.
 */
const ACTION_LEAD =
  /^(?:please\s+|let'?s\s+|let\s+us\s+)?(fix|add|remove|delete|drop|refactor|rename|create|write|implement|change|update|modify|patch|apply|move|install|uninstall|run|exec|commit|push|build|compile|test|deploy|merge|rebase|revert|format|lint|stub|inject|wire|migrate|extract|inline|replace|insert|generate|scaffold|configure|setup|set\s+up|teardown|tear\s+down|bump|upgrade|downgrade|enable|disable|silence|squash|fold|unfold|split|join)\b/i

/**
 * Polite-imperative leads that LOOK like questions but usually aren't.
 * Their presence neutralises a trailing `?` (drops it to ambiguous).
 */
const POLITE_AMBIG_LEAD = /^(?:please\s+)?(can|could|should|would|may|might)\s+(you|i|we)\b/i

/**
 * "what if" specifically — speculation, often followed by an imperative.
 * Treated as ambiguous regardless of the rest of the sentence.
 */
const WHAT_IF_LEAD = /^\s*what\s+if\b/i

/**
 * Anywhere-in-buffer imperative cue. Weaker than ACTION_LEAD; only
 * counts when no question signal is present.
 */
const ACTION_BODY =
  /\b(fix|refactor|rename|implement|delete|remove|patch|apply|commit|push|deploy|migrate)\s+(the|this|that|these|those|a|an|my|our|src|src\/|tests?|the|all)\b/i

/** Read-only verbs that strengthen "this is a question". */
const READ_ONLY_LEAD =
  /^(?:please\s+)?(explain|describe|tell|show|list|summarise|summarize|recap|trace|dump|inspect|read|review)\b/i

/** Trailing question mark, possibly with whitespace after. */
const TRAILING_Q = /\?\s*$/

/**
 * Maximum buffer length we even try to score. Long buffers are usually
 * pasted code or detailed change requests — auto-flip on those is too
 * risky. Above this we return 0 (ambiguous).
 */
const MAX_SCORABLE_LEN = 400

export interface ScoreOptions {
  /** Override the max-length cap (tests). */
  maxLen?: number
}

/**
 * Compute the question-vs-action score for a buffer.
 *
 * Returns 0 for empty / oversize / mixed-signal buffers. Positive scores
 * mean "question-shaped"; negative scores mean "action-shaped".
 */
export function scoreQuestion(rawText: string, opts: ScoreOptions = {}): number {
  const maxLen = opts.maxLen ?? MAX_SCORABLE_LEN
  const text = rawText.trim()
  if (text.length === 0) return 0
  if (text.length > maxLen) return 0

  // "what if …" is always ambiguous — short-circuit.
  if (WHAT_IF_LEAD.test(text)) return 0

  let score = 0

  // ---- Positive (question) signals -----------------------------------------
  const hasWhLead = WH_LEAD.test(text)
  const hasModalLead = MODAL_LEAD.test(text)
  const hasReadOnlyLead = READ_ONLY_LEAD.test(text)
  const hasTrailingQ = TRAILING_Q.test(text)

  if (hasWhLead) score += 2
  if (hasModalLead) score += 1
  if (hasReadOnlyLead) score += 2
  if (hasTrailingQ) score += 1

  // ---- Negative (action) signals -------------------------------------------
  const hasActionLead = ACTION_LEAD.test(text)
  const hasActionBody = ACTION_BODY.test(text)
  const hasPoliteAmbig = POLITE_AMBIG_LEAD.test(text)

  if (hasActionLead) score -= 3
  if (hasActionBody) score -= 1

  // Polite imperatives ("can you …", "could you …") neutralise a lone `?`.
  // We model this as: drop the trailing-? bonus, do NOT add a question
  // bonus for the modal lead.
  if (hasPoliteAmbig) {
    if (hasTrailingQ) score -= 1 // cancel the +1 from trailing-Q
    // No extra penalty — we just want the score to land near zero.
  }

  // Mixed-signal collapse: if BOTH a strong action and a strong question
  // signal are present, the score should not commit either way. Pull
  // toward zero.
  const strongQ = hasWhLead || hasReadOnlyLead
  const strongA = hasActionLead
  if (strongQ && strongA) {
    // Halve the magnitude, rounding toward zero.
    score = (score / 2) | 0
  }

  return score
}

/** Threshold helpers, exported for the controller and tests. */
export const ASK_THRESHOLD = 2
export const REVERT_THRESHOLD = -2

export function isQuestionConfident(score: number): boolean {
  return score >= ASK_THRESHOLD
}

export function isActionConfident(score: number): boolean {
  return score <= REVERT_THRESHOLD
}
