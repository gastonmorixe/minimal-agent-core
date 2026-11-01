/**
 * Public barrel for the aggregate host boot (WEB-PLUGINS-001, decision 19).
 * Exported as `@minimal-agent/core/host-kit/host-boot`. See
 * `docs/host-boot.md` for the contract.
 *
 * @module host-public/host-boot
 */

export * from "../adapters/host-boot.ts"
export * from "../adapters/model-view.ts"
export type { HostBootDiagnostic } from "../adapters/plugin-deps.ts"
