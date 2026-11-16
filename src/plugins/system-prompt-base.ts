/**
 * Loader side and holder of the system prompt base provider. Holds no prompt
 * text. Core reads the holder lazily when it builds the system prompt.
 *
 * @module plugins/system-prompt-base
 */

import { CoreError } from "../errors/core-error.ts"

import { pluginPackageFor } from "./source.ts"
import type {
  ManifestSystemPromptBase,
  SystemPromptBaseProvider,
  SystemPromptIdentityContext,
  SystemPromptPartsContext,
  SystemPromptSlot,
} from "./types.ts"

/** The slot key that stands for the identity method in a conflict. */
export const IDENTITY_SLOT = "identity" as const

/** Thrown when a second provider claims a slot that another provider owns. */
export class SystemPromptSlotConflictError extends CoreError {
  static readonly kind = "SystemPromptSlotConflictError"
  declare readonly kind: "SystemPromptSlotConflictError"
  /** The contested slot, or `identity`. */
  readonly slot: SystemPromptSlot | typeof IDENTITY_SLOT
  /** Ids of the owner plugin and the refused plugin, in that order. */
  readonly pluginIds: readonly [string, string]

  constructor(
    slot: SystemPromptSlot | typeof IDENTITY_SLOT,
    pluginIds: readonly [string, string],
    options?: { cause?: unknown },
  ) {
    super(options)
    this.slot = slot
    this.pluginIds = pluginIds
  }
}

/** One registered provider and the slots it owns. */
export interface SystemPromptBaseEntry {
  /** Id of the plugin that supplied the provider. */
  pluginId: string
  /** The provider. */
  provider: SystemPromptBaseProvider
  /** Slots that this provider fills. */
  slots: readonly SystemPromptSlot[]
}

/** Private holder of the registered providers. */
export interface SystemPromptBaseHolder {
  /** Registered providers, in registration order. */
  entries: SystemPromptBaseEntry[]
}

/** Make an empty holder. */
export function createSystemPromptBaseHolder(): SystemPromptBaseHolder {
  return { entries: [] }
}

/** Parse a raw `systemPromptBase` value. Returns undefined when it is not `{id, entry}` of non-empty strings. */
export function parseSystemPromptBaseRaw(raw: unknown): ManifestSystemPromptBase | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const { id, entry } = raw as Record<string, unknown>
  if (typeof id !== "string" || id.length === 0) return undefined
  if (typeof entry !== "string" || entry.length === 0) return undefined
  return { id, entry }
}

