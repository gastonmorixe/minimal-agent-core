/**
 * Generic SSE parser shared across providers.
 *
 * The Anthropic streaming API uses standard SSE:
 *
 * ```text
 * event: <type>\n
 * data: <json>\n\n
 * ```
 *
 * OpenAI Chat / Responses use the same with `data: [DONE]` as the
 * conventional terminator. The parser yields the raw parsed JSON
 * objects from each `data:` line; adapters map to their canonical
 * event stream.
 *
 * Line-buffered: accumulates bytes until newlines, then processes
 * complete lines. Handles partial chunks (one SSE event arriving
 * across multiple TCP segments) cleanly.
 *
 * ## Encoding contract
 *
 * The parser needs **uncompressed UTF-8**. Not every transport delivers that:
 * `Bun fetch` transparently decompresses gzip/br/zstd, while `node:http2`
 * sends no `accept-encoding` and hands over whatever the server returned,
 * including raw compressed bytes with no decompression anywhere. Fed raw gzip,
 * a plain `TextDecoder` produces zero events and no error, which reads as a
 * silent hang.
 *
 * Callers therefore pass the response `content-encoding` and the parser
 * enforces the contract:
 *
 * - absent / `identity` / `gzip` are accepted,
 * - anything else (`br`, `zstd`, `deflate`, …) throws an actionable error,
 * - `gzip` is sniffed on the gzip magic bytes (`1f 8b`): still-compressed
 *   bytes are inflated with `DecompressionStream`, and bytes a transport
 *   already inflated pass straight through.
 *
 * Only gzip is supported by design. It is the one encoding that both streams
 * incrementally under `Bun fetch` and is actually served by the OpenCode edge.
 * Bun's brotli/zstd decoders buffer the entire body, so accepting them would
 * trade a silent hang for a silent stall on every token.
 *
 * @module llm/streaming/sse-parser
 */

/** Gzip magic bytes. The only compression this parser inflates. */
const GZIP_MAGIC_0 = 0x1f
const GZIP_MAGIC_1 = 0x8b

/** Encodings that need no work: the bytes are already plaintext UTF-8. */
const PLAINTEXT_ENCODINGS: ReadonlySet<string> = new Set(["", "identity"])

/** Encodings the parser can turn into plaintext UTF-8. */
const SUPPORTED_ENCODINGS: ReadonlySet<string> = new Set(["", "identity", "gzip"])

/**
 * Throw when `contentEncoding` is a compression this parser cannot decode.
 *
 * Accepts absent, `identity` and `gzip`, case-insensitively and for comma
 * separated lists (`"identity, gzip"`). Everything else is rejected: brotli
 * and zstd buffered the whole body in measurement, and feeding their bytes to
 * `TextDecoder` yields nothing, silently.
 *
 * @param contentEncoding - Value of the response `content-encoding` header, or
 *   `null`/`undefined` when the header is absent.
 * @throws Error naming the offending encoding plus what the caller should do.
 */
export function assertDecodableEncoding(contentEncoding: string | null | undefined): void {
  if (contentEncoding === null || contentEncoding === undefined) return
  const tokens = contentEncoding
    .toLowerCase()
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "")
  const unsupported = tokens.filter((token) => !SUPPORTED_ENCODINGS.has(token))
  if (unsupported.length === 0) return
  const offenders = unsupported.join(", ")
  throw new Error(
    `sse_unsupported_content_encoding: response content-encoding is "${offenders}" ` +
      `(header value: "${contentEncoding}"), but parseSse only decodes identity or gzip. ` +
      `Fix: retry the request with "accept-encoding: gzip" (gzip decompresses incrementally, ` +
      `br/zstd buffer the entire body), or decompress the body before calling parseSse. ` +
      `Raw compressed bytes would make the parser yield no events and no error.`,
  )
}

/**
 * True when `chunk` starts with the gzip magic bytes.
 *
 * @param chunk - Candidate first chunk of a response body.
 * @returns `true` when the body still looks gzip-compressed.
 */
