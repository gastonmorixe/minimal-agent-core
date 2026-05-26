# feat: per-session raw-tool-output blob store + universal plugin-tool clamp

**Date**: 2026-05-26
**Type**: feat
**Scope**: `src/blob-store.ts` (new), `src/tools.ts`, `src/agent.ts`, `src/index.ts`, `src/headers.ts`, `src/session-store.ts`, `src/tools/truncation.ts`; plugin: `~/Projects/minimal-agent-plugins/ma-fetch-plugin/handlers/fetch.ts`

## Problem

Three coupled gaps, surfaced by a debugging session where the user wanted to inspect raw `Fetch` output and discovered:

1. **Built-in tool output above the universal cap (64 KB / 1000 lines) was clamped destructively.** `src/tools/truncation.ts` rewrote `ToolExecResult.content` in place with the clamped body + a `[truncated: ...]` notice. The pre-clamp bytes were thrown away. Both the model and the session JSONL saw only the clamped form. To re-inspect the original you had to re-run the tool.
2. **Plugin tools (Fetch, WebSearch, …) bypassed the universal clamp entirely.** A 5 MiB markdown page from `Fetch` shipped straight to the API. Cheap when the page is small, an unbounded context blowup when it isn't.
3. **The model had no in-band way to ask for "the full output".** Even if we kept the raw bytes somewhere, the tool-result `content` block was the only channel the model knew about. So a clamped response was a dead end.

Separately, the user spotted that `Fetch`'s markdown output for some pages (Wikipedia, GitHub) was 70 to 90 % blank or whitespace-only lines. That's a different problem (HTML→markdown converter quirk in obscura) but it overlapped enough with the raw-output design that it landed in the same change set as a stopgap.

## Goals

- **Preserve the full body of every tool call**, regardless of clamp. The model sees a useful clamped preview by default; the raw bytes are recoverable on demand.
- **Make the raw bytes addressable** via a stable, regex-greppable footer the model can `Read` directly. No new tool call type, no SDK-side change. Just a path the model already knows how to use.
- **Apply the same clamp to every tool, built-in or plugin.** Consistent ceiling, consistent recovery path.
- **Survive session resume.** The blob path inside the JSONL stays valid until the session blobs directory is garbage-collected.
- **Be cheap.** Small tool outputs (under a configurable threshold) skip the blob write entirely. Disk grows only when there's something worth saving.
- **Be opt-out-able.** One config knob (`plugins["blob-store"].enabled = false`) and one env var (`MINIMAL_AGENT_BLOB_STORE_DISABLED=1`) restore the legacy behavior byte-for-byte.

## Design

### Storage layout

One file per tool call, keyed by `tool_use_id`, under a per-session sibling of the JSONL:

```
~/.minimal-agent/sessions/
  ├── <sid>.jsonl
  ├── <sid>.tasks.jsonl
  ├── <sid>.scratch.md
  └── <sid>.blobs/                                <-- NEW
        ├── toolu_01abc...raw
        ├── toolu_01def...raw
        └── ...
```

Reasons for sibling-folder over a flat global tree or a nested `<sid>/blobs/`:
- Matches the on-disk pattern session-store already follows (sibling, sid-prefixed).
- `rm -rf` of two paths cleans up an entire session.
- Cross-session traversal stays a single readdir + filter on suffix.

Filename key is `tool_use_id` because the API already mints a unique id per tool call, the JSONL already records it, and a content sha (the alternative) would deduplicate identical bodies across calls at the cost of a separate lookup index. We don't need dedup.

### Footer convention

When a blob is written, the agent appends one line to the model-facing `tool_result.content`:

```
[raw-output: /abs/path/to/<sid>.blobs/<tool_use_id>.raw  125.0kB · sha256=ff33072217f5d0e5]
```

Self-contained, regex-greppable, stable. The model uses `Read({file_path: ...})` or `Bash({command: "wc -l '...'"})` on the path when the inline body isn't enough.

Ordering with the existing footers, end-of-content downward:

```
<body>
[truncated: ...]                        existing, inside content, only when clamp fired
                                        (blank line)
[raw-output: ...]                       NEW, only when a blob was written
                                        (blank line)
<ma::tui-preview shown=... total=...>...   existing, only when TUI preview elided
```

### Schema additions

`ToolResultRecord` (in `src/session-store.ts`) gains three optional fields:

