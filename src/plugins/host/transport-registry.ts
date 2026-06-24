/**
 * Transport registry — the host-brokered seam that lets a transport-provider
 * plugin (the future `minimal-agent-cloud`) hand a remote transport to a
 * consumer plugin (Intercom) WITHOUT either plugin importing the other.
 *
 * ## Why this exists (dependency inversion, same shape as the provider registrar)
 *
 * minimal-agent's plugins may not import each other (architecture rule I3) nor
 * `src/` (also I3). So when the cloud plugin needs to inject a network transport
 * into Intercom, they meet at a NEUTRAL host-owned store: the cloud plugin calls
 * `register(transport)`, Intercom calls `list()`. This mirrors how provider
 * plugins contribute models — `ProviderPlugin.register(ctx)` writes into a host
 * registrar that consumers read — applied to transports instead of models.
 *
 * ## Core treats a transport as OPAQUE
 *
 * The host never knows what a transport DOES. It only requires an `id` (so
 * registrations are addressable + last-write-wins per id). The full transport
 * shape (presence publish/read, message deliver/read) is Intercom's domain;
 * Intercom re-declares it as a LOCAL structural interface and narrows the
 * objects it reads back. Core is a dumb, type-minimal broker. This keeps the
 * capability generic: any future consumer/provider pair can use it, not just
 * Intercom + cloud.
 *
 * ## Why a process-wide singleton store
 *
 * `buildPluginHost` mints a SEPARATE frozen {@link PluginHost} per plugin, but
 * the register side (cloud) and the list side (Intercom) must observe the SAME
 * set of transports. So the backing store is module-level (one per agent
 * process); every granted host exposes a fresh frozen API view over that single
 * shared store. The API objects differ per plugin; the data they read/write is
 * shared.
 *
 * @module plugins/host/transport-registry
 */

/**
 * The minimal contract core requires of a registered transport: a stable,
 * non-empty `id`. Everything else is opaque to the host (the consumer plugin
 * re-declares the full shape and narrows). Last-write-wins keys on `id`, so a
 * provider re-registering after a reconnect is idempotent.
 */
export interface RegisteredTransport {
  readonly id: string
}

/**
 * `transport:registry` — the capability API a plugin receives as
 * `ctx.host.transportRegistry`. A provider plugin calls {@link register} /
 * {@link unregister}; a consumer plugin calls {@link list}. Both sides request
 * the same capability today (one neutral object); a future least-privilege
 * refinement could split read vs register into two tokens (mirroring
 * `models:read` / `models:register`) if a provider must be barred from listing.
 */
export interface TransportRegistryApi {
  /**
   * Register (or replace) a transport. Idempotent, last-write-wins per `id`
   * (a reconnecting provider just re-registers). Throws only when the argument
   * lacks a usable string `id`, which is a programming error, not a runtime
   * condition.
   */
  register(transport: RegisteredTransport): void
  /** Remove a transport by id (a provider's clean teardown on disconnect). No-op when absent. */
  unregister(id: string): void
  /** Every currently-registered transport, in registration order. */
  list(): RegisteredTransport[]
}

/**
 * The process-wide store. Module-level so every per-plugin host view shares it.
 * Insertion order is preserved by `Map`, so `list()` is stable.
 */
const STORE = new Map<string, RegisteredTransport>()

/**
 * Build a frozen {@link TransportRegistryApi} view over the shared store. Called
 * by {@link buildPluginHost} when a plugin is granted `transport:registry`.
 */
export function createTransportRegistryApi(): TransportRegistryApi {
  return {
    register(transport: RegisteredTransport): void {
      if (
        transport === null ||
        typeof transport !== "object" ||
        typeof (transport as { id?: unknown }).id !== "string" ||
        (transport as { id: string }).id.length === 0
      ) {
        throw new Error(
          "transport:registry register() requires a transport object with a non-empty string `id`",
        )
      }
      STORE.set(transport.id, transport)
    },
    unregister(id: string): void {
      STORE.delete(id)
    },
    list(): RegisteredTransport[] {
      return [...STORE.values()]
    },
  }
}

/**
 * Test-only: clear the process-wide store between test cases so registrations
 * from one test never leak into another. NOT part of the plugin-facing API.
 */
export function __resetTransportRegistryForTests(): void {
  STORE.clear()
}
