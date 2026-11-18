/**
 * Sideband registry. Holds kinds and one codec factory. Holds no text.
 *
 * @packageDocumentation
 */

import { CORE_OWNED_KINDS } from "../sdk/tool-outcome-record.ts"

import {
  SidebandCodecDuplicateError,
  SidebandCodecMissingError,
  SidebandKindDuplicateError,
  SidebandKindInvalidError,
  type SidebandKindRule,
  SidebandLegacyAliasDuplicateError,
  SidebandRegistryFrozenError,
} from "./errors.ts"
import type {
  SidebandCodec,
  SidebandCodecFactory,
  SidebandKind,
  SidebandRegistry,
} from "./types.ts"

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/
const NAME_MAX = 64
const XML_PREFIX_RE = /^xml/i

function validName(name: string): boolean {
  return name.length >= 1 && name.length <= NAME_MAX && NAME_RE.test(name)
}

function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  )
}

function allXmlChars(text: string): boolean {
  for (const ch of text) {
    if (!isXmlChar(ch.codePointAt(0) ?? -1)) return false
  }
  return true
}

function firstViolation(kind: SidebandKind, owner: string): SidebandKindRule | undefined {
  if (owner === "" || owner === "core") return "core-owner"
  if (XML_PREFIX_RE.test(kind.kind)) return "kind-xml-prefix"
  if (!validName(kind.kind)) return "kind-name"
  // D4 owner rule 3: a core annotation kind (`CoreAnnotationKind`) belongs to
  // core only. Kind names have no normalization: `validName` accepts lower
  // case only, so an exact compare after it covers each form that can register.
  if (CORE_OWNED_KINDS.has(kind.kind)) return "core-kind"
  for (const [attrName, decl] of Object.entries(kind.attrs)) {
    if (!validName(attrName)) return "attr-name"
    if (decl.type === "enum") {
      if (!decl.values || decl.values.length === 0) return "enum-values"
      if (!decl.values.every(allXmlChars)) return "enum-value-char"
    }
  }
  if (kind.direction === "from-model") {
    if (kind.body === "raw") return "from-model-raw-body"
    if (kind.placement !== "inline") return "from-model-placement"
  }
  return undefined
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * Make an empty sideband registry.
 *
 * @returns A mutable registry. Call `freeze` after plugin load.
 */
export function createSidebandRegistry(): SidebandRegistry {
  const kinds = new Map<string, SidebandKind>()
  const aliases = new Map<string, string>()
  let factory: SidebandCodecFactory | undefined
  let codecOwner = ""
  let built: SidebandCodec | undefined
  let frozen = false

  const registry: SidebandRegistry = {
    register(kind, ownerPluginId) {
      if (frozen) throw new SidebandRegistryFrozenError(ownerPluginId)
      const rule = firstViolation(kind, ownerPluginId)
      if (rule) throw new SidebandKindInvalidError(kind.kind, ownerPluginId, rule)
      const existing = kinds.get(kind.kind)
      if (existing) {
        throw new SidebandKindDuplicateError(kind.kind, existing.owner, ownerPluginId)
      }
      for (const alias of kind.legacy ?? []) {
        const holder = aliases.get(alias)
        if (holder !== undefined) {
          throw new SidebandLegacyAliasDuplicateError(alias, holder, kind.kind)
        }
      }
      kinds.set(kind.kind, deepFreeze(structuredClone({ ...kind, owner: ownerPluginId })))
      for (const alias of kind.legacy ?? []) aliases.set(alias, kind.kind)
    },
    kind(name) {
      return kinds.get(name)
    },
    kinds() {
      return [...kinds.values()]
    },
    setCodec(next, ownerPluginId) {
      if (frozen) throw new SidebandRegistryFrozenError(ownerPluginId)
      if (factory) throw new SidebandCodecDuplicateError(codecOwner, ownerPluginId)
      factory = next
      codecOwner = ownerPluginId
    },
    codec() {
      if (!factory) throw new SidebandCodecMissingError()
      built ??= factory({ kind: registry.kind, kinds: registry.kinds })
      return built
    },
    freeze() {
      frozen = true
    },
  }
  return registry
}
