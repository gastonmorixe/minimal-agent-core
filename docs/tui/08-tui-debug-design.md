---
title: --tui-debug design
created_at: "2026-05-27T10:14:30.725679000-0400"
updated_at: "2026-05-27T10:14:30.725679000-0400"
session_id: 4aa1cfdf-7a42-47ce-8b99-c7612a39e167
host_info:
  hostname: macbookpro.home.arpa
  user: gaston
  os: "macOS 26.5 (25F71)"
  kernel: "25.5.0"
  arch: arm64
  serial: FHQ93DD9T6
tags: [tui, debug, design, cli-flag, proposal]
taillog:
 - "2026-05-27T10:14:30.725679000-0400 | Initial proposal: region tints, copy-paste markers, HUD, frame markers"
---

# `--tui-debug` design

A CLI flag that lets the user (and me, when they paste output back) see what the TUI is doing in real time. This is a design doc, not yet wired in.

## Goals

1. **See who owns each row** in the live area at a glance (region tints).
2. **Copy-paste help**: when the user pastes a screenshot back, I should be able to identify what came from which producer (markers).
3. **Live counters HUD**: dump compositor state on every paint so we can correlate visual symptoms with internal state.
4. **Frame markers in scrollback** (optional): emit a comment row before each frame so historical scrollback also tells the story.

Zero overhead when the flag is off - no extra string concatenation, no extra writes.

## Flag shape

```
--tui-debug                       # enables the bundle: regions + tags + hud
--tui-debug=regions               # background tinting only
--tui-debug=tags                  # row tags only
--tui-debug=hud                   # counter HUD only
--tui-debug=frames                # frame markers in scrollback (very noisy)
--tui-debug=regions,tags,hud      # csv subset
--tui-debug=off                   # explicit off (same as omitting the flag)
```

Also honored: `MINIMAL_AGENT_TUI_DEBUG=regions,tags` env var with identical syntax.

## Mockup

```
--tui-debug=regions,tags,hud   (mockup; real version uses bg colors)
--------------------------------------------------------------------------------------------

  > what files do we have?
  Here is the listing...
  src/ui/compositor.ts
  ...

~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  [HUD]   cols=92 liveH=8 cursorRow=5 streamCol=0 sepRows=1 lastDrawCols=92
  [S]    Thinking... 12s  1234 tok                                       [s]
  [D0]   queue: 3 pending                                                [d0]
  [G]                                                                     [g]
  [I]    >  ------------------------------------------- ASK              [i]
  [E0]   > type your prompt here                                         [e0]
  [E1]     continuation row                                              [e1]
  [F-]                                                                   [f-]
  [F0]   context 42%  quota 88%                                          [f0]

~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  Each row shows its segment tag at both ends; user copy-paste shows you
  exactly which rows came from which producer.
```

## Tag taxonomy

| tag | meaning |
|---|---|
| `[HUD]` | the counter dump (only if `hud` is enabled) |
| `[S]` | status row |
| `[Dn]` | decoration row n (zero-indexed) |
| `[G]` | gap (blank) row |
| `[I]` | scroll indicator row |
| `[En]` | editor row n (zero-indexed, post-wrap) |
| `[F-]` | footer spacer (blank) |
| `[Fn]` | footer row n (zero-indexed) |

Lowercase variants (`[s]`, `[d0]`, …) on the right side of the row let copy-paste preserve the start *and* end tag, so even when wrapping mangles the middle the boundaries are intact.

## Implementation sketch

### A new module: `src/ui/tui-debug.ts`

A tiny singleton with getters. Read once at startup from the parsed flag, then queried hot-path by `EditorController.repaint` and `Compositor.writeBufferedStream`.

```ts
// src/ui/tui-debug.ts
export type TuiDebugMode = "regions" | "tags" | "hud" | "frames"

export class TuiDebug {
  private modes = new Set<TuiDebugMode>()

  configure(spec: string | null): void {
    this.modes.clear()
    if (!spec || spec === "off") return
    for (const m of spec.split(",").map(s => s.trim()).filter(Boolean)) {
      if (m === "on" || m === "all") {
        this.modes.add("regions"); this.modes.add("tags"); this.modes.add("hud")
      } else if (isMode(m)) {
        this.modes.add(m)
      }
    }
  }

  has(m: TuiDebugMode): boolean { return this.modes.has(m) }
  get enabled(): boolean { return this.modes.size > 0 }
}

export const tuiDebug = new TuiDebug()
```

Wire-up in `src/cli-args.ts`:

```ts
// add the flag to the alias table
const LONG_ALIAS = { ... }   // no alias needed
// no short flag

// In src/index.ts boot, after normalizeArgs:
const tuiDebugIdx = args.indexOf("--tui-debug")
if (tuiDebugIdx !== -1) {
  const v = args[tuiDebugIdx + 1]
  // accept --tui-debug (no value) as "on"
  const spec = (v && !v.startsWith("-")) ? v : "on"
  tuiDebug.configure(spec)
} else if (process.env.MINIMAL_AGENT_TUI_DEBUG) {
  tuiDebug.configure(process.env.MINIMAL_AGENT_TUI_DEBUG)
}
```

### Region tinting

In `EditorController.repaint`, just before assembling `finalLines`:

