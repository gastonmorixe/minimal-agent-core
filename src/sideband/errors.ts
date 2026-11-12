/**
 * Typed sideband errors. The message is always empty. Callers read the fields.
 *
 * @packageDocumentation
 */

/** Rule ids for a rejected kind declaration. */
export type SidebandKindRule =
  | "kind-name"
  | "kind-xml-prefix"
  | "attr-name"
  | "enum-values"
  | "enum-value-char"
  | "from-model-raw-body"
  | "from-model-placement"
  | "core-owner"

/** Base of all sideband errors. */
export abstract class SidebandError extends Error {
  /** Class identity at runtime. Subclasses override it. */
  static readonly kind: string = "SidebandError"
  /** Class identity on the instance. */
  readonly kind: string

  /** Build the error with an empty message. */
  constructor() {
    super("")
    const ctor = new.target as unknown as { kind: string }
    this.kind = ctor.kind
    this.name = ctor.kind
  }

  /** Typed fields as a plain object. */
  protected abstract fields(): Record<string, unknown>

  /** JSON shape: kind and fields. */
  toJSON(): { kind: string; fields: Record<string, unknown> } {
    return { kind: this.kind, fields: this.fields() }
  }
}

/** Two plugins declared the same kind. */
export class SidebandKindDuplicateError extends SidebandError {
  /** Class identity. */
  static override readonly kind = "SidebandKindDuplicateError"
  declare readonly kind: "SidebandKindDuplicateError"

  /** Build the error. */
  constructor(
    readonly sidebandKind: string,
    readonly ownerA: string,
    readonly ownerB: string,
  ) {
    super()
  }

  /** Typed fields. */
  protected fields(): Record<string, unknown> {
    return { sidebandKind: this.sidebandKind, ownerA: this.ownerA, ownerB: this.ownerB }
  }
}

/** A legacy alias is already owned by another kind. */
export class SidebandLegacyAliasDuplicateError extends SidebandError {
  /** Class identity. */
  static override readonly kind = "SidebandLegacyAliasDuplicateError"
  declare readonly kind: "SidebandLegacyAliasDuplicateError"

  /** Build the error. */
  constructor(
    readonly alias: string,
    readonly kindA: string,
    readonly kindB: string,
  ) {
    super()
  }

  /** Typed fields. */
  protected fields(): Record<string, unknown> {
    return { alias: this.alias, kindA: this.kindA, kindB: this.kindB }
  }
}

/** A kind declaration broke a registry rule. */
export class SidebandKindInvalidError extends SidebandError {
  /** Class identity. */
  static override readonly kind = "SidebandKindInvalidError"
  declare readonly kind: "SidebandKindInvalidError"

  /** Build the error. */
  constructor(
    readonly sidebandKind: string,
    readonly pluginId: string,
    readonly rule: SidebandKindRule,
  ) {
    super()
  }

  /** Typed fields. */
  protected fields(): Record<string, unknown> {
    return { sidebandKind: this.sidebandKind, pluginId: this.pluginId, rule: this.rule }
  }
}

/** No codec is registered. */
export class SidebandCodecMissingError extends SidebandError {
  /** Class identity. */
  static override readonly kind = "SidebandCodecMissingError"
  declare readonly kind: "SidebandCodecMissingError"

  /** Typed fields. */
  protected fields(): Record<string, unknown> {
    return {}
  }
}

/** A second codec was set. */
export class SidebandCodecDuplicateError extends SidebandError {
  /** Class identity. */
  static override readonly kind = "SidebandCodecDuplicateError"
  declare readonly kind: "SidebandCodecDuplicateError"

  /** Build the error. */
  constructor(
    readonly ownerA: string,
    readonly ownerB: string,
  ) {
    super()
  }

  /** Typed fields. */
  protected fields(): Record<string, unknown> {
    return { ownerA: this.ownerA, ownerB: this.ownerB }
  }
}

/** The registry is frozen. */
export class SidebandRegistryFrozenError extends SidebandError {
  /** Class identity. */
  static override readonly kind = "SidebandRegistryFrozenError"
  declare readonly kind: "SidebandRegistryFrozenError"

  /** Build the error. */
  constructor(readonly ownerPluginId: string) {
    super()
  }

  /** Typed fields. */
  protected fields(): Record<string, unknown> {
    return { ownerPluginId: this.ownerPluginId }
  }
}

/** Render asked for a kind that is not registered. */
export class SidebandKindUnknownError extends SidebandError {
  /** Class identity. */
  static override readonly kind = "SidebandKindUnknownError"
  declare readonly kind: "SidebandKindUnknownError"

  /** Build the error. */
  constructor(readonly sidebandKind: string) {
    super()
  }

  /** Typed fields. */
  protected fields(): Record<string, unknown> {
    return { sidebandKind: this.sidebandKind }
  }
}
