/**
 * Non-interactive prompt extraction from CLI args.
 *
 * Lifted out of `src/index.ts` so it can be unit-tested without pulling
 * the entire startup side-effect graph. Pure (synchronous, no I/O); the
 * stdin-read case is signalled by a `kind: "stdin"` discriminator and
 * the caller (`index.ts`) does the actual `process.stdin` slurp.
 *
 * Three forms supported (checked in this order):
 * 1. `--prompt <text>`     — explicit flag → `{kind:"literal", text}`
 * 2. `-`                   — read stdin   → `{kind:"stdin"}`
 * 3. First bare positional — non-flag, non-flag-value arg → `{kind:"literal", text}`
 *
 * Otherwise `{kind:"none"}` (interactive REPL).
 *
 * Critical invariant: `FLAGS_WITH_VALUES` MUST list every long flag that
 * consumes the following positional, otherwise the bare-positional walk
 * will mistake the flag's value for the user's prompt and the agent will
 * silently enter non-interactive mode. Tests in
 * `src/extract-prompt.test.ts` pin this for the regression-prone flags
 * (`--resume`, `--model`, `--provider`, etc).
 *
 * @module extract-prompt
 */

/**
 * Long flags that consume the following positional as their value.
 * Used to skip both the flag and its value when scanning for a bare
 * positional prompt.
 *
 * Keep in sync with the flags defined in `src/cli-args.ts`. Adding a
 * new value-taking flag without updating this set is the exact bug
 * that motivated extracting this module — see git history of `--resume`.
 */
export const FLAGS_WITH_VALUES: ReadonlySet<string> = new Set([
  "--model",
  "--provider",
  "--session-id",
  "--prompt",
  "--resume",
  "--resume-same-sid",
  "--formatter",
  "--formatter-args",
  "--effort",
  "--spinner",
  "--thinking-display",
  "--mode",
  "--disable-plugin",
  "--enable-plugin",
  "--dump",
  "--dump-format",
  // Optional companion to `--login`: `--email <addr>` (or `--email-hint`)
  // pre-fills the login form. Both forms accept the same value semantics.
  "--email",
  "--email-hint",
  "--auth-method",
])

/**
 * Long flags that take no value. They consume their own slot but not
 * the following positional, so a positional after one is a real prompt.
 *
 * `-` is included here because the stdin sentinel is handled separately
 * (see step 2 above) but its index must still be skipped during the
 * positional walk.
 */
export const FLAGS_NO_VALUE: ReadonlySet<string> = new Set([
  "--debug",
  "--verbose",
  "--list-models",
  "--list-flags",
  "--list-plugins",
  "--list-spinners",
  "--sessions",
  "--help",
  "-h",
  "-",
  "--skip-quota",
  "--show-hidden-chars",
  "--header",
  "--no-header",
  // Auth subcommands — see src/cli/command-plan.ts. None of these consume
  // the following positional, so they belong here rather than in
  // FLAGS_WITH_VALUES. (`--login --email foo@bar` is a future option but
  // even then `--email` would be the value-taker, not `--login`.)
  "--login",
  "--logout",
  "--auth-status",
])

export type PromptSource = { kind: "literal"; text: string } | { kind: "stdin" } | { kind: "none" }

/**
 * Pure: classify how the prompt should be sourced for this argv.
 *
 * Does NOT read stdin — caller does that on `{kind:"stdin"}`.
 *
 * @param args - Normalized argv (output of `normalizeArgs`).
 */
export function extractPromptFromArgs(args: readonly string[]): PromptSource {
  // 1. --prompt "text"
  const promptIdx = args.indexOf("--prompt")
  if (promptIdx !== -1 && args[promptIdx + 1] !== undefined) {
    return { kind: "literal", text: args[promptIdx + 1] }
  }

  // 2. "-" → stdin
  if (args.includes("-")) return { kind: "stdin" }

  // 3. First bare positional that isn't a flag or a flag's value.
  const skipNext = new Set<number>()
  for (let i = 0; i < args.length; i++) {
    if (FLAGS_WITH_VALUES.has(args[i])) {
      skipNext.add(i)
      skipNext.add(i + 1)
    } else if (FLAGS_NO_VALUE.has(args[i])) {
      skipNext.add(i)
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (!skipNext.has(i) && !args[i].startsWith("--")) {
      return { kind: "literal", text: args[i] }
    }
  }

  return { kind: "none" }
}
