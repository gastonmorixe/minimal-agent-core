/**
 * Binary-provisioning subsystem barrel.
 *
 * The agent owns `~/.minimal-agent/bin/` and a sidecar manifest. Plugins
 * DECLARE required binaries (hardcoded url / sha256 / version) and the host
 * installs them. See {@link BinaryStore} + {@link BinarySpec}.
 *
 * @module binaries
 */

export {
  inventoryAdapter,
  type PluginSetupResult,
  type ProvisionHalt,
  type ProvisionSummary,
  provisionSetups,
  toBinarySpec,
} from "./provision.ts"
export {
  BinaryStore,
  classify,
  defaultBinDir,
  findMember,
  isArchive,
  sha256File,
  sourceIsArchive,
  sourceLabel,
} from "./store.ts"
export type {
  BinaryInventory,
  BinaryRequest,
  BinarySource,
  BinarySpec,
  InstalledBinary,
  InstallOutcome,
  InstallProgress,
  RequirementStatus,
} from "./types.ts"
export { compareVersions, isNewer, parseVersion } from "./version.ts"