/** Shape check for a provider object: an object with at least one method. */
function isProvider(v: unknown): v is SystemPromptBaseProvider {
  if (v === null || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  const hasIdentity = typeof o.identity === "function"
  const hasParts = typeof o.instructionParts === "function"
  if (o.identity !== undefined && !hasIdentity) return false
  if (o.instructionParts !== undefined && !hasParts) return false
  return hasIdentity || hasParts
}

/**
 * Register a provider. Enforces at most one provider per slot and one
 * identity provider. A provider with data `slots` is checked by that list and
 * not called. A provider with no `slots` is called once with no ctx to learn
 * the slots. On a conflict, throws {@link SystemPromptSlotConflictError} and
 * leaves the holder unchanged.
 */
export function registerSystemPromptBase(
  holder: SystemPromptBaseHolder,
  pluginId: string,
  provider: SystemPromptBaseProvider,
): void {
  const slots = new Set<SystemPromptSlot>()
  const declared = provider.slots ?? provider.instructionParts?.().map((part) => part.slot) ?? []
  for (const slot of declared) {
    if (slots.has(slot)) throw new SystemPromptSlotConflictError(slot, [pluginId, pluginId])
    slots.add(slot)
  }
  for (const entry of holder.entries) {
    for (const slot of slots) {
      if (entry.slots.includes(slot)) {
        throw new SystemPromptSlotConflictError(slot, [entry.pluginId, pluginId])
      }
    }
    if (provider.identity !== undefined && entry.provider.identity !== undefined) {
      throw new SystemPromptSlotConflictError(IDENTITY_SLOT, [entry.pluginId, pluginId])
    }
  }
  holder.entries.push({ pluginId, provider, slots: [...slots] })
}

/**
 * Read every provider now and return the text per slot. The map order is not part of the contract.
 * Providers must return stable parts: register refuses a duplicate slot, collect does not re-check.
 * An EMPTY provider part "" overrides the default: the caller does not fall back to the core text.
 *
 * A provider with data `slots` gets `ctx` at each call. Each declared slot is in
 * the map: a declared slot with no returned part maps to "" (the slot is off).
 * Parts for slots that it did not declare are ignored. A provider with
 * `slots` but no `instructionParts` maps each declared slot to "". A provider
 * with no `slots` is called with no ctx, as before.
 */
export function collectSystemPromptParts(
  holder: SystemPromptBaseHolder,
  ctx?: SystemPromptPartsContext,
): Map<SystemPromptSlot, string> {
  const out = new Map<SystemPromptSlot, string>()
  for (const { provider } of holder.entries) {
    const declared = provider.slots
    if (declared === undefined) {
      for (const part of provider.instructionParts?.() ?? []) out.set(part.slot, part.text)
      continue
    }
    // Declared slots are owned even with no instructionParts: they are off.
    for (const slot of declared) out.set(slot, "")
    if (provider.instructionParts === undefined) continue
    for (const part of provider.instructionParts(ctx)) {
      if (declared.includes(part.slot)) out.set(part.slot, part.text)
    }
  }
  return out
}

/**
 * True when the provider that owns `slot` declares data `slots`. Such a
 * provider renders its text from the ctx facts itself (e.g. `agentHome`), so
 * core must not render templates in its part.
 */
export function slotOwnedByCtxProvider(
  holder: SystemPromptBaseHolder,
  slot: SystemPromptSlot,
): boolean {
  return holder.entries.some((e) => e.provider.slots !== undefined && e.slots.includes(slot))
}

/** Return the base identity from the identity provider, or undefined when none. */
export function resolveBaseIdentity(
  holder: SystemPromptBaseHolder,
  ctx: SystemPromptIdentityContext,
): string | undefined {
  for (const { provider } of holder.entries) {
    if (provider.identity !== undefined) return provider.identity(ctx)
  }
  return undefined
}

/** Closed codes of a failed provider load. */
export type SystemPromptBaseLoadFailure = "module_not_found" | "no_provider_export" | "load_failed"

/** Scalar data of one failed provider load. `reason` is "" or an error class name. */
export interface SystemPromptBaseFailure {
  code: SystemPromptBaseLoadFailure
  packageDir: string
  abs: string
  reason: string
}

/**
 * Import the provider entry and register it in `holder`. The default export
 * is a factory or a provider object. A failure goes to `onFailure` as a typed
 * code (no text) and leaves the holder unchanged. A slot conflict goes only
 * to `onConflict`. Never throws.
 */
export async function loadSystemPromptBaseProvider(
  raw: unknown,
  packageDir: string,
  holder: SystemPromptBaseHolder,
  pluginId: string,
  onFailure: (f: SystemPromptBaseFailure) => void,
  onConflict?: (e: SystemPromptSlotConflictError) => void,
): Promise<void> {
  const decl = parseSystemPromptBaseRaw(raw)
  if (decl === undefined) return
  // Go through the package source, so an embedded package loads too.
  const pkg = pluginPackageFor(packageDir)
  const abs = pkg.resolve(decl.entry)
  const fail = (code: SystemPromptBaseLoadFailure, reason = "") =>
    onFailure({ code, packageDir, abs, reason })
  if (!pkg.hasFile(decl.entry)) return fail("module_not_found")
  try {
    const mod = (await pkg.importModule(decl.entry)) as { default?: unknown }
    const made = typeof mod.default === "function" ? (mod.default as () => unknown)() : mod.default
    if (!isProvider(made)) return fail("no_provider_export")
    registerSystemPromptBase(holder, pluginId, made)
  } catch (e) {
    if (e instanceof SystemPromptSlotConflictError) return onConflict?.(e)
    fail("load_failed", e instanceof Error ? e.name : "")
  }
}
