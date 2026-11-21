/**
 * Plugin-aware output stream wrapper.
 *
 * Sits between the agent's text-chunk generator and the terminal (or a
 * formatter subprocess). Routes every chunk through the codec scanner of the
 * load (`loader.sideband().scanner(...)` with `strictV1`, the grammar of the
 * old core `TagScanner`, so no event changes): plain text bytes go straight
 * to the sink, detected inline tags are dispatched through the
 * {@link PluginLoader}, and the rendered ANSI replaces the tag in the output.
 *
 * **No codec:** the load has no codec (`sideband.ready` is false, for
 * example the codec failed to load) but can still have inline-tag handlers.
 * Then the core {@link TagScanner} stays the engine, so inline tags work as
 * before. It is the only caller of `TagScanner`.
 *
 * **Critical design choice:** the common case (text-only, no tags) must
 * remain fully synchronous. An `async` path per chunk introduces microtask
 * boundaries that fragment the data flow to external formatters like
 * mdstream, breaking realtime rendering. The `feed()` method returns
 * `undefined` (sync fast path) when no async work is needed, and a
 * `Promise` only when an inline tag requires async handler dispatch.
 * Callers must use `const p = stream.feed(chunk); if (p) await p;` to
 * avoid unnecessary microtask overhead.
 *
 * @module plugins/stream
 */

import type { PluginLoader } from "./loader.ts"
import { TagScanner, type TagSpan } from "./scanner.ts"

type StreamEvent = { type: "text"; data: string } | { type: "tag"; span: TagSpan }

/** The scanner calls of the stream: the codec scanner or the core fallback. */
interface ChunkScanner {
  write(chunk: string): void
  end(): void
}

/**
 * The codec scanner of the load with the core grammar (`strictV1`, code
 * aware, no `kinds` filter: each `<ma::emit::NAME>` name, as `TagScanner`
 * read). No codec: the core `TagScanner`. A loader with no `sideband`
 * function (a host test double) is the no-codec case too.
 */
function makeScanner(loader: PluginLoader, push: (ev: StreamEvent) => void): ChunkScanner {
  const sideband = typeof loader.sideband === "function" ? loader.sideband() : undefined
  if (sideband?.ready !== true) {
    return new TagScanner({
      onText: (data) => push({ type: "text", data }),
      onTag: (span) => push({ type: "tag", span }),
    })
  }
  const sc = sideband.scanner({ codeAware: true, strictV1: true })
  sc.onText((data) => push({ type: "text", data }))
  sc.onNode((node, raw) =>
    push({
      type: "tag",
      span: {
        name: node.kind,
        attrs: { ...node.attrs },
        body: node.body ?? "",
        self_closing: node.selfClosing,
        raw,
      },
    }),
  )
  return sc
}

/**
 * Callable shape of a sink: a sync function that receives final bytes and
 * writes them to stdout or a formatter. Throwing from the sink is not
 * recovered; the caller is expected to handle that.
 */
export type StreamSink = (chunk: string) => void

/**
 * Scanner + dispatcher wrapper around a sink.
 *
 * Lifecycle: construct -\> `feed(chunk)` (many) -\> `await end()`.
 */
export class PluginStream {
  private scanner: ChunkScanner
  private queue: StreamEvent[] = []
  private sink: StreamSink
  private loader: PluginLoader
  private agentCwd: string

  constructor(sink: StreamSink, loader: PluginLoader, agentCwd: string) {
    this.sink = sink
    this.loader = loader
    this.agentCwd = agentCwd
    this.scanner = makeScanner(loader, (ev) => this.queue.push(ev))
  }

  /**
   * Feed a chunk through the scanner and flush events to the sink.
   *
   * Returns `undefined` when all events are text (synchronous fast path,
   * no microtask overhead). Returns a `Promise` only when a tag event
   * requires async handler dispatch.
   *
   * Callers MUST handle both returns:
   * ```ts
   * const p = stream.feed(chunk);
   * if (p) await p;
   * ```
   */
  feed(chunk: string): Promise<void> | undefined {
    this.scanner.write(chunk)
    return this.drainMixed()
  }

  /**
   * End the stream. Flushes any in-flight scanner capture as raw text.
   * Always async because the final flush may contain deferred tag events.
   */
  async end(): Promise<void> {
    this.scanner.end()
    const p = this.drainMixed()
    if (p) await p
  }

  /**
   * Drain queued events. Processes text events synchronously in a tight
   * loop. If a tag event is encountered, switches to async dispatch and
   * returns a Promise for the remainder. Returns undefined when all
   * events were handled synchronously.
   */
  private drainMixed(): Promise<void> | undefined {
    while (this.queue.length > 0) {
      const ev = this.queue[0]
      if (ev.type === "text") {
        this.queue.shift()
        this.sink(ev.data)
        continue
      }
      // Tag event: switch to async path for the remaining queue.
      return this.drainAsync()
    }
    return undefined
  }

  private async drainAsync(): Promise<void> {
    while (this.queue.length > 0) {
      const ev = this.queue.shift()!
      if (ev.type === "text") {
        this.sink(ev.data)
        continue
      }
      const span = ev.span
      if (!this.loader.hasInlineTag(span.name)) {
        this.sink(span.raw)
        continue
      }
      try {
        const result = await this.loader.dispatch(
          {
            type: "inline_tag",
            name: span.name,
            attrs: span.attrs,
            body: span.body,
            self_closing: span.self_closing,
          },
          this.agentCwd,
        )
        if (result.kind === "rendered" && result.ansi) {
          this.sink(result.ansi)
        } else {
          this.sink(span.raw)
        }
      } catch {
        this.sink(span.raw)
      }
    }
  }
}
