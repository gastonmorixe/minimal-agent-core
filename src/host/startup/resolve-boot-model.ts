/**
 * Resolve the boot selection for an interactive REPL.
 *
 * When a model is explicitly configured, a provider must be configured too.
 * When neither is configured, the caller must decide whether a provider can be
 * inferred safely from stored credentials. This module does not pick a global
 * registry default.
 *
 * @module startup/resolve-boot-model
 */

export interface ResolveBootModelInput {
  cliModel?: string
  cliProvider?: string
  envModel?: string
  envProvider?: string
  configModel?: string
  configProvider?: string
}

export type BootSelectionSource = "cli" | "env" | "config" | "stored-provider"

export interface ResolvedBootModelSelection {
  kind: "explicit"
  model: string
  modelSource: BootSelectionSource
  provider: string
  providerSource: BootSelectionSource
}

export interface InvalidBootModelSelection {
  kind: "invalid"
  reason: string
}

export type ResolveBootModelResult =
  | ResolvedBootModelSelection
  | { kind: "unconfigured" }
  | InvalidBootModelSelection

function firstString(
  cli?: string,
  env?: string,
  config?: string,
): { value: string; source: Exclude<BootSelectionSource, "stored-provider"> } | undefined {
  const cliValue = cli?.trim()
  if (cliValue) return { value: cliValue, source: "cli" }
  const envValue = env?.trim()
  if (envValue) return { value: envValue, source: "env" }
  const configValue = config?.trim()
  if (configValue) return { value: configValue, source: "config" }
  return undefined
}

/** Resolve the boot selection, or signal that the explicit pair is incomplete. */
export function resolveBootModel(input: ResolveBootModelInput): ResolveBootModelResult {
  const model = firstString(input.cliModel, input.envModel, input.configModel)
  const provider = firstString(input.cliProvider, input.envProvider, input.configProvider)

  if (!model && !provider) return { kind: "unconfigured" }
  if (model && provider) {
    return {
      kind: "explicit",
      model: model.value,
      modelSource: model.source,
      provider: provider.value,
      providerSource: provider.source,
    }
  }

  return {
    kind: "invalid",
    reason: model
      ? `model "${model.value}" requires an explicit provider; pass --provider <id> too`
      : `provider "${provider?.value}" requires an explicit model; pass --model <id> too`,
  }
}

export interface StoredProviderBootCandidate {
  providerId: string
  credentialInfo?: {
    usable: boolean
  }
}

/** Resolve the only allowed implicit boot selection: one usable stored provider. */
export function resolveSingleStoredProviderBootModel(
  candidates: readonly StoredProviderBootCandidate[],
  suggestModel: (providerId: string) => string | undefined,
): ResolvedBootModelSelection | InvalidBootModelSelection {
  const usable = candidates.filter((p) => p.credentialInfo?.usable !== false)
  if (usable.length !== 1) {
    const reason =
      candidates.length === 0
        ? "no provider credentials found"
        : usable.length === 0
          ? "no usable provider credentials found"
          : "multiple provider credentials found"
    return {
      kind: "invalid",
      reason:
        `${reason}; set both model and provider in config, or pass ` +
        `--provider <id> --model <id>`,
    }
  }

  const provider = usable[0]!.providerId
  const model = suggestModel(provider)
  if (!model) {
    return {
      kind: "invalid",
      reason:
        `provider "${provider}" has credentials but no suggested model; ` +
        `pass --provider ${provider} --model <id>`,
    }
  }

  return {
    kind: "explicit",
    model,
    modelSource: "stored-provider",
    provider,
    providerSource: "stored-provider",
  }
}
