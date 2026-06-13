---
title: Supporting modules
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
tags: [tui, stdio-interceptor, ansi-stream, term-caps, theme, overlay, picker, quit-modal]
taillog:
 - "2026-05-27T10:14:30.725679000-0400 | Initial: smaller modules in src/ui/ + ansi-stream + theme"
---

# Supporting modules

The smaller pieces in `src/ui/` plus `AnsiStreamBuffer`. None of these are individually big but they each carry a sharp invariant.

## `StdioInterceptor`  (`src/ui/stdio-interceptor.ts`, 155 LOC)

The interceptor patches every write surface so a stray `console.log` from a library can't tear a hole in the live area.

Three surfaces to intercept:

1. **`process.stdout.write` / `process.stderr.write`** - patched in place to forward through `compositor.writeStream` (after `AnsiStreamBuffer` holds back any partial CSI tail).
2. **`console.log` / `console.error` / `console.warn` / `console.info` / `console.debug`** - Bun writes these directly to fd 1/2, bypassing `process.stdout.write`. Patching `process.stderr.write` alone misses every `console.error`. The console methods are swapped to format-and-forward through the (now-patched) process streams.
3. **`rawStdoutWrite` / `rawStderrWrite`** - escape hatches the compositor itself uses for its own escape sequences. Without these, the compositor's `ESC[?25l` etc. would recurse through the wrapper and feed back into `writeStream`.

Wired in `src/index.ts`:

```ts
const compositor = new Compositor({
  output: {
    isTTY: process.stdout.isTTY,
    get columns() { return process.stdout.columns },
    get rows()    { return process.stdout.rows },
    write: (s) => interceptorRef
      ? interceptorRef.rawStdoutWrite(s)
      : process.stdout.write(s),    // pre-install fallback
  },
  syncOutput: syncProbe.syncOutput,
})
const interceptor = new StdioInterceptor(compositor)
interceptorRef = interceptor
// ... build editor ...
interceptor.install()  // from this point on, all writes route through compositor
```

The `interceptorRef` two-phase wiring is intentional: the compositor can't reference the interceptor at construction time because the interceptor needs the compositor first.

## `AnsiStreamBuffer`  (`src/ui/terminal/ansi-stream.ts`, 126 LOC)

A pure split-buffer that holds back any partial CSI or OSC sequence at the end of a chunk so downstream consumers never see a chunk ending mid-escape.

Why it matters: the compositor wraps every chunk with its own `ESC[?25l` + cursor moves + `ESC[K`. If the caller forwards a chunk ending with a partial CSI like `\x1b[38;2;180;` and the compositor immediately appends `❯ \x1b[K...`, the terminal's parser glues them as one malformed escape and prints fragments as literal text.

```ts
class AnsiStreamBuffer {
  push(incoming: string): string   // returns escape-safe prefix
  flush(): string                  // drain on EOF
}
```

Bounded retention: at most `MAX_PENDING = 4096` bytes held back. A runaway OSC longer than that is flushed as-is. Better to draw garbage than to stall the stream forever.

Used in three places:

1. **Compositor's `streamAnsi`** - for chunks coming through `writeStream`.
2. **StdioInterceptor's per-stream buffers** (`stdoutAnsi`, `stderrAnsi`) - for chunks coming through the patched write surfaces.
3. **Formatter pipe** - if the formatter spawns a subprocess (`mdstream`), its stdout is buffered before reaching the interceptor.

## `term-caps`  (`src/ui/term-caps.ts`, 138 LOC)

Active capability probes that ask the terminal what it supports.

### Synchronized output (DEC mode 2026)

The only capability currently probed. Used by the compositor to wrap multi-step redraws in BSU/ESU so the user sees an atomic frame.

```
Send:  CSI ? 2026 $ p             (DECRPM request mode)
Reply: CSI ? 2026 ; <n> $ y       where <n>:
         0 = mode not recognized → unsupported
         1 = currently set       ┐
         2 = currently reset     │ supported (n ∈ {1..4})
         3 = permanently set     │
         4 = permanently reset   ┘
       no reply in timeout → assume unsupported
```

