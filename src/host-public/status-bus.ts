/**
 * Public re-export shim for `@minimal-agent/core/host/status-bus`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `GLOBAL_STATUS_BUS` / `StatusBus` are host-side status rows. Engine code
 * never writes them (S23). The engine reports status only through the
 * injected `statusPort` (`src/bus/status-port.ts`). A host maps each status
 * phase to its own rows: the CLI does this in `startup/host-ports.ts` on its
 * status bus. See `../bus/status.ts` for the bus contract.
 *
 * @module host-public/status-bus
 */

export * from "../bus/status.ts"
