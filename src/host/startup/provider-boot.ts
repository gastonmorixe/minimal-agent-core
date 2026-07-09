/**
 * Startup provider/model/auth bootstrapping.
 *
 * This keeps the selected provider resolution and provider-specific warm-up
 * hooks out of `src/index.ts` while preserving the entrypoint ordering: provider
 * discovery must already have run before this module is called.
 *
 * @module host/startup/provider-boot
 */

import type { AuthResult } from "../../auth/auth.ts"
import {
  discoverCredentialedProviders,
  storedProvidersHint,
  suggestModelForProvider,
} from "../../auth/auth-strategies.ts"
import type { CliOptions } from "../../cli/parse-argv.ts"
import type { UserConfig } from "../../config/config.ts"
import { findModelForProvider } from "../../llm/model-registry.ts"
import { findProviderPlugin, listProviderPlugins } from "../../llm/provider-plugin.ts"
import { primeProviderSessionInfo } from "../../llm/provider-session.ts"
import { printStartupRow } from "../ui/startup/tree.ts"

import { resolveStartupAuth, startupAuthLabel } from "./provider-auth.ts"
import { resolveBootModel, resolveSingleStoredProviderBootModel } from "./resolve-boot-model.ts"

/** Resolved provider startup state needed by later boot phases. */
export interface StartupProviderState {
  readonly selectedModel: string
  readonly selectedModelBase: string
  readonly selectedProviderId: string
  readonly credentialName: string | undefined
  readonly auth: AuthResult
}

/** Inputs for {@link resolveStartupProviderState}. */
export interface ResolveStartupProviderStateInput {
  readonly opts: Pick<
    CliOptions,
    | "model"
    | "provider"
    | "endpoint"
    | "format"
    | "authType"
    | "apiKey"
    | "authHeader"
    | "providerModel"
    | "effortLevels"
    | "cliCredentialName"
  >
  readonly userConfig: Pick<UserConfig, "model" | "provider" | "credentialName">
  readonly env: Record<string, string | undefined>
}

/** Resolve model, provider, ad-hoc model registration, and startup auth. */
export async function resolveStartupProviderState(
  input: ResolveStartupProviderStateInput,
): Promise<StartupProviderState> {
  const bootModel = resolveBootModel({
    cliModel: input.opts.model,
    cliProvider: input.opts.provider,
    envModel: input.env.MINIMAL_AGENT_MODEL,
    envProvider: input.env.MINIMAL_AGENT_PROVIDER,
    configModel: input.userConfig.model,
    configProvider: input.userConfig.provider,
  })

  if (bootModel.kind === "invalid") {
    throw new Error(bootModel.reason)
  }

  const selected =
    bootModel.kind === "explicit"
      ? bootModel
      : resolveSingleStoredProviderBootModel(
          discoverCredentialedProviders(),
          suggestModelForProvider,
        )
  if (selected.kind === "invalid") {
    throw new Error(`${selected.reason}. ${storedProvidersHint()}`)
  }

  const selectedModel = selected.model
  const selectedModelBase = selectedModel.replace(/\[(1|2)m\]/gi, "")
  const selectedProviderId = selected.provider
  publishGenericEndpointEnv(input.opts)
  const plugin = findProviderPlugin(selectedProviderId)
  if (!plugin) {
    throw new Error(`unknown provider "${selectedProviderId}"`)
  }
  if (!findModelForProvider(selectedModelBase, selectedProviderId)) {
    plugin.registerAdHocModel?.(selectedModelBase)
  }
  if (!findModelForProvider(selectedModelBase, selectedProviderId)) {
    throw new Error(`unknown model "${selectedModelBase}" for provider "${selectedProviderId}"`)
  }

  const credentialName = input.opts.cliCredentialName ?? input.userConfig.credentialName
  const auth = await resolveStartupAuth(selectedProviderId, selectedModelBase, credentialName, {
    endpoint: input.opts.endpoint,
    format: input.opts.format,
    authType: input.opts.authType,
    apiKey: input.opts.apiKey,
    authHeader: input.opts.authHeader,
  })
  printStartupRow("auth", startupAuthLabel(auth, selectedProviderId))

  return {
    selectedModel,
    selectedModelBase,
    selectedProviderId,
    credentialName,
    auth,
  }
}

function publishGenericEndpointEnv(opts: ResolveStartupProviderStateInput["opts"]): void {
  if (opts.endpoint) process.env.MINIMAL_AGENT_ENDPOINT = opts.endpoint
  if (opts.format) process.env.MINIMAL_AGENT_FORMAT = opts.format
  if (opts.authType) process.env.MINIMAL_AGENT_AUTH_TYPE = opts.authType
  if (opts.apiKey) process.env.MINIMAL_AGENT_API_KEY = opts.apiKey
  if (opts.authHeader) process.env.MINIMAL_AGENT_AUTH_HEADER = opts.authHeader
  if (opts.providerModel) process.env.MINIMAL_AGENT_PROVIDER_MODEL = opts.providerModel
  if (opts.effortLevels && opts.effortLevels.length > 0) {
    process.env.MINIMAL_AGENT_EFFORT_LEVELS = opts.effortLevels.join(",")
  }
}

/** Start provider-specific best-effort warm-ups for the selected provider. */
export function startProviderWarmups(state: StartupProviderState): void {
  void (async () => {
    const { legacyAuthToProviderAuth } = await import("../../llm/adapter-legacy.ts")
    const probeCtx = {
      auth: legacyAuthToProviderAuth(state.auth),
      modelId: state.selectedModelBase,
    }
    for (const plugin of listProviderPlugins()) {
      if (plugin.id !== state.selectedProviderId) continue
      plugin.onStartupProbe?.(probeCtx)
    }
  })().catch(() => {
    // Tolerated: startup probes can only improve registry metadata.
  })

  void primeProviderSessionInfo(state.selectedModelBase).catch(() => {
    // Tolerated: quota/status slots populate from real chat traffic later.
  })
}
