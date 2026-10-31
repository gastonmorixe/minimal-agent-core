/**
 * Public re-export shim for `@minimal-agent/core/host/diagnostics`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `src/bus/diagnostic-bus.ts` splits in two per the S34 exports-gap
 * decision: the stateful singleton bus (`getDiagnosticBus` /
 * `createDiagnosticBus`) plus the pure event vocabulary (`LogEvent`,
 * `Severity`, `Facility`) is genuinely process-level and belongs here, for
 * the boot-time emitters that run before any `Session` exists
 * (provider-boot, binary provisioning, the diagnostic-sinks wiring). The
 * OTHER half — `diag`, `createPluginLogger`, and the TUI-rendering
 * consumers that today reach the raw bus directly — is intentionally left
 * unexported: once a `Session` exists it already carries diagnostics on its
 * own event log (`ch: "diag"`), and a TUI host should subscribe to that
 * instead of this process-global bus.
 *
 * See `../bus/diagnostic-bus.ts` for the full contract.
 *
 * @module host-public/diagnostics
 */

export type { DiagnosticBus, LogEvent } from "../bus/diagnostic-bus.ts"
export {
  createDiagnosticBus,
  Facility,
  getDiagnosticBus,
  Severity,
} from "../bus/diagnostic-bus.ts"