```ts
export interface ToolResultRecord {
  // ...existing fields...
  rawPath?: string
  rawBytes?: number
  rawSha256?: string  // 16 hex chars (sha256 prefix), drift-detection only
}
```

Optional and additive. Older JSONL files load unchanged.

### Capture point

Single insertion in `src/agent.ts` after both tool dispatch branches converge (built-in via `executeTool`, plugin via `loader.dispatch`). Eligibility check:

- store is not null (config enabled, construction succeeded)
- tool is not on the skip list (`Task`, `MemoryTool`, `ShowDiff`, `LockStatus` by default)
- result did not set `display` (Edit/Write diff render, or plugin-owned audience-split like the tasks plugin)
- tool was not aborted
- body is at least `minBytesToPersist` (4096 by default; gated inside `BlobStore.write`)

Source of bytes:
- `result._raw` when set (built-in tools that hit the clamp; pre-clamp bytes).
- `content` otherwise (full body, since either no clamp ran OR the plugin-tool branch's new clamp just ran and set `rawForBlob`).

### Universal clamp on plugin tools

Added in `src/agent.ts` right after the plugin's `TUIResult` is bound, parallel to what `executeTool` already does for built-ins. Same 64 KB / 1000-line budgets, same `[truncated: ...]` notice, same `_truncInfo` populated for the renderer. Skipped only when the plugin set `display` (those tools render their own audience-split body and would be mangled by a post-hoc clamp).

The clamp was always safe in principle. We held it back until the blob store made the raw recoverable.

### Per-tool resume hints

`src/tools/truncation.ts:defaultHint` learned about `Fetch` and `WebSearch`. The generic fallback now also references the `[raw-output: ...]` path so plugin tools we don't know about still steer the model toward the full bytes instead of a re-run.

### System-prompt blurb

`src/headers.ts:buildToolOutputConventionsParagraph` produces one short section, gated on `blobStoreEnabled`. When the blob store is enabled, the system prompt's `system[2]` carries a `# Tool output conventions` block telling the model how the footer works. When disabled, the block is empty and the prompt is byte-identical to the pre-feature shape (cache-key-stable).

The blurb is one paragraph, no per-tool repetition. The model learns the convention once.

### Config knobs

`~/.minimal-agent/config.jsonc :: plugins["blob-store"]`:

```jsonc
{
  "enabled": true,
  "minBytesToPersist": 4096,
  "maxBlobsPerSession": 1000,
  "maxBytesPerSession": 268435456,
  "skipTools": ["Task", "MemoryTool", "ShowDiff", "LockStatus"]
}
```

Plus `MINIMAL_AGENT_BLOB_STORE_DISABLED=1` as a hard env opt-out (mirrors the file-lock plugin's pattern).

### LRU eviction

On every successful blob write, `BlobStore.evictIfOverCap(justWrittenId)` walks the directory sorted oldest-first and unlinks until both caps (count + bytes) are satisfied OR only the just-written id remains. The just-written id is protected even when it alone exceeds `maxBytesPerSession` (would be absurd to evict the write that triggered the eviction; a single blob bigger than the cap is a config-tuning issue, not a runtime concern).

## Options considered

### Option A (chosen): blob store + pointer footer

What landed. Pros and cons listed above.

### Option B: Inline `raw_bytes` block in `tool_result.content`

Keep everything inline. The clamp still fires for the API copy, but the JSONL would carry an additional `rawContent` field with the full bytes.

- Eliminates one indirection. Model doesn't need `Read`.
- Bloats the JSONL with every large body. A single Fetch of a 5 MiB page makes one log line 5 MiB.
- Session-replay code path has to know to skip the raw field.
- Defeats the cache key (size deltas show up in prompt hashing).

Rejected. The pointer footer is the right abstraction. Disk is cheap, the model already knows how to `Read`.

### Option C: New `RawOutput` tool

Add a `RawOutput({tool_use_id})` tool that fetches blob bytes by id.

- Cleaner conceptually (no need to expose a filesystem path to the model).
- Adds an API surface we'd have to keep working forever.
- Makes the path opaque, which complicates `Bash` workflows (the model can't pipe it through `wc`, `head`, `grep`).
- Requires the model to learn a new tool. The path-based footer reuses `Read` which the model already knows.

Rejected. Maybe revisit if filesystem-path leakage becomes a security concern (it isn't today; the blob path is under the user's home dir, same trust level as everything else the agent reads).

### Option D: Keep plugin tools out of the universal clamp

The original plan. Plugin tools never clamped, only built-ins.

- Less behavior change to ship.
- Inconsistent ceiling. A 5 MiB Fetch result still blows the context up.
- The blob-store makes the consistent-ceiling design free. Raw bytes are recoverable, so the clamp loses its destructive sting.

Rejected on the second pass once the user pushed back on the inconsistency.

## What landed

```
 src/blob-store.ts                            NEW  (358 lines)
 src/blob-store.test.ts                       NEW  (41 tests)
 src/agent.blob-store.integration.test.ts     NEW  (8 tests)
 src/agent.ts                                 modified
 src/client.test.ts                           +3 conventions-paragraph tests
 src/headers.ts                               +buildToolOutputConventionsParagraph
 src/index.ts                                 +BlobStore construction
 src/session-store.ts                         +ToolResultRecord.rawPath/Bytes/Sha256
 src/tools.ts                                 +ToolExecResult._raw, executeTool clamp ferries it
 src/tools.test.ts                            +5 _raw-surface tests
 src/tools/truncation.ts                      +Fetch/WebSearch hints; generic hint references blob
 src/tools-bash-cd.test.ts                    afterAll restores bashCwd (pre-existing leak)
```

And in the ma-fetch-plugin repo:

```
 handlers/fetch.ts                            +normalizeMarkdown (whitespace stopgap)
 handlers/fetch.test.ts                       +10 normalizer tests + 1 expectation tweak
```

## Verification

| Step | Result |
|------|--------|
| `bun run typecheck` (tsgo + tsc fallback) | green |
| `bun run lint` (oxlint) | green |
| `bun run format:check` (biome) | green |
| `bun run docs:check` (typedoc) | green |
| `bun test` minimal-agent (3086 tests) | 3078 pass, 7 skip, 1 fail (pre-existing `metadata` test unrelated to this work; fails on clean main too) |
| `bun test` ma-fetch-plugin (141 tests) | all pass |
| Manual end-to-end smoke (`yes BIG \| head -c 128000` through real Bash) | blob 127999 B, footer rendered, JSONL fields populated, sha matches |

## Bug fixed along the way

`src/tools-bash-cd.test.ts` was mutating the module-level `bashCwd` in `src/tools.ts` via real `executeTool("Bash", { command: "cd <tmpdir>" })` calls, then deleting the tmp dir in its `afterAll`. `bashCwd` stayed pointing at the vanished directory. Subsequent tests that actually spawned bash via `executeTool` got `ENOENT … posix_spawn 'bash'` because Bun.spawn can't start a subprocess in a deleted cwd.

The bug was silent before this change set because no test downstream of `tools-bash-cd.test.ts` was actually spawning real bash via `executeTool` (most agent tests use a fake `sendFn` that never reaches the dispatch path). The new `agent.blob-store.integration.test.ts` is the first to actually spawn bash after the leak, so it surfaced.

Fix in the `afterAll`: restore `bashCwd` to `realpathSync(process.cwd())` before the `rmSync`. Three-line change with a doc comment pointing at the integration test that exposed it.

## Out of scope (filed in TODOS.md)

- `T-a4f8c1` global `<sid>.blobs/` garbage collection (per-session LRU is in place; old-session cleanup is the remaining piece).
- `T-b8c2d3` hardlink parent blobs into child blob dir on session fork.
- `T-c91d4e` push the markdown whitespace fix upstream into obscura.
- `T-d72f5a` wire the blob-store's `_log.jsonl` diagnostic feed (helper exists, no callers yet).
- `T-e83g6b` `alwaysPersist: true` mode for full-fidelity workflows.

## Disabling

Set either:

```jsonc
// ~/.minimal-agent/config.jsonc
{
  "plugins": {
    "blob-store": { "enabled": false }
  }
}
```

Or for one-off invocations:

```bash
MINIMAL_AGENT_BLOB_STORE_DISABLED=1 minimal-agent ...
```

With either, the system prompt's `# Tool output conventions` block is empty, no blobs are written, no pointer footer is appended, JSONL `rawPath`/`rawBytes`/`rawSha256` stay unset. Pre-feature behavior byte-for-byte.

The universal clamp on plugin tools stays in place regardless. If you want to keep plugin tools unclamped too, the right knob does not exist yet. Open an issue, or set `MAX_TOOL_OUTPUT_BYTES` higher upstream in `src/tools/truncation.ts`.
