/** Error thrown when a stream drain exceeds the configured max bytes bound. */
export class BoundedDrainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BoundedDrainError"
  }
}

/**
 * Consumes a Web ReadableStream into a string, enforcing a strict byte/character limit.
 * If the limit is exceeded, it throws a BoundedDrainError.
 */
export async function consumeStreamBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  decoder = new TextDecoder()
): Promise<string> {
  const reader = stream.getReader()
  let result = ""
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.length
      if (totalBytes > maxBytes) {
        throw new BoundedDrainError(`Stream exceeded maximum allowed size of ${maxBytes} bytes`)
      }

      result += decoder.decode(value, { stream: true })
    }
    result += decoder.decode() // flush
    return result
  } finally {
    reader.releaseLock()
  }
}
