/**
 * Public re-export shim for `@minimal-agent/core/host/provider-discovery-boot`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `bootProviderDiscovery` registers every provider plugin into the model
 * registry; it MUST run before any model resolution. Critical: without
 * this export, no host-constructed process can resolve any model at all.
 * See `../runtime/provider-discovery-boot.ts` for the full
 * contract.
 *
 * @module host-public/provider-discovery-boot
 */

export * from "../runtime/provider-discovery-boot.ts"