```ts
if (tuiDebug.has("regions")) {
  const paint = (lines: string[], bg: number) =>
    lines.map(l => `\x1b[48;5;${bg}m${l}\x1b[K\x1b[49m`)
  head = paint(head, 52)        // dark red
  decoration = paint(decoration, 58)  // dark yellow
  gap = paint(gap, 235)         // very dark gray
  if (indicatorLine) indicatorLine = paint([indicatorLine], 23)[0]  // dark cyan
  lines = paint(lines, 22)      // dark green
  composedFooter = paint(composedFooter, 53)  // dark magenta
  // (footer spacer left untinted so it's visibly a gap)
}
```

`\x1b[K` paints the bg color across the full row, not just behind the content. `\x1b[49m` resets only the background, leaving any inline FG color intact.

### Copy-paste tags

```ts
if (tuiDebug.has("tags")) {
  const tag = (l: string, lhs: string, rhs: string, cols: number) => {
    const visible = displayWidth(l)
    const pad = Math.max(1, cols - displayWidth(lhs) - displayWidth(rhs) - visible)
    return `\x1b[2m${lhs}\x1b[22m${l}${" ".repeat(pad)}\x1b[2m${rhs}\x1b[22m`
  }
  // apply per-segment as above, with lhs/rhs from the taxonomy
}
```

Tags use `\x1b[2m` (dim) so they're visually quiet but copy intact (most terminals copy plain glyphs, not the SGR styling).

Cursor math: when tags are enabled, `finalCursor.col` must be shifted right by `displayWidth(lhs)` for the row the cursor lands on. Single-line addition to the existing cursor calculation.

### HUD row

Easiest implementation: register a `FooterLayer` with a high-ish priority below the existing armed layer:

```ts
const FOOTER_LAYER_HUD = "tui-debug-hud"
const FOOTER_PRIORITY_HUD = 25   // above default, below overlay

if (tuiDebug.has("hud")) {
  controller.setFooterLayer(FOOTER_LAYER_HUD,
    [`[HUD] cols=${cols} liveH=${comp.liveHeight} cursorRow=${...} streamCol=${...} sepRows=${...}`],
    { priority: FOOTER_PRIORITY_HUD })
}
```

Updated on every `repaint`. The compositor's drawn-key dedup short-circuits when the HUD didn't change, so the cost is one extra string allocation per paint.

Compositor exposes its internal counters via a `debugSnapshot()` method (new, gated to non-production builds or always-on but cheap):

```ts
// compositor.ts
debugSnapshot(): {
  liveHeight: number
  cursorRowInLive: number
  streamCol: number
  sepRowsAboveLive: number
  lastDrawColumns: number
  consecutiveNewlines: number
  syncOutput: boolean
} {
  return { ... }
}
```

### Frame markers

In `writeBufferedStream`, when `tuiDebug.has("frames")`:

```ts
parts.push("\n")
parts.push(`\x1b[2m▒▒▒ FRAME ${++frameSeq} writeBufferedStream chunk=${chunk.length}B ▒▒▒\x1b[22m\n`)
```

Emitted *before* the erase sequence so the marker stays in scrollback. Bumps `consecutiveNewlines` so the cap is respected. Very noisy - only use when actively debugging a specific symptom.

## What this enables

| Symptom | Mode to enable | What you see |
|---|---|---|
| "the prompt drifts down by one row over time" | regions | the gap band stays one color; if the editor band moves down, the gap grew |
| "stale status row stuck above the prompt" | regions | a stripe of the old status color sitting in scrollback above the live area |
| "cursor lands one cell to the left of where I'm typing" | tags + hud | `cursorRow=…` reported by HUD vs the tag on the row containing the cursor |
| "live area collapses on resize" | hud, then resize the terminal | watch `liveHeight=…`, `lastDrawCols=…` track the resize |
| "rare frame corruption that I can't reproduce" | frames | scroll back to the frame marker matching the timestamp the user saw |

## What this does NOT do

- It does NOT add a separate alternate-screen "debug overlay". The compositor model is fundamentally inline; trying to bolt on a side panel would defeat the scrollback-friendly design.
- It does NOT replace `--debug`, which controls Anthropic API request/response logging. That's orthogonal.
- It does NOT touch the input path. If you want to see what bytes stdin received, that's a separate `MINIMAL_AGENT_INPUT_TRACE=1`-style debug surface (not in scope here).

## Open questions for review

1. **Default behavior of bare `--tui-debug`**: I picked `regions + tags + hud` (drop `frames` because of noise). Alternative: just `hud` (minimal disruption) or just `regions` (most visual).
2. **HUD position**: footer layer at priority 25 means it gets obscured by an open slash-menu (overlay layer = 50). Alternative: insert above the status row (would push editor down by 1; consistent debug-tax).
3. **Tag style**: dim + bracketed (`[S]`) vs. background-tinted single-char (`▓`). Brackets win on copy-paste, single-char wins on screen real estate. I'd go brackets.
4. **Region colors**: I picked muted 8-bit codes (52, 58, 22, 23, 53). Worth checking against light-theme terminals; if the user's bg is white the darks are still readable, but a `--tui-debug-theme=light` variant could flip to pastels.
5. **Should this be a plugin?** It's small enough to live in core (`src/ui/tui-debug.ts`). Going plugin-route would mean adding a plugin entry in the manifest and routing repaints through a hook. Probably overkill, but worth considering for cleanliness.

## Next step

Wire `src/ui/tui-debug.ts` + `src/cli-args.ts` parsing + minimal regions-only support in `EditorController.repaint`. Validate visually, then layer tags + HUD + frames incrementally. Each can land independently behind its own mode flag.
