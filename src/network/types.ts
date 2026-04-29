export type NetworkMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export type NetworkProtocol = "http/1.1" | "h2" | "h3" | "ws" | "webrtc"

export interface NetworkTransportInfo {
  id: string
  protocol?: NetworkProtocol
  origin?: string
  reused?: boolean
  fallbackUsed?: boolean
}

export interface NetworkCaptureOptions {
  requestBody?: string | null
  responseBody?: boolean
}

export interface NetworkRequest {
  id: string
  label: string
  method: NetworkMethod
  url: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  signal?: AbortSignal
  timeoutMs?: number
  allowFetchFallback?: boolean
  capture?: NetworkCaptureOptions
  transportHint?: string
}

/** Response wrapper shared by all network transports. */
export class NetworkResponse {
  readonly status: number
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array>
  readonly transport: NetworkTransportInfo

  constructor(opts: {
    status: number
    headers: Headers | Record<string, string>
    body?: ReadableStream<Uint8Array> | null
    transport: NetworkTransportInfo
  }) {
    this.status = opts.status
    this.headers = opts.headers instanceof Headers ? opts.headers : new Headers(opts.headers)
    this.body = opts.body ?? emptyBody()
    this.transport = opts.transport
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300
  }

  async text(): Promise<string> {
    return new Response(this.body).text()
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text())
  }
}

export interface NetworkTransport {
  readonly id: string
  request(req: NetworkRequest): Promise<NetworkResponse>
  preconnect?(origin: string): Promise<void> | void
  close?(): Promise<void> | void
}

export interface NetworkObserver {
  onRequest?(req: NetworkRequest): void
  onResponse?(req: NetworkRequest, res: NetworkResponse): void
  onChunk?(req: NetworkRequest, chunk: Uint8Array, res: NetworkResponse): void
  onEnd?(req: NetworkRequest, res: NetworkResponse): void
  onError?(req: NetworkRequest, error: unknown): void
}

/**
 * Build an empty web stream for responses without a body.
 *
 * @returns Closed byte stream.
 */
export function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
}
