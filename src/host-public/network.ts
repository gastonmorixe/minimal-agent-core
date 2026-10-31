/**
 * Public re-export shim for `@minimal-agent/core/host/network`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../network/index.ts`: the real network
 * client (`defaultNetworkClient`, `applyPreferredDnsResultOrder`,
 * `NetworkClient`) any host wanting real HTTP/2/3 transport behavior must
 * construct.
 *
 * @module host-public/network
 */

export * from "../network/index.ts"
