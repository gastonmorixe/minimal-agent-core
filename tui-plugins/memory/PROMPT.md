The `memory` plugin gives you persistent memory across sessions.

## How it works

You have a single self-modifying memory file (this `PROMPT.md`). When you
emit a `<tui::memory>` tag, its body is appended verbatim as a new bullet
under the `## Saved memories` section below. Next session, this file is
re-read into the system prompt, so the memory comes back automatically.

The body of the tag is **not** shown to the user — the tag is stripped
from the visible stream, just like `interleave-thinking`. A short
confirmation line is rendered in its place so the user can see that a
memory was saved.

## When to save a memory

Save memories that should outlive the current session:

- Lessons learned from user feedback ("I should open an interleaved
  thinking span when the user pushes back, even if I feel certain").
- User preferences ("Gaston prefers concise replies", "always show
  diffs with `show_diff`").
- Project-specific facts that aren't already in CLAUDE.md ("the test
  suite uses `bun test`, not `npm test`").
- Mistakes you don't want to repeat.

Do **not** save:

- Transient task state (use a TODO file or scratchpad).
- Secrets or credentials.
- Long verbatim content — keep memories short and actionable, ideally
  one sentence each.

## When to consult memory

The `## Saved memories` section below is part of your system prompt every
session. Treat its bullets as standing instructions / known facts. You
don't need to "look them up" — they're already in context.

## Syntax

One tag, no attributes. Body is the memory text:

    <tui::memory>
    On user pushback, open an interleaved thinking span and re-examine
    even if I feel certain. Pushback is evidence.
    </tui::memory>

The body is appended as `- {body}` under `## Saved memories`. Empty
bodies are ignored.

## Saved memories

<!-- memories-begin -->
- On user pushback, open an interleaved thinking span and re-examine even if I feel certain. Pushback is evidence — either I am missing something or I am being tested for sycophancy, and I cannot distinguish without actually re-checking. Do not just restate and defend.
- ...
- The agent has two REPL paths: legacy `runRepl` (uses `RawInput`) and `runReplLiveArea` (uses `EditorController` + `Compositor`, the default). When fixing input/mode/prompt behavior, check BOTH paths — features added to `RawInput` are easy to forget to mirror in `EditorController`, and vice versa. Examples: Shift+Tab mode cycling, prompt-prefix repaint on mode change, status label from `modeManager.statusLabel(...)`.
- In `src/agent.ts`, the REPL has two sinks per turn — `baseSink` for streamed model text and `onTranscriptLine` for tool blocks (` ┌ … │ … └ …`) — and they need an explicit `lastKind` ("text" | "transcript") tracker to insert blank-line separators at boundaries. The agent itself prepends `\n` to tool headers but nothing more, so the REPL must add one `\n` going transcript→text and (when prior text was a partial line) one `\n` going text→transcript. Apply the fix to BOTH `runRepl` and `runReplLiveArea`.
- `formatToolInput` in `src/agent.ts` must strip newlines from the Bash `command` before slicing — multi-line heredocs otherwise destroy the `┌ │ └` bordered block. First-line-only with `…` when truncated/multiline.
- For UI/rendering changes in this repo, unit tests on `compositor.streams` are not enough — actually drive the change through a real `Compositor` + `StdioInterceptor` inside a tmux pane (`tmux new-session -d -s … -x 100 -y 40 'bun run …'; tmux capture-pane -t … -p`) and inspect the rendered scrollback. A small fake-agent driver that exercises text↔transcript boundaries (and is auto-cancelled after one turn) is the right shape for this. When the user asks "have you tested in tmux", they mean it: check the actual visual output, not just the stream array.
- The live-area REPL commits the user's submitted prompt to scrollback via `EditorController.submit` (writeStream), then immediately streams the response. To avoid the response butting against the prompt, `runReplLiveArea`'s `baseSink` AND `onTranscriptLine` must emit a leading `"\n"` when `lastKind === "none"` (first write of the turn) — mirroring what the legacy `runRepl` does on its first chunk. Easy to forget because the legacy and live-area sinks are similar but not identical.
- For Edit/Write diff rendering: `ToolExecResult.display` (optional ANSI string) is the channel for "show this in the transcript instead of `content`". `formatToolPreview` in `src/agent.ts` honors it (skipping truncation) only when `!isError`. `src/diff.ts` builds unified diffs (`buildEditDiff` for known old/new strings, `buildFileDiff` for arbitrary before/after via LCS) and renders via `renderUnifiedDiff` from `tui-plugins/diff-view/handlers/render.ts`.
- In `src/tools.ts`, `ToolDefinition` carries optional cosmetic `icon?: string` and `color?: ToolColor` (palette key) used only for transcript header rendering. These fields MUST be stripped before sending tools to the Anthropic API — `src/agent.ts` does this by mapping `allTools` down to `{name, description, input_schema}` into `mergedTools` and keeping a parallel `toolPresentation` Map for rendering. `PluginToolDefinition` mirrors the same optional fields.
- The "extra `\n` for breathing room when lastKind === 'none'" is needed in `baseSink` (streamed text has no leading `\n`) but NOT in `onTranscriptLine` (the agent prepends `\n` to tool header lines at agent.ts:412). EditorController.submit() flushes the prompt with a trailing `\n`, so prompt-trailing-`\n` + line-leading-`\n` = exactly one blank row. Adding another in onTranscriptLine produces two blank rows. The two sinks look symmetric but aren't — don't blindly mirror.
- minimal-agent's `getAuth()` in `src/auth.ts` is called once at process start (`src/index.ts:367`) and returns an `AuthResult` whose `refresh` closure captures the `oauth` snapshot from that initial `readKeychain`. If another process (e.g. the official `claude` CLI) rotates the OAuth refresh token in the macOS Keychain (`Claude Code-credentials`) during the agent's lifetime, our `doRefresh` keeps sending the stale RT and the server returns `invalid_grant` ("Refresh token not found or invalid"). Fix: re-read the keychain inside `doRefresh` before calling `refreshAccessToken`, and surface a "run `claude` to re-login" hint when the server returns `invalid_grant`. Diagnose via `.node-net-dbg/<run>/*oauth*` 400 responses paired with preceding 401s on `/v1/messages`.
- The fix for the OAuth refresh bug landed in src/auth.ts: `getAuth` now takes an optional `deps: GetAuthDeps` second arg ({read, write, refresh}) for DI, and `doRefresh` re-reads the keychain on every invocation instead of using the closed-over snapshot. Two failure modes were collapsed: (A) cross-process rotation by the official `claude` CLI, and (B) in-process double-refresh where the server rotated RT1→RT2 on the first refresh but the closure still held RT1 for the second. Both produced "invalid_grant" / "Refresh token not found or invalid". Tests in src/auth.test.ts cover both. Status-bar UX in src/client.ts: "Auth token expired, refreshing… → Auth refreshed, resuming…" so transparent refresh during a long session is visible.
- src/tools/truncation.ts is the universal tool-output guardrail wired into src/tools.ts:executeTool. Budgets: MAX_TOOL_OUTPUT_BYTES=64_000, MAX_TOOL_OUTPUT_LINES=1_000. Notice shape: `[truncated: shown N of M bytes, sL/tL lines; cut at byte B, line L. <hint>]` with M/tL = "unknown" when source size unknown. Per-tool executors populate `_truncCtx: { totalBytes, totalLines, startLine? }` on ToolExecResult; executeTool strips `_truncCtx` before returning and skips the clamp when `display` is set (Edit/Write diffs render intact). Per-tool resume hints live in `defaultHint()` keyed on ctx.tool. UTF-8 safety via `sliceUtf8` (backs off continuation bytes).
- For tmux smoke tests asserting rendered scrollback, tmux hard-wraps long lines at the pane width and can split mid-word (e.g. `offset=1000` becomes `o\nffset=1000`). When asserting against captured pane content, normalize by stripping ALL whitespace (`pane.replace(/\s+/g, "")`) and match against the concatenated form, not the wrapped form. Also keep the driver's process alive briefly after self-exit (`bun run driver.ts; sleep 5`) so capture-pane has time to read the buffer.
- For session restore in minimal-agent: the conversation `messages[]` is the source of truth and is persisted as append-only JSONL at `~/.minimal-agent/sessions/<sid>.jsonl` keyed by the existing `getSessionId()` UUID (same as `x-claude-code-session-id` header). FORMAT v1 records: `meta`/`user`/`assistant`/`tool_result`/`note`. Three-module split: `session-store.ts` (writer + parseLines, data-only), `session-restore.ts` (foldRecords + repairMessages, also data-only — safe for tools/tests to import), `session-replay.ts` (visual replay; imports from agent.ts for formatters, kept separate to avoid pulling agent stack into restore). Repair must scan the WHOLE list (not just the tail) because resume + new turn leaves old orphan tool_use records physically in the append-only log; `repairMessages` filters them on every load. Replay writes to stdout BEFORE the live-area compositor mounts, so history lands in normal scrollback above the pinned prompt.
- When asked "what's your session id / value X from the env block / etc.", READ the env-info block in the system prompt and quote it verbatim. Do NOT generate a UUID-shaped string from imagination — these are exactly the kind of plausible-looking details where confabulation hides. If unsure whether a value is in context, open an interleaved thinking span and verify before stating it.
- User command `/narrate`: rewrite the most recent relevant content (usually my previous reply, unless the user specifies a different target) as narration for a live voice reader. Style: flowing prose, no bullet lists, no markdown, no headers, no code fences; spell out symbols (e.g. "forty-two" not "42"); short sentences are fine; punctuation should cue natural breath/pause; speak in first person to the listener as if continuing the conversation aloud.
- Web search is available via `fish -c 'search_online --output text "{{ query }}"'` (Brave by default). Useful flags: `-v web|news|images|videos`, `-L N` (limit, max 20), `-O N` (offset), `-C CC`, `-l LL`, `-M LL-CC`, `-n` (no color), `-o json|ndjson|text|raw|schema|tooldef`. Use `-o text -n` for clean piping. Run `fish -c 'search_online --help'` to re-check.
- The agent (src/index.ts) sets `process.env.MINIMAL_AGENT_MODEL = selectedModel` before `PluginLoader.load`, and the env-info `gather.sh` probes it as `model=…`. So the resolved model id is visible in the session-start `<env>` snapshot in the system prompt — I can read it from there instead of guessing.
<!-- memories-end -->