Why active probe instead of `TERM_PROGRAM` allowlist: modern emulators advertise mode 2026 via DECRPM, which is the canonical way. An allowlist rots - every new terminal (Ghostty, recent kitty, recent Konsole) would need to be added by hand. The DECRPM probe just works.

### Stdin handling

`detectSyncOutput` MUST run before any other consumer attaches a `data` listener to stdin (in particular, before `EditorController.start`), because it puts stdin into raw mode briefly and reads bytes synchronously. Any leftover bytes after the reply (typeahead the user managed to send during detection) are returned in `result.unparsed` so the caller can re-emit them to the next consumer. `src/index.ts` does exactly that.

## `theme`  (`src/ui/theme.ts`, 27 LOC)

Tiny: a `Theme` object with SGR strings keyed by semantic name (`primary`, `success`, `error`, `dim`, etc.). Two pre-defined themes: `DARK` and `LIGHT`. `detectNerdFont()` returns true when `NERD_FONT` env var is set or `TERM_PROGRAM === "iTerm.app"`.

Most of the actual color decisions live in `src/palette.ts` (the shared lime/pink/orange palette) and in the spinner library. This file is barely used at the moment.

## `overlay`  (`src/ui/overlay.ts`, 19 LOC)

Interface only:

```ts
interface LiveOverlay {
  render(width: number): string[]
  onKey(key: OverlayKey): "stay" | { close: true; result: unknown }
  rowsHint?(): number
}

type OverlayKey =
  | { name: "up" } | { name: "down" } | { name: "left" } | { name: "right" }
  | { name: "enter" } | { name: "escape" } | { name: "tab" }
  | { name: "char"; ch: string } | { name: "ctrl"; ch: string }
```

The contract: render top-to-bottom rows for the live area; handle a normalized key; close with a `result` when done. Used by `QuitModal` and by future plugin-side overlays.

## `picker`  (`src/ui/picker.ts`, 173 LOC)

Generic vertical picker primitive. Pure data + rendering. No dependency on the compositor or terminal IO; the caller owns key event delivery and writes the rendered rows to the screen.

```ts
new Picker<V>({
  title?,
  footer?,
  items: PickerItem<V>[],
  initial?: number,
  pageSize?: number,
})

picker.onKey(key: PickerKey): PickerResult<V>
picker.selectedIndex: number
picker.selected: PickerItem<V> | null
picker.render(width: number): string[]
```

Page-aware (`up`, `down`, `pageup`, `pagedown`, `home`, `end`, `enter`, `escape`). Skips disabled items in both directions. Used by `--list-models`, `--list-spinners`, and any plugin that wants a quick "pick one of these" overlay.

## `quit-modal`  (`src/ui/quit-modal.ts`, 38 LOC)

The simplest possible `LiveOverlay`. Three rows:

```
  Quit minimal-agent?

  [ Yes ]   ❮ No ❯
```

Tab / arrows toggle selection, Enter confirms, `y`/`n` are shortcuts. Result is `boolean`.

Useful as a reference implementation for new overlays.

## `scrollback-guard`  (`src/ui/scrollback-guard.ts`, 14 LOC)

```ts
class ScrollbackGuard {
  reserve(n: number): void
  writeAt(line: number, content: string): void
  release(): void
}
```

Pre-allocates `n` lines at the bottom of the viewport by scrolling them up first, then writes to specific reserved lines via save/restore-cursor. Currently UNUSED in the live REPL path - the compositor's redraw cycle has a different ownership model. Kept around for legacy callers and as a building block for future region-pinned UIs that don't need the compositor's separator/cols-drift discipline.

## What's missing

There's no central "UI registry" or service locator. The compositor and the editor controller are each constructed once in `src/index.ts` and passed by reference. Plugins reach the editor via the host-bridge surface (`editor.footer.set`, etc.) which is wired in `src/agent.ts` and the plugin loader. If you find yourself wanting a global "where's the compositor?" lookup, that's a smell - pass it as a constructor arg.
