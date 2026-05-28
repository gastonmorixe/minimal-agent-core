/**
 * Generic SSE parser shared across providers.
 *
 * The Anthropic streaming API uses standard SSE:
 *
 *   event: <type>\n
 *   data: <json>\n\n
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
 * @module llm/streaming/sse-parser
 */

/**
 * Yield each `data:` JSON object from a ReadableStream<Uint8Array>.
 * Stops when the upstream closes or sends `data: [DONE]`.
 *
 * @template T - Shape of the parsed JSON objects. Adapter passes its
 *   own discriminated-union type.
 * @yields Each parsed JSON object decoded from a complete `data:` line.
 */
export async function* parseSse<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
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
