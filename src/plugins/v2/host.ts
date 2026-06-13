/**
 * Capability-host factory — builds the frozen {@link PluginHostV2} a
 * plugin receives as `ctx.host`, populated ONLY with the namespaces its
 * manifest declared (`capabilities: ["sessions:read", ...]`).
 *
 * Facade over the provider adapters in `./providers/*`. The grant model is
 * deny-by-default: an undeclared namespace is `undefined` on the host
 * object, so a plugin that forgot to declare `sessions:read` cannot reach
 * the session store even though the code for it is loaded in-process.
 *
 * The returned object is deep-frozen so a misbehaving plugin can't mutate
 * the shared surface and bleed state into a sibling handler (same rule as
 * `createAgentContext` (in `../agent-context.ts`)).
 *
 * @module plugins/v2/host
 */

import type { PluginLogger } from "../../diagnostic-bus.ts"
import {
  findModel,
  findModelByTags,
  getDefaultModelId,
  listRegisteredModels,
  registerModel,
  resolveModel,
  setDefaultModelId,
} from "../../llm/model-registry.ts"

import type { CapabilityToken, PluginHostV2 } from "./host-capabilities.ts"
import { createBlobsReadApi } from "./providers/blobs-read.ts"
import { createSessionsReadApi } from "./providers/sessions-read.ts"

/** Inputs for {@link buildPluginHostV2}. All injectable for tests. */
export interface BuildHostOptions {
  /** Capability namespaces the plugin's manifest declared. */
  capabilities: readonly string[]
  /** Plugin-scoped logger (granted under the `logger` token). */
  logger?: PluginLogger
  /** Sessions-directory override (tests). */
  sessionsDir?: string
  /** Clock override (tests). */
  now?: () => number
}

/**
 * Build a frozen capability host for one plugin. Unknown capability
 * strings are ignored here (manifest validation rejects them earlier;
 * tolerating them keeps this factory total for ad-hoc callers).
 */
export function buildPluginHostV2(opts: BuildHostOptions): PluginHostV2 {
  const granted = new Set(opts.capabilities)
  const has = (t: CapabilityToken) => granted.has(t)

  const host: PluginHostV2 = Object.freeze({
    capabilities: Object.freeze(
      [...granted].filter((c): c is CapabilityToken => typeof c === "string"),
    ),
    ...(has("sessions:read")
      ? { sessions: Object.freeze(createSessionsReadApi({ dir: opts.sessionsDir })) }
      : {}),
    ...(has("blobs:read")
      ? { blobs: Object.freeze(createBlobsReadApi({ dir: opts.sessionsDir })) }
      : {}),
    ...(has("models:read")
      ? {
          models: Object.freeze({
            find: findModel,
            resolve: resolveModel,
            list: listRegisteredModels,
            findByTags: findModelByTags,
            defaultModelId: getDefaultModelId,
          }),
        }
      : {}),
    ...(has("models:register")
      ? {
          modelsRegistry: Object.freeze({
            register: registerModel,
            setDefault: setDefaultModelId,
          }),
        }
      : {}),
    ...(has("clock")
      ? {
          clock: Object.freeze({
            now: opts.now ?? (() => Date.now()),
            iso: () => new Date((opts.now ?? (() => Date.now()))()).toISOString(),
          }),
        }
      : {}),
    ...(has("logger") && opts.logger ? { logger: opts.logger } : {}),
  })
  return host
}
