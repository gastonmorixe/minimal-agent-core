/**
 * Capability-host factory — builds the frozen {@link PluginHost} a
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
 * @module plugins/host/factory
 */

import {
  resolveAgentHome,
  resolveNetDbgDir,
  resolveSessionsDir,
} from "@minimal-agent/plugin-api/utils/agent-paths"

import { getAuth } from "../../auth/auth.ts"
import type { PluginLogger } from "../../bus/diagnostic-bus.ts"
import {
  findModel,
  findModelByTags,
  getDefaultModelId,
  listRegisteredModels,
  registerModel,
  resolveModel,
  setDefaultModelId,
} from "../../llm/model-registry.ts"
import { resolveProviderSessionInfo } from "../../llm/provider-session.ts"
import { canonicalSendFn } from "../../llm/transport/canonical-send.ts"
import { getSessionTokens } from "../../session-tokens.ts"

import type { CapabilityToken, PluginHost } from "./capabilities.ts"
import { createBlobsReadApi } from "./providers/blobs-read.ts"
import { createSessionsReadApi } from "./providers/sessions-read.ts"
import { createTransportRegistryApi } from "./transport-registry.ts"

/** Inputs for {@link buildPluginHost}. All injectable for tests. */
export interface BuildHostOptions {
  /** Capability namespaces the plugin's manifest declared. */
  capabilities: readonly string[]
  /** Plugin-scoped logger (granted under the `logger` token). */
  logger?: PluginLogger
  /** Sessions-directory override (tests). */
  sessionsDir?: string
  /** Clock override (tests). */
  now?: () => number
  /**
   * Environment the `paths` capability resolves against. Defaults to
   * `process.env`, which carries the boot-published `MINIMAL_AGENT_HOME`.
   * Injectable so a test can drive path resolution without mutating the real
   * environment.
   */
  env?: NodeJS.ProcessEnv
}

/**
 * Build a frozen capability host for one plugin. Unknown capability
 * strings are ignored here (manifest validation rejects them earlier;
 * tolerating them keeps this factory total for ad-hoc callers).
 */
export function buildPluginHost(opts: BuildHostOptions): PluginHost {
  const granted = new Set(opts.capabilities)
  const has = (t: CapabilityToken) => granted.has(t)

  const host: PluginHost = Object.freeze({
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
    ...(has("session-info:read")
      ? {
          sessionInfo: Object.freeze({
            providerInfo: (modelId: string, o?: { signal?: AbortSignal; providerId?: string }) =>
              resolveProviderSessionInfo(modelId, {
                ...(o?.signal ? { signal: o.signal } : {}),
                ...(o?.providerId ? { providerId: o.providerId } : {}),
              }),
            // Project the core SessionTokens onto the neutral view (identical
            // shape minus the doc-only intent; explicit field copy keeps the
            // capability's surface pinned even if core adds internal fields).
            tokens: () => {
              const t = getSessionTokens()
              return {
                input: t.input,
                output: t.output,
                cacheRead: t.cacheRead,
                cacheCreate: t.cacheCreate,
                total: t.total,
                turns: t.turns,
                contextSize: t.contextSize,
              }
            },
          }),
        }
      : {}),
    ...(has("llm:complete")
      ? {
          llm: Object.freeze({
            // One-shot, non-streaming completion. Resolve credentials, build a
            // non-streaming SendOptions, run the transport, and drain the
            // generator to a single string. The plugin never touches auth,
            // canonicalSendFn, or the SendOptions shape.
            complete: async (req: {
              model?: string
              system: string
              userText: string
              maxTokens?: number
              timeoutMs?: number
            }): Promise<string> => {
              const auth = await getAuth()
              const gen = canonicalSendFn({
                auth,
                ...(req.model ? { model: req.model } : {}),
                system: [{ type: "text", text: req.system }],
                messages: [{ role: "user", content: [{ type: "text", text: req.userText }] }],
                maxTokens: req.maxTokens ?? 8192,
                stream: false,
                requestType: "title",
              })
              let text = ""
              const run = (async () => {
                while (true) {
                  const { value, done } = await gen.next()
                  if (done) return text
                  text += value
                }
              })()
              if (req.timeoutMs === undefined) return run
              return await Promise.race([
                run,
                new Promise<string>((_, reject) =>
                  setTimeout(
                    () => reject(new Error(`llm.complete timed out after ${req.timeoutMs}ms`)),
                    req.timeoutMs,
                  ),
                ),
              ])
            },
          }),
        }
      : {}),
    ...(has("paths")
      ? {
          paths: Object.freeze({
            home: () => resolveAgentHome(opts.env),
            sessionsDir: () => resolveSessionsDir(opts.env),
            netDbgDir: () => resolveNetDbgDir(opts.env),
          }),
        }
      : {}),
    ...(has("transport:registry")
      ? { transportRegistry: Object.freeze(createTransportRegistryApi()) }
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
