/**
 * Anytime target switching: the credential/provider/model/effort quadruple.
 *
 * Pure resolver + registry reads, split out of `agent-core-helpers.ts` so
 * `agent-core.ts` stays under the 810-line gate (the helpers file is the
 * loop-helper home; the target resolver is `switchTarget`-specific).
 *
 * @module sdk/target-switch
 */

import type { ModelAdoptedNotice } from "../agent/turn-notice.ts"
import type { AuthResult } from "../auth/auth.ts"
import { validateEffortForModel } from "../config/effort-resolution.ts"
import {
  listRegisteredModels,
  resolveModel,
  resolveModelForProvider,
} from "../llm/model-registry.ts"
import { normalizeModelForAPI } from "../llm/transport/types.ts"

import type { SwitchTargetCredentialNames } from "./target-credential-names.ts"

/**
 * What one {@link AgentCore.switchTarget} call resolves, as one atomic step:
 * the full credential/provider/model/effort quadruple. All four fields are
 * validated BEFORE any assignment, so a throw leaves the core unchanged.
 */
export interface TargetSelection {
  credentialName?: string
  providerId?: string
  model?: string
  effort?: string | undefined
  /**
   * When switching provider without naming `model`, resolve that provider's
   * default (its first registered model) instead of throwing. Never silent
   * across a caller that named a model: an explicit `model` always wins.
   */
  useProviderDefault?: boolean
  /**
   * Auth the host resolved for the new provider/credential. `switchTarget`
   * assigns it only after the selection validates, so a throw keeps the old
   * auth. Pass it on a provider change: a `type: "provider"` auth is sent
   * as is, so the old provider's credential would reach the new provider.
   * Omit to keep the current auth.
   */
  auth?: AuthResult
}

/** The session's live target: credential + provider + model + effort. */
export interface TargetState {
  credentialName?: string
  providerId?: string
  model: string
  effort: string | undefined
}

/** What one validated `switchTarget` step changes, for the notice event. */
export interface TargetSwitch {
  from: TargetState
  to: TargetState
  /** `true` when the switch reset the effort to the new model's default. */
  effortReset: boolean
  /** The effort level that was reset, or `undefined` when none was reset. */
  effortFrom: string | undefined
}

/**
 * Registry reads `resolveTargetSwitch` needs, passed by the caller so the
 * pure resolver never touches module state directly. Production (AgentCore)
 * wires the real registry + the host-injected credential port; tests wire
 * fixtures.
 */
export interface TargetSwitchRegistry {
  /** Host credential lookup. Absent: an explicit credential name is not validated. */
  credentialNamesFor?: SwitchTargetCredentialNames
  registeredModelsFor: (providerId: string) => readonly string[]
  defaultModelFor: (providerId: string) => string | undefined
  /**
   * A structured-output schema (session or run) is set. Then a change to a
   * model whose registry entry has `structuredOutputs: false` throws: the
   * request builders reject a schema for such a model, so the turn would
   * fail at the next request.
   */
  structuredOutputsRequired?: boolean
}

/** The `model_adopted` notice for a real switch (from/to over the quadruple). */
export function targetSwitchNotice(sw: TargetSwitch): ModelAdoptedNotice {
  return {
    kind: "model_adopted",
    severity: "info",
    from: sw.from.model,
    to: sw.to.model,
    effortReset: sw.effortReset,
    effortFrom: sw.effortFrom ?? null,
  }
}

/** Structural equality over the quadruple (undefined-normalized). */
export function targetsEqual(a: TargetState, b: TargetState): boolean {
  return (
    (a.credentialName ?? undefined) === (b.credentialName ?? undefined) &&
    (a.providerId ?? undefined) === (b.providerId ?? undefined) &&
    a.model === b.model &&
    a.effort === b.effort
  )
}

/** First registered model id for one provider (for `useProviderDefault`). */
export function defaultModelFor(providerId: string): string | undefined {
  if (!providerId) return undefined
  for (const m of listRegisteredModels()) {
    if (m.providerId === providerId) return m.id
  }
  return undefined
}

/** Model ids registered for one provider (for the switchTarget throw message). */
export function registeredModelsFor(providerId: string): readonly string[] {
  if (!providerId) return []
  const out: string[] = []
  for (const m of listRegisteredModels()) {
    if (m.providerId === providerId) out.push(m.id)
  }
  return out
}

/**
 * Validate a full target switch and resolve what the core becomes, as ONE
 * atomic step. The caller assigns all four fields only when this returns,
 * so a throw leaves model, provider, credential, and effort unchanged.
 *
 * Resolution order: credential, provider, then model+effort (joint).
 *
 * - Credential: an explicit name must resolve for its provider via
 *   `credentialNamesFor` when the host injects it (no port: no check). Core
 *   never reads the auth store itself. A credential-only switch is a live
 *   field write: the transport resolves stored auth per request.
 * - Provider: unchanged keeps the current model. Changed REQUIRES an
 *   explicit `model` in the same call (or `useProviderDefault`), else throw
 *   naming the registered models. Never fall back silently: a provider
 *   change with no model is a caller error, not a default pick. Unknown
 *   provider ids are NOT validated here — the model lookup below throws
 *   "unknown model for provider" when the provider's catalog lacks the id.
 * - Model+effort: joint, reusing the same rule `resolveModelChange` uses
 *   (keep the effort when the new model supports it, else reset to
 *   `undefined`), overlaid with an explicit `effort` validated by
 *   `resolveEffortChange`. The lookup strips a `[1m]`/`[2m]` suffix to the
 *   base id; the stored id keeps the caller's form.
 *
 * A mid-turn switch changes the next request's adapter/model/effort/auth.
 * The core also builds the system prompt again and discards the old
 * thinking for that request (`target-change.ts`). The in-flight attempt
 * keeps its target and is never rebuilt.
 */
