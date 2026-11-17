# /// script
# requires-python = ">=3.10"
# dependencies = ["rich"]
# ///
"""Render the diagrams + tables for docs/network/how-a-pasted-image-reaches-the-model.md."""
import io
import sys

sys.path.insert(0, "/Users/gaston/.agents/skills/ascii-renderer/scripts")
from grid_buffer import Grid  # noqa: E402
from rich import box  # noqa: E402
from rich.console import Console  # noqa: E402
from rich.table import Table  # noqa: E402

BORDER = "┌─┐│┘─└│"


def card(g: Grid, x: int, y: int, w: int, lines: list[str]) -> int:
    """Box with left-aligned lines; returns the bottom y (exclusive)."""
    h = len(lines) + 2
    g.box(x, y, w, h, border=BORDER)
    for i, s in enumerate(lines):
        assert len(s) <= w - 4, (s, len(s))
        g.text(x + 2, y + 1 + i, s)
    return y + h


def down(g: Grid, x: int, y: int, n: int = 2) -> int:
    for i in range(n - 1):
        g.set(x, y + i, "│")
    g.set(x, y + n - 1, "▼")
    return y + n


def flow() -> str:
    W, COLW, GAP = 112, 34, 4
    xs = [0, COLW + GAP, 2 * (COLW + GAP)]
    g = Grid(W, 46)
    heads = ["1. CAPTURE  (terminal, CLI)", "2. SUBMIT  (core)", "3. WIRE  (anthropic plugin)"]
    for x, h in zip(xs, heads):
        g.text(x, 0, h)
        g.hline(x, 1, len(h), "═")

    cols = [
        [
            ["iTerm2 Cmd+V on an image", "writes $TMPDIR/.../", "pasted-image-<ts>.png"],
            ["bracketed paste: abs path", "ESC[200~/var/…/x.png ESC[201~"],
            ["EditorController", ".interceptPaste(text)"],
            ["mediaPasteInterceptor", "looksLikeMediaDrop -> true", "Case 1: drag-and-drop"],
            ["registry.registerFileSync", "id = sha256(bytes)[0:8]", "   = 0411abd5"],
            ["prompt buffer shows token", "[Image #0411abd5 314x314", " 57KB]"],
        ],
        [
            ["Enter -> AgentCore round", "buildInitialUserContent()"],
            ["MediaResolverAdapter", ".resolveUserContent(text)"],
            ["ingestUserText", "materializeInlineImagePaths", "-> buildUserContent"],
            ["resolveMediaTurn", "parse token, registry.get", "checkMedia(limits, vision)"],
            ["inlineBase64Preparer", "item.bytes() -> base64", "(core never uploads)"],
            ["canonical user content", "[image block, text block]", "token text stripped"],
        ],
        [
            ["prepareMediaUploads (then)", ">= 1 MiB: POST /v1/files.", "57 KB: stayed inline. Now", ">= 10 B: uploads it"],
            ["anthropic-request.ts", "case 'image' ->", "{type:'image', source:", " {type:'base64', ...}}"],
            ["cache breakpoint on the", "last user block (turn 1)", "cache_control 5m"],
            ["adapter.ts", "JSON.stringify -> gzip", "Content-Encoding: gzip"],
            ["network/client.ts", "HTTP/2 POST", "/v1/messages?beta=true"],
            ["net-dbg observer tees", "req/res to ~/.minimal-", "agent/net-dbg/<run>/"],
            ["200 text/event-stream", "SSE -> model sees pixels"],
        ],
    ]
    bottoms = []
    for x, cards in zip(xs, cols):
        y = 3
        for i, c in enumerate(cards):
            y = card(g, x, y, COLW, c)
            if i < len(cards) - 1:
                y = down(g, x + COLW // 2, y, 1)
        bottoms.append(y)
    # hand-off arrows between columns, on the header row
    for i in (0, 1):
        g.text(xs[i] + COLW, 0, " " * (GAP - 3) + "──▶")
    out = g.render().splitlines()
    return "\n".join(l.rstrip() for l in out[: max(bottoms)])


def table(title: str, cols: list[str], rows: list[list[str]]) -> str:
    t = Table(title=title, box=box.SQUARE, show_lines=False, title_justify="left")
    for c in cols:
        t.add_column(c, overflow="fold")
    for r in rows:
        t.add_row(*r)
    buf = io.StringIO()
    Console(file=buf, width=140, color_system=None, legacy_windows=False).print(t)
    return "\n".join(l.rstrip() for l in buf.getvalue().splitlines())


evidence = table(
    "Evidence: one image, four places, one hash",
    ["Where", "What was found", "sha256[0:8]"],
    [
        ["$TMPDIR/.../pasted-image-20261117-064240-…png", "57,861 B PNG, born 06:42:40 (1 s before submit)", "0411abd5"],
        ["~/.minimal-agent/history.jsonl", 'submitted text "[Image #0411abd5 314x314 57KB]"', "0411abd5 (id)"],
        ["sessions/b3082610….jsonl  record #2", "user content[1] = {type:image, source:base64 image/png}", "0411abd5"],
        ["net-dbg/…/attempt-001-02-req-body.txt", "messages[0].content[1] image, 77,148 b64 chars", "0411abd5"],
    ],
)

wire = table(
    "Request 001 (the turn that carried the image)",
    ["Field", "Value"],
    [
        ["timestamp", "2026-11-17T11:42:41.540Z"],
        ["method / url", "POST https://api.anthropic.com/v1/messages?beta=true"],
        ["transport", "http2 (h2), new connection, no fallback"],
        ["content-encoding", "gzip   (req-body.txt is the pre-gzip JSON, 145,042 B)"],
        ["model / stream", "claude-opus-5-5 / true"],
        ["messages[0].content[0]", "text: <ma::agent::policy>Current local time …</ma::agent::policy>"],
        ["messages[0].content[1]", "image, base64, image/png, 314x314, 57,861 B decoded"],
        ["  cache_control", '{"type":"ephemeral","ttl":"5m"}  (first-turn breakpoint)'],
        ["user text block", "none: the token was the whole prompt and was stripped"],
        ["response", "200 text/event-stream, first byte +1426 ms, end +4143 ms"],
        ["usage", "cache_creation_input_tokens 25,240 (system + tools + image)"],
    ],
)

resend = table(
    "Every later request re-sends the same image",
    ["Attempt", "messages", "req JSON bytes", "image at", "cache_control"],
    [
        ["001", "1", "145,042", "messages[0]", "ephemeral 5m"],
        ["002", "3", "147,181", "messages[0]", "-"],
        ["003", "5", "197,226", "messages[0]", "-"],
        ["…", "…", "…", "messages[0]", "-"],
        ["019", "37", "306,651", "messages[0]", "-"],
    ],
)

files = table(
    "Code path (file -> function)",
    ["Step", "File", "Function"],
    [
        ["wire paste hooks", "minimal-agent-cli/src/startup/live-repl.ts", "setPasteInterceptor / setClipboardPasteHandler"],
        ["bracketed paste", "minimal-agent-cli/src/editor-controller.ts", "interceptPaste"],
        ["detect + register", "minimal-agent-core/src/media/paste-intercept.ts", "mediaPasteInterceptor"],
        ["drop heuristic", "minimal-agent-core/src/media/detect.ts", "looksLikeMediaDrop, parseDroppedPaths"],
        ["content id", "minimal-agent-core/src/media/id.ts", "mediaId = sha256[0:8]"],
        ["registry", "minimal-agent-core/src/media/registry.ts", "registerFileSync"],
        ["token grammar", "minimal-agent-core/src/media/token.ts", "formatMediaToken, parseMediaTokens"],
        ["user turn", "minimal-agent-core/src/sdk/agent-core-helpers.ts", "buildInitialUserContent -> mediaResolver"],
        ["adapter", "minimal-agent-core/src/adapters/media-resolver-adapter.ts", "MediaResolverAdapter"],
        ["ingest", "minimal-agent-core/src/media/ingest.ts", "resolveUserTurnContent, ingestUserText"],
        ["resolve", "minimal-agent-core/src/media/resolve.ts", "resolveMediaTurn, inlineBase64Preparer"],
        ["serialize", "minimal-agent-core/plugin-api/src/llm/anthropic-request.ts", "toAnthropicImageSource"],
        ["Files API gate", "minimal-agent-plugins/ma-llm-anthropic-plugin/media-upload.ts", "prepareMediaUploads (10 B default, env)"],
        ["Files API client", "minimal-agent-plugins/ma-llm-anthropic-plugin/files-api.ts", "uploadAnthropicFile (POST /v1/files)"],
        ["gzip + send", "minimal-agent-plugins/ma-llm-anthropic-plugin/adapter.ts", "gzipRequestBody"],
        ["capture", "minimal-agent-core/src/logging/net-dbg.ts", "net-dbg observer (netDbg: true)"],
    ],
)

which = table(
    "Why case 1 (path drop), not case 2 (empty paste + clipboard)",
    ["Check", "Result"],
    [
        ["TERM_PROGRAM", "iTerm.app 3.7.7"],
        ["temp file name", "pasted-image-<ts>-<uuid>.png: iTerm2 saves image pastes to $TMPDIR"],
        ["file birth vs submit", "06:42:40 vs 06:42:41.476: written by the terminal at paste time"],
        ["pngpaste on PATH", "no: clipboardImageSync() returns null on macOS without it"],
        ["registry origin", 'registerFileSync(path, "drop"), so the id comes from the file bytes'],
    ],
)

sections = {"FLOW": flow(), "EVIDENCE": evidence, "WIRE": wire, "RESEND": resend, "FILES": files, "WHICH": which}
for k, v in sections.items():
    print(f"@@{k}@@")
    print(v)
