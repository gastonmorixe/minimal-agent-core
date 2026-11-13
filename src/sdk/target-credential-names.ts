/**
 * Host-injected credential-name lookup for `resolveTargetSwitch`.
 *
 * Core (`src/sdk/`) never reads the auth store itself: it cannot import
 * `src/auth/` or `src/adapters/` (the SDK port-boundary ratchet), and the
 * store read is sync process I/O the engine must not own. The host
 * (CLI `run-host-mode`, web `runtime-backend`, tests) injects this port at
 * `AgentCore` construction; `switchTarget` calls it to validate an explicit
 * `credentialName` against the named credentials stored for a provider.
 *
 * Returns the known credential names for `providerId` (empty when the
 * provider has no stored credentials, or names are unavailable).
 *
 * @module sdk/target-credential-names
 */

export type SwitchTargetCredentialNames = (providerId: string) => readonly string[]
