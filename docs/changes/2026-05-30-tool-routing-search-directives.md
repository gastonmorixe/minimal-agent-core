# Route search to Grep/Glob instead of Bash `find`/`grep`

Date: 2026-05-30

## Problem

Models frequently answered search tasks by shelling out to `find`, `grep`, `rg`, or
`find … | wc -l` inside the **Bash** tool instead of using the dedicated **Grep**/**Glob**
tools. Measured first-tool routing into a Bash search command (lower is better), N=200 per
cell, real Claude API:

| model | baseline |
|-------|----------|
| opus-4-8 (thinking on) | 41.0% |
| opus-4-8 (thinking off) | 29.5% |
| haiku-4-5 | 18.0% |
| sonnet-4-6 | 0.0% |

Root cause: minimal-agent's slimmed prompt dropped all of the search-routing guidance that
real Claude Code carries. The Grep/Glob descriptions had no "use this, not Bash" directive,
the system prompt said nothing about tool choice, and the Bash description actively suggested
bounding output "…or `grep`". The failure concentrated in file-finding ("find all the Python
scripts") and counting ("how many .ts files", "count how many times X appears") prompts.

Full investigation, harness, and 5,200-call dataset: `private/work/tool-routing-study/`.

## Change

Added the routing directives back, at two layers (mirrors real Claude Code), all in markdown
prompt files:

- `src/prompts/tools/glob.md`: "ALWAYS use this tool to find or count files by name or path.
  NEVER use `find`, `fd`, or `ls` through Bash for this." + glob-pattern examples.
- `src/prompts/tools/grep.md`: "ALWAYS use this tool for content searches, including counting
  matches (use `output_mode: "count"`). NEVER invoke `grep` or `rg` as a Bash command."
- `src/prompts/tools/bash.md`: prepended "IMPORTANT: Do NOT use Bash to search, read, or count
  code…"; removed the "or `grep`" output-bounding suggestion.
- `src/prompts/instructions.md`: added a "# Using your tools" section.

No code changed; these are model-facing prompt edits.

## Result

Confirmed against the real shipped config (real `instructions.md` + real tool descriptions,
no harness overrides):

| task type | model | routed correctly |
|-----------|-------|------------------|
| search (→ Grep/Glob) | opus-4-8, thinking on | 200/200 (100%) |
| search (→ Grep/Glob) | haiku-4-5 | 200/200 (100%) |
| control: real shell work (→ Bash) | opus-4-8 | 0/100 over-routed to Grep/Glob |

So search tasks now go to the dedicated tools, and the aggressive "don't search with Bash"
wording does NOT spill into refusing Bash for genuine shell work (run tests, git, typecheck).

## Verification

- `bun test src/tools-descriptions.test.ts` (the cap/preview drift guard): 10 pass.
- Targeted suites (`tools`, `prompts`, `headers`, `system-prompt`, `anthropic`): 86 pass, 0 fail.
- `tsgo --noEmit`: exit 0. `oxlint`: 0 errors.
- Note: the full `bun run check` is currently red on `format:check` for two unrelated untracked
  files (`src/usage-stats.ts`, `src/ui/usage/render.ts`) that pre-date this change; markdown
  prompts are not processed by biome.

## Follow-up (not done here)

- `execGlob` (`src/tools.ts`) shells out to `ls -1d` globstar, not `fd`, despite docstrings
  claiming `fd`, and does not actually sort by mtime. Worth fixing the implementation or the
  remaining claim.
- Consider a drift-guard test asserting the Grep/Glob/Bash descriptions and `instructions.md`
  contain the "NEVER … Bash" directive, so a future prompt edit can't silently drop it.