function looksGzipped(chunk: Uint8Array): boolean {
  return chunk.length >= 2 && chunk[0] === GZIP_MAGIC_0 && chunk[1] === GZIP_MAGIC_1
}

/**
 * Prefix `first` back onto `rest` so a sniffed first chunk is not lost.
 *
 * @param first - Chunk already consumed from the source reader.
 * @param rest - Reader positioned after `first`.
 * @returns A stream replaying `first` then the rest of `rest`.
 */
function replayStream(
  first: Uint8Array,
  rest: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let sentFirst = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true
        controller.enqueue(first)
        return
      }
      const { done, value } = await rest.read()
      if (done) {
        rest.releaseLock()
        controller.close()
        return
      }
      if (value !== undefined) controller.enqueue(value)
    },
    cancel(reason) {
      rest.releaseLock()
      void rest.cancel(reason)
    },
  })
}

/**
 * Pipe `stream` through a gzip `DecompressionStream`.
 *
 * The cast is only about lib typings: `DecompressionStream`'s writable side is
 * declared as `WritableStream<BufferSource>` while `pipeThrough` wants
 * `ReadableWritablePair<Uint8Array, …>`. Runtime behaviour is the standard
 * pipe, and `DecompressionStream` is what Bun documents for gzip inflation.
 *
 * @param stream - Gzip-compressed byte stream.
 * @returns Plaintext byte stream.
 */
function inflateGzip(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decompressor = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >
  return stream.pipeThrough(decompressor)
}

/** Options for {@link parseSse}. */export interface ParseSseOptions {
  /**
   * Value of the response `content-encoding` header.
   *
   * Pass it whenever it is available: it is what lets the parser reject an
   * encoding it cannot decode instead of silently yielding nothing.
   */
  contentEncoding?: string | null
}

/**
 * Yield each `data:` JSON object from a ReadableStream<Uint8Array>.
 * Stops when the upstream closes or sends `data: [DONE]`.
 *
 * @typeParam T - Shape of the parsed JSON objects. Adapter passes its
 *   own discriminated-union type.
 * @param body - Response body bytes: uncompressed UTF-8, or gzip when declared
 *   through `opts.contentEncoding` and still carrying the gzip magic.
 * @param opts - Optional encoding metadata, see {@link ParseSseOptions}.
 * @yields Each parsed JSON object decoded from a complete `data:` line.
 * @throws Error when `content-encoding` is an unsupported encoding, or when a
 *   buffered line exceeds the 5 MB limit.
 */
export async function* parseSse<T>(
  body: ReadableStream<Uint8Array>,
  opts?: ParseSseOptions,
): AsyncIterable<T> {
  assertDecodableEncoding(opts?.contentEncoding)

  const source = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const MAX_BUFFER_LENGTH = 5 * 1024 * 1024 // 5MB limit to prevent OOM

  /** Resolve the reader that yields plaintext chunks. */
  async function openPlaintextReader(): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const encoding = (opts?.contentEncoding ?? "").trim().toLowerCase()
    if (PLAINTEXT_ENCODINGS.has(encoding)) return source
    // Formally only "gzip" reaches here (assertDecodableEncoding rejected the
    // rest). A transport may already have inflated the body and kept the
    // header (Bun fetch does), so sniff the magic bytes before inflating.
    while (true) {
      const { done, value } = await source.read()
      if (done) {
        source.releaseLock()
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }).getReader()
      }
      if (value === undefined || value.length === 0) continue
      if (looksGzipped(value)) {
        return inflateGzip(replayStream(value, source)).getReader()
      }
      // Already plaintext: replay this chunk so it is parsed.
      return replayStream(value, source).getReader()
    }
  }

  const reader = await openPlaintextReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      if (buffer.length > MAX_BUFFER_LENGTH) {
        throw new Error(`stream_error: SSE line exceeded maximum length of ${MAX_BUFFER_LENGTH} bytes`)
      }

      let newlineIndex
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)

        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (data === "[DONE]") return
        try {
          yield JSON.parse(data) as T
        } catch {
          // skip malformed events : shouldn't happen but defensive
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
