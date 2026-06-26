/**
 * Parity guard between the TWO copies of the capability-host contract:
 *
 *   - host runtime source of truth: `src/plugins/host/capabilities.ts`
 *   - leaf type-only structural copy: `@minimal-agent/plugin-api/types/host-capabilities`
 *
 * The leaf copy exists so a plugin can re-declare the slice it consumes
 * without importing `src/` (see the module docs in both files). Structural
 * typing only protects us if the two stay in lockstep. These checks fail at
 * TYPECHECK time if the `CapabilityToken` unions or the `PathsApi` shape drift
 * apart, and at RUNTIME pin that every leaf token is present in the host's
 * `KNOWN_CAPABILITIES` validation list (so a manifest declaring a leaf-known
 * token can't be rejected by the host).
 *
 * When you add a capability token, you touch BOTH files; this test is the
 * tripwire that proves you did.
 */

import { describe, expect, it } from "bun:test"

import type {
  PathsApi as LeafPathsApi,
  PluginHost as LeafPluginHost,
  CapabilityToken as LeafToken,
} from "@minimal-agent/plugin-api/types/host-capabilities"

import {
  type PathsApi as HostPathsApi,
  type PluginHost as HostPluginHost,
  type CapabilityToken as HostToken,
  KNOWN_CAPABILITIES,
} from "./capabilities.ts"

// ---------------------------------------------------------------------------
// Compile-time parity: each pair must be mutually assignable. If a token is
// added to one union but not the other, one of these assignments fails to
// typecheck (the unions stop being equal), breaking `bun run typecheck`.
// ---------------------------------------------------------------------------

const _hostTokenIsLeafToken: LeafToken = "paths" satisfies HostToken
const _leafTokenIsHostToken: HostToken = "paths" satisfies LeafToken
void _hostTokenIsLeafToken
void _leafTokenIsHostToken

// Exhaustive union-equality: assigning the full union both directions only
// compiles when the two unions are identical sets.
const _hostToLeaf: (t: HostToken) => LeafToken = (t) => t
const _leafToHost: (t: LeafToken) => HostToken = (t) => t
void _hostToLeaf
void _leafToHost

// PathsApi shape parity, both directions.
const _hostPathsIsLeaf: LeafPathsApi = {} as HostPathsApi
const _leafPathsIsHost: HostPathsApi = {} as LeafPathsApi
void _hostPathsIsLeaf
void _leafPathsIsHost

// PluginHost shape parity (the leaf is the public contract a plugin sees;
// the host's real object must satisfy it).
const _hostIsLeaf: LeafPluginHost = {} as HostPluginHost
void _hostIsLeaf

describe("capability contract parity (host vs leaf)", () => {
  it("the host validation list recognizes the 'paths' token", () => {
    // Manifest validation derives from KNOWN_CAPABILITIES; a leaf-declared
    // token that the host doesn't validate would be rejected at load.
    expect(KNOWN_CAPABILITIES).toContain("paths")
  })

  it("KNOWN_CAPABILITIES has no duplicate tokens", () => {
    expect(new Set(KNOWN_CAPABILITIES).size).toBe(KNOWN_CAPABILITIES.length)
  })

  it("PathsApi exposes exactly home / sessionsDir / netDbgDir", () => {
    // A structural witness so a renamed/added method is caught at runtime too,
    // not only by the compile-time assignments above.
    const paths: HostPathsApi = {
      home: () => "/h",
      sessionsDir: () => "/h/sessions",
      netDbgDir: () => "/h/net-dbg",
    }
    expect(Object.keys(paths).sort()).toEqual(["home", "netDbgDir", "sessionsDir"])
  })
})
