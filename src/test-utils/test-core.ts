/**
 * Build an `AgentCore` for tests through the production factory.
 *
 * Tests drive the same wiring the product uses (`buildAgentCore`: tool
 * registry, tool executor, prompt contributor, session persistence, mode
 * provider, media resolver, lifecycle). This helper only fills the host
 * dependencies a test does not exercise with their "absent" values, so a
 * test names just what it cares about.
 *
 * It is the one test file that imports the host adapter seam, so engine
 * tests do not each add a core-to-host import.
 *
 * @module test-utils/test-core
 */

import { type BuildAgentCoreDeps, buildAgentCore } from "../adapters/build-agent-core.ts"
import type { AgentCore } from "../sdk/agent-core.ts"

/** Model id used when a test does not pick one. */
export const TEST_CORE_MODEL = "test-model"

type DefaultedDeps =
  | "model"
  | "loader"
  | "modeManager"
  | "store"
  | "blobStore"
  | "saveEcho"
  | "turnAttachments"

/** {@link BuildAgentCoreDeps} with the host-only dependencies made optional. */
export type TestCoreDeps = Omit<BuildAgentCoreDeps, DefaultedDeps> &
  Partial<Pick<BuildAgentCoreDeps, DefaultedDeps>>

/**
 * Build an `AgentCore` with test defaults: model {@link TEST_CORE_MODEL}, no
 * plugin loader, no mode manager, no session store, no blob store, no save
 * echoes, and no turn attachments. Any field in `deps` overrides its default.
 */
export function buildTestCore(deps: TestCoreDeps): Promise<AgentCore> {
  return buildAgentCore({
    model: TEST_CORE_MODEL,
    loader: null,
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
    ...deps,
  })
}