export function resolveTargetSwitch(
  sel: TargetSelection,
  current: TargetState,
  opts: TargetSwitchRegistry,
): TargetSwitch {
  const selHas = (v: string | undefined): v is string => v !== undefined && v.length > 0
  const nextProvider = selHas(sel.providerId) ? sel.providerId : current.providerId
  const providerChanged = nextProvider !== current.providerId
  // A credential name belongs to one provider: a provider change with no
  // explicit name drops the old one (the new provider's default applies).
  const nextCredential =
    sel.credentialName !== undefined
      ? sel.credentialName
      : providerChanged
        ? undefined
        : current.credentialName

  // 1. Credential must exist for its provider. The host injects the
  // store-backed check; core never touches the auth store.
  if (sel.credentialName !== undefined && selHas(nextProvider) && opts.credentialNamesFor) {
    const known = opts.credentialNamesFor(nextProvider)
    if (!known.includes(sel.credentialName)) {
      throw new Error(
        `unknown credential "${sel.credentialName}" for provider "${nextProvider}". ` +
          `Registered: ${known.length > 0 ? known.join(", ") : "(none)"}`,
      )
    }
  } else if (sel.credentialName !== undefined && !selHas(nextProvider)) {
    throw new Error(
      `cannot switch credential "${sel.credentialName}" with no provider: ` +
        `pass providerId in the same call.`,
    )
  }

  // 2. Provider change requires an explicit model (or the default flag).
  // Same-provider keeps the current model unless the caller names one.
  let nextModelRaw: string | undefined
  if (sel.model !== undefined) {
    nextModelRaw = sel.model
  } else if (providerChanged) {
    if (sel.useProviderDefault === true) {
      const fallback = opts.defaultModelFor(nextProvider ?? "")
      if (fallback === undefined) {
        const registered = nextProvider !== undefined ? opts.registeredModelsFor(nextProvider) : []
        throw new Error(
          `switching provider to "${nextProvider ?? "(none)"}" with useProviderDefault found no registered model. ` +
            `Registered: ${registered.length > 0 ? registered.join(", ") : "(none)"}`,
        )
      }
      nextModelRaw = fallback
    } else {
      const registered = nextProvider !== undefined ? opts.registeredModelsFor(nextProvider) : []
      throw new Error(
        `switching provider to "${nextProvider ?? "(none)"}" requires an explicit model in the same call. ` +
          `Registered: ${registered.length > 0 ? registered.join(", ") : "(none)"}`,
      )
    }
  } else {
    nextModelRaw = current.model
  }

  // 3. Joint model+effort resolution. Lookup strips suffixes; the stored id
  // keeps the caller's form (same rule as resolveModelChange).
  const apiModel = normalizeModelForAPI(nextModelRaw)
  const entry = nextProvider
    ? resolveModelForProvider(apiModel, nextProvider)
    : resolveModel(apiModel)
  const modelChanged = providerChanged || nextModelRaw !== current.model
  if (opts.structuredOutputsRequired && modelChanged && !entry.capabilities.structuredOutputs) {
    throw new Error(
      `model "${nextModelRaw}" has no structured outputs, and an output schema is set. ` +
        `Select a model with structured outputs.`,
    )
  }
  // An explicit effort wins over the keep-or-reset rule; undefined effort
  // keeps the current level when the new model supports it.
  const requestedEffort = sel.effort !== undefined ? sel.effort : current.effort
  const validation = validateEffortForModel(requestedEffort, entry.capabilities.effort.levels)
  if (!validation.ok) {
    // Fall back to the keep-or-reset rule for a non-explicit effort: reset
    // to the model default instead of throwing (same as setModel).
    if (sel.effort === undefined) {
      const to: TargetState = {
        ...(nextCredential !== undefined ? { credentialName: nextCredential } : {}),
        ...(nextProvider !== undefined ? { providerId: nextProvider } : {}),
        model: nextModelRaw,
        effort: undefined,
      }
      return {
        from: { ...current },
        to,
        effortReset: current.effort !== undefined,
        effortFrom: current.effort,
      }
    }
    throw new Error(validation.reason)
  }
  const to: TargetState = {
    ...(nextCredential !== undefined ? { credentialName: nextCredential } : {}),
    ...(nextProvider !== undefined ? { providerId: nextProvider } : {}),
    model: nextModelRaw,
    effort: requestedEffort,
  }
  const effortReset = requestedEffort === undefined && current.effort !== undefined
  return {
    from: { ...current },
    to,
    effortReset,
    effortFrom: effortReset ? current.effort : undefined,
  }
}
