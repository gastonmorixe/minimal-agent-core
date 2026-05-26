import { type NetworkRequest, NetworkResponse, type NetworkTransport } from "./types.ts"

/** Fetch-based HTTP/1.1 transport used for opt-in fallback paths. */
export class FetchTransport implements NetworkTransport {
  readonly id = "fetch"

  async request(req: NetworkRequest): Promise<NetworkResponse> {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: toFetchBody(req.body),
      signal: req.signal,
    })
    const origin = new URL(req.url).origin
    return new NetworkResponse({
      status: response.status,
      headers: response.headers,
      body: response.body,
      transport: {
        id: this.id,
        protocol: "http/1.1",
        origin,
        reused: undefined,
        fallbackUsed: false,
      },
    })
  }

  preconnect(origin: string): void {
    const f = fetch as typeof fetch & {
      preconnect?: (url: string | URL, options?: Record<string, boolean>) => void
    }
    f.preconnect?.(origin, { dns: true, tcp: true, http: true, https: true })
  }
}

function toFetchBody(body: NetworkRequest["body"]): BodyInit | undefined {
  if (body == null || typeof body === "string") return body
  const copy = new ArrayBuffer(body.byteLength)
  new Uint8Array(copy).set(body)
  return copy
}
