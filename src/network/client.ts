import { randomUUID } from "node:crypto"
import { FetchTransport } from "./fetch-transport.ts"
import { Http2Transport } from "./http2-transport.ts"
import { createNetDebugObserver } from "./net-dbg-observer.ts"
import { TestTransport } from "./test-transport.ts"
import {
  NetworkResponse,
  type NetworkObserver,
  type NetworkRequest,
  type NetworkTransport,
} from "./types.ts"

export interface NetworkClientOptions {
  primary: NetworkTransport
  fallback?: NetworkTransport
  observers?: NetworkObserver[]
  allowFetchFallback?: boolean
}

export type NetworkRequestInput = Omit<NetworkRequest, "id" | "transportHint"> & {
  id?: string
}

/** Transport-agnostic network client with observers and fallback control. */
export class NetworkClient {
  private readonly primary: NetworkTransport
  private readonly fallback?: NetworkTransport
  private readonly observers: NetworkObserver[]
  private readonly allowFetchFallback: boolean

  constructor(opts: NetworkClientOptions) {
    this.primary = opts.primary
    this.fallback = opts.fallback
    this.observers = opts.observers ?? []
    this.allowFetchFallback = opts.allowFetchFallback ?? false
  }

  async request(input: NetworkRequestInput): Promise<NetworkResponse> {
    const req: NetworkRequest = {
      ...input,
      id: input.id ?? randomUUID(),
      transportHint: this.primary.id,
    }
    this.notifyRequest(req)

    try {
      const response = await this.primary.request(req)
      const tapped = this.tapResponse(req, response)
      this.notifyResponse(req, tapped)
      return tapped
    } catch (err) {
      if (this.shouldFallback(req)) {
        try {
          const fallback = await this.fallback!.request({
            ...req,
            transportHint: this.fallback!.id,
          })
          fallback.transport.fallbackUsed = true
          const tapped = this.tapResponse(req, fallback)
          this.notifyResponse(req, tapped)
          return tapped
        } catch (fallbackErr) {
          this.notifyError(req, fallbackErr)
          throw fallbackErr
        }
      }
      this.notifyError(req, err)
      throw err
    }
  }

  preconnect(origin: string): Promise<void> | void {
    return this.primary.preconnect?.(origin)
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close?.(), this.fallback?.close?.()])
  }

  private shouldFallback(req: NetworkRequest): boolean {
    return Boolean(this.fallback && (this.allowFetchFallback || req.allowFetchFallback))
  }

  private tapResponse(req: NetworkRequest, response: NetworkResponse): NetworkResponse {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        reader ??= response.body.getReader()
        try {
          const { done, value } = await reader.read()
          if (done) {
            this.notifyEnd(req, response)
            controller.close()
            reader.releaseLock()
            reader = undefined
            return
          }
          if (value) {
            this.notifyChunk(req, value, response)
            controller.enqueue(value)
          }
        } catch (err) {
          this.notifyError(req, err)
          controller.error(err)
        }
      },
      cancel: async (reason) => {
        await reader?.cancel(reason)
        reader?.releaseLock()
        reader = undefined
      },
    })

    return new NetworkResponse({
      status: response.status,
      headers: response.headers,
      body,
      transport: response.transport,
    })
  }

  private notifyRequest(req: NetworkRequest): void {
    for (const observer of this.observers) observer.onRequest?.(req)
  }

  private notifyResponse(req: NetworkRequest, res: NetworkResponse): void {
    for (const observer of this.observers) observer.onResponse?.(req, res)
  }

  private notifyChunk(req: NetworkRequest, chunk: Uint8Array, res: NetworkResponse): void {
    for (const observer of this.observers) observer.onChunk?.(req, chunk, res)
  }

  private notifyEnd(req: NetworkRequest, res: NetworkResponse): void {
    for (const observer of this.observers) observer.onEnd?.(req, res)
  }

  private notifyError(req: NetworkRequest, err: unknown): void {
    for (const observer of this.observers) observer.onError?.(req, err)
  }
}

/**
 * Build the process default client from environment transport settings.
 *
 * @returns Network client with HTTP/2 primary transport unless fetch is requested.
 */
export function createDefaultNetworkClient(): NetworkClient {
  const requested = process.env.MINIMAL_AGENT_TRANSPORT?.trim().toLowerCase()
  if (requested === "test") {
    const testEnv = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
    if (!testEnv) throw new Error("MINIMAL_AGENT_TRANSPORT=test is only allowed in test")
    return new NetworkClient({ primary: new TestTransport() })
  }
  const primary = requested === "fetch" ? new FetchTransport() : new Http2Transport()
  const fallback = requested === "fetch" ? undefined : new FetchTransport()
  return new NetworkClient({
    primary,
    fallback,
    allowFetchFallback: process.env.MINIMAL_AGENT_ALLOW_FETCH_FALLBACK === "1",
    observers: [createNetDebugObserver()],
  })
}

export const defaultNetworkClient = createDefaultNetworkClient()
