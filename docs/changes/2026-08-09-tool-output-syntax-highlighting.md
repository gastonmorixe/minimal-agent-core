# Tool-output syntax highlighting

Tool transcript code now reuses mdstream's syntect engine without putting a parser or npm runtime dependency in core.

## Behavior

- `Read` highlights only when the file's exact name, extension, or first-line shebang identifies a language with high confidence. Line numbers remain a separate dim gutter and the existing `╭ │ ┊ ╰` transcript frame, width clamp, line budget, and truncation footer remain host-owned.
- `Edit` and `Write` highlight diff payloads as source code. The `+` / `-` marker keeps the existing bright lime / pink semantic color, each changed payload row receives a soft 22%-toward-black background wash, and syntax-token foregrounds remain readable above it. File and hunk headers remain structural and unwashed.
- Markdown files (`.md`, `.mdx`, and exact `README.md`) use mdstream's Markdown syntax, including inline/fenced-code tokens. Ambiguous extensionless prose, logs, text, CSV/TSV, unknown extensions, already-ANSI output, Bash output, Grep output, and arbitrary plugin displays are not guessed or recolored.
- Highlighting is presentation-only. Model-facing `tool_result.content`, raw-output blobs, and file contents remain plain text.

## Latency and failure policy

When the configured formatter executable is mdstream, core starts a dedicated `mdstream --highlight-server` JSONL sidecar during startup. mdstream eagerly loads its syntax/theme assets before its ready handshake, so tool rendering does not pay the roughly 20 ms cold syntax cost. Requests are serialized through the persistent process.

The client probes the additive protocol-v2 ready fields and only sends native mixed-diff requests when `modes` advertises `unified-diff`. The client has bounded handshakes/responses and fails closed: timeout, malformed JSON, process exit, an unknown formatter, an older server, a correlated mode error, or unbalanced per-line ANSI falls back to the local dual-stream compositor or the pre-existing plain diff. A bad mixed-diff request does not disable later raw Read highlighting. The sidecar never writes stderr into the TUI and is closed during host teardown.

## Protocol and rollout

Protocol-v2 readiness is additive and remains compatible with clients that only inspect `ready:1`:

```json
{"ready":1,"protocol":2,"modes":["raw","diff-wash","unified-diff"]}
```

Raw source request (also the legacy absent-mode shape):

```json
{"id":1,"language":"typescript","code":"const x = 1"}
```

Native mixed-diff request:

```json
{"id":2,"mode":"unified-diff","language":"typescript","code":"-old()\n+newCall()","diffStyle":"bg-wash","colors":{"inserted":"#87ff00","deleted":"#ff00af"}}
```

Success and fail-closed responses correlate by id:

```json
{"id":2,"ansi":"..."}
{"id":2,"error":"..."}
```

The server is sequential, preserves logical line endings and trailing-newline shape, keeps independent old/new multiline lexical streams, emits a balanced reset on every styled non-empty line, and adds no Markdown frame, line numbers, or padding. Core owns the transcript frame, width clamp, line budget, titles, and fallback. Rollout therefore needs no feature flag: protocol/capability probing selects native mode when present, while older or invalid servers retain the local compositor and existing plain rendering.

## Validation

Focused tests drive both protocol versions, malformed/correlated errors, split JSONL chunks, local composition, Markdown and source Reads, Edit/Write mixed diffs, final empty rows, semantic palette overrides, and the no-ANSI model-content invariant. End-to-end validation also runs real `mdstream --highlight-server` output through `executeToolRound` for Read, Edit, and Write, then checks the host frame, bright markers, soft full-row washes, syntax foregrounds, line resets, and plain model-facing results before the full core and mdstream gates are accepted.
