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
import { findModel } from "../../llm/model-registry.ts"
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
  readonly opts: Pick<CliOptions, "model" | "provider" | "cliCredentialName">
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
  const plugin = findProviderPlugin(selectedProviderId)
  if (!plugin) {
    throw new Error(`unknown provider "${selectedProviderId}"`)
  }
  if (!findModel(selectedModelBase)) {
    plugin.registerAdHocModel?.(selectedModelBase)
  }
  if (!findModel(selectedModelBase)) {
    throw new Error(`unknown model "${selectedModelBase}" for provider "${selectedProviderId}"`)
  }

  const credentialName = input.opts.cliCredentialName ?? input.userConfig.credentialName
  const auth = await resolveStartupAuth(selectedProviderId, selectedModelBase, credentialName)
  printStartupRow("auth", startupAuthLabel(auth, selectedProviderId))

  return {
    selectedModel,
    selectedModelBase,
    selectedProviderId,
    credentialName,
    auth,
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
