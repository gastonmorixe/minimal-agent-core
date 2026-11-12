/**
 * Sideband data model. Pure types, no runtime text. Part of plugin-api.
 *
 * @packageDocumentation
 */

/** Value allowed for an attribute in a message. */
export type SidebandAttrValue = string | number | boolean

/** A message a plugin asks the codec to render. */
export interface SidebandMessage {
  /** Registered kind name. */
  kind: string
  /** Attribute values by name. */
  attrs?: Record<string, SidebandAttrValue>
  /** Optional body. */
  body?: string
}

/** A node the codec parsed from text. */
export interface SidebandNode {
  /** Kind name. */
  kind: string
  /** Attribute values by name. */
  attrs: Record<string, string>
  /** Optional body. */
  body?: string
  /** True when the node had no end marker. */
  selfClosing: boolean
  /** Wire form that produced the node. */
  form: "v2" | "v1" | "v1-bare"
  /** Qualified name seen in a legacy form. */
  legacyQname?: string
  /** UTF-16 offsets, end exclusive. */
  span: { start: number; end: number }
}

/** Attribute value type. */
export type SidebandAttrType = "string" | "int" | "bool" | "enum"

/** Declaration of one attribute. */
export interface SidebandAttrDecl {
  /** Value type. */
  type: SidebandAttrType
  /** Allowed values. Required when type is enum. */
  values?: string[]
  /** True when the attribute must be present. */
  required?: boolean
}

/** Declaration of one kind. */
export interface SidebandKind {
  /** Kind name. */
  kind: string
  /** Plugin id. Set by the registry. */
  owner: string
  /** Who writes the message. */
  direction: "to-model" | "from-model"
  /** Where the message sits in a request. */
  placement: "system" | "turn" | "tool-result" | "inline"
  /** Attribute declarations. Key order is render order. */
  attrs: Record<string, SidebandAttrDecl>
  /** Body mode. */
  body: "none" | "text" | "raw"
  /** Layout. Default is inline. */
  layout?: "inline" | "block"
  /** Trust level of the content. */
  trust: "harness" | "untrusted"
  /** Short description. */
  summary: string
  /** Example message. */
  example?: SidebandMessage
  /** Legacy alias names. */
  legacy?: string[]
  /** True when legacy bodies are escaped. */
  legacyBodyEscaped?: boolean
}

/** Streaming scanner made by a codec. */
export interface StreamScanner {
  /** Feed a chunk. */
  write(chunk: string): void
  /** Flush at end of stream. */
  end(): void
  /** Set the plain text callback. */
  onText(cb: (text: string) => void): void
  /** Set the node callback. */
  onNode(cb: (node: SidebandNode, raw: string) => void): void
}

/** Codec contract. A plugin supplies it. Core holds no implementation. */
export interface SidebandCodec {
  /** Codec id. */
  id: string
  /** Render a message to text. */
  render(kind: SidebandKind, msg: SidebandMessage): string
  /** Parse text to nodes. */
  parse(text: string): SidebandNode[]
  /** Make a streaming scanner. */
  scanner(): StreamScanner
  /** Make untrusted text safe. */
  neutralize(untrusted: string): string
  /** Render an example for a kind. */
  example(kind: SidebandKind, msg?: SidebandMessage): string
}

/** Factory that builds a codec from a read-only registry view. */
export type SidebandCodecFactory = (registry: ReadonlySidebandRegistry) => SidebandCodec

/** Read-only registry view. */
export interface ReadonlySidebandRegistry {
  /** Find a kind by name. */
  kind(name: string): SidebandKind | undefined
  /** List all kinds. */
  kinds(): readonly SidebandKind[]
}

/** Mutable registry. */
export interface SidebandRegistry extends ReadonlySidebandRegistry {
  /** Register a kind. Throws a typed error on any rule failure. */
  register(kind: SidebandKind, ownerPluginId: string): void
  /** Set the codec factory. Throws on a second codec. */
  setCodec(factory: SidebandCodecFactory, ownerPluginId: string): void
  /** Get the codec. Throws when none is set. */
  codec(): SidebandCodec
  /** Reject all later register calls. */
  freeze(): void
}

/** Context handed to plugins. */
export interface PluginSidebandContext {
  /** Render a message of a kind. */
  render(kind: string, msg: Omit<SidebandMessage, "kind">): string
  /** Parse text to nodes. */
  parse(text: string): SidebandNode[]
}

/** Metadata a content block carries when it holds rendered text. */
export interface SidebandBlockMeta {
  /** Kind of the rendered text. */
  sideband?: { kind: string }
}
