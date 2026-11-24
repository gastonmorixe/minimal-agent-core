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

/**
 * Wire form that produced a node. `v1-text` is an old bracket notice: only
 * {@link SidebandApi.trailing} and a query with `legacyText: true` read it.
 */
export type SidebandForm = "v2" | "v1" | "v1-bare" | "v1-text"

/** A UTF-16 range of a text, end exclusive. */
export interface SidebandSpan {
  /** Start offset. */
  start: number
  /** End offset, exclusive. */
  end: number
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
  form: SidebandForm
  /** Qualified name seen in a legacy form. */
  legacyQname?: string
  /** UTF-16 offsets, end exclusive. */
  span: SidebandSpan
  /** Span of the start part. Optional: a codec can omit it. */
  open?: SidebandSpan
  /** Span of the end part. Absent when the node is self-closing. */
  close?: SidebandSpan
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

/** Options of a codec `parse` call. */
export interface SidebandParseOptions {
  /** Also give the nodes inside a node body. Default false (top level only). */
  nested?: boolean
  /** Also read old bracket notices (form `v1-text`). Default false. */
  legacyText?: boolean
}

/** A filter for the read functions of {@link SidebandApi}. */
export interface SidebandQuery {
  /** Kind names. Default: each node, also a kind that is not registered. */
  kinds?: readonly string[]
  /** Only nodes of a registered kind with this direction. */
  direction?: SidebandKind["direction"]
  /** Only nodes of a registered kind with this placement. */
  placement?: SidebandKind["placement"]
  /** Also give nested nodes. Default false (top level only). */
  nested?: boolean
  /** Also read old bracket notices. Default false. */
  legacyText?: boolean
}

/** Options of a codec `stripLenient` call. */
export interface SidebandStripLenientOptions {
  /** Only parts of these kinds. Default: each name that the codec maps to a kind. */
  kinds?: readonly string[]
  /** True: remove only the tag parts, and keep the text between them. Default false. */
  keepBody?: boolean
  /** The text that replaces each removed part or node. Default `""`. */
  replacement?: string
}

/** Options of {@link SidebandApi.strip}: a query, and how to remove. */
export interface SidebandStripOptions extends SidebandQuery {
  /**
   * Also remove broken tag parts: a lone end part, a start part with no end
   * part (with the rest of its line when a line feed follows), and a start
   * part that the text cuts at its end. Uses the codec `stripLenient`; with
   * a codec that has none, the normal strip runs. Default false.
   */
  lenient?: boolean
  /** With `lenient`: remove only the tag parts, keep the text between them. Default false. */
  keepBody?: boolean
  /** The text that replaces each removed node or part. Default `""`. */
  replacement?: string
}

/** Options of a streaming scanner. */
export interface StreamScanOptions {
  /** Kind names to read. Default: each registered from-model kind. */
  kinds?: readonly string[]
  /** Skip code fences and code spans. Default true. */
  codeAware?: boolean
  /** Hold limit of an open part, in UTF-16 units. Default 1024. */
  maxOpenUnits?: number
  /** Hold limit of a full node, in UTF-16 units. Default 65536. */
  maxSpanUnits?: number
  /**
   * The grammar of the old core inline-tag scanner (the core stream sets it):
   * only the exact v1 emit opener and its exact end part make a node, the kind
   * is the name as written, and no open-part hold limit applies unless
   * `maxOpenUnits` is set. A codec can ignore it. Default false.
   */
  strictV1?: boolean
}

/** Typed attribute values of a node, by the kind declaration. */
export type SidebandAttrs = Readonly<Record<string, SidebandAttrValue>>

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
  /** Parse text to nodes. A codec can ignore `opts` (then: top level, no legacy text). */
  parse(text: string, opts?: SidebandParseOptions): SidebandNode[]
  /** Make a streaming scanner. A codec can ignore `opts`. */
  scanner(opts?: StreamScanOptions): StreamScanner
  /** Make untrusted text safe. */
  neutralize(untrusted: string): string
  /** Render an example for a kind. */
  example(kind: SidebandKind, msg?: SidebandMessage): string
  /** Optional. The name of a kind for prompt text (SB-DOC-2). Default: the kind name. */
  name?(kind: SidebandKind): string
  /**
   * Optional. Render only the start part of a node (no body, no end part),
   * for prompt text that shows the start of a block. Default: the API gives
   * `""` and a `sideband.render-dropped` diagnostic.
   */
  open?(kind: SidebandKind, msg: SidebandMessage): string
  /**
   * Optional. Render only the end part of a node. Default: the API gives
   * `""` and a `sideband.render-dropped` diagnostic.
   */
  close?(kind: SidebandKind): string
  /**
   * Optional. Start of the annotation region at the end of `text`, or
   * `text.length` when there is none. Linear, from the end, no node objects.
   * Default: core finds it with `parse`.
   */
  trailingStart?(text: string): number
  /**
   * Optional. Remove each complete node and each broken tag part (a lone end
   * part, a start part with no end part, a start part that the text cuts at
   * its end) of the known kinds, or of `opts.kinds`. Linear time. Default:
   * core uses the normal strip (complete nodes only).
   */
  stripLenient?(text: string, opts?: SidebandStripLenientOptions): string
  /**
   * Optional. The node that starts at the first non-space character of
   * `text`, else `undefined`. A start part with no end part counts. Default:
   * core uses the `parse` spans (complete nodes only).
   */
  leadingNode?(text: string): SidebandNode | undefined
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

/**
 * The one sideband API for all consumers. Code gives data (`kind`, `attrs`,
 * `body`) and gets text. Code reads nodes, not characters. Core builds the
 * read functions on the codec `parse` spans, so it knows no wire form.
 */
export interface SidebandApi {
  /** False when no codec is loaded. Then `render` gives `""`. */
  readonly ready: boolean
  /** Render a message of a registered kind. Throws `SidebandKindUnknownError` for an unknown kind. */
  render(kind: string, msg?: Omit<SidebandMessage, "kind">): string
  /**
   * Render only the start part of a node of a registered kind. The same
   * rules as `render`: no codec gives `""`, an unknown kind throws
   * `SidebandKindUnknownError`. A codec with no `open` gives `""`.
   */
  open(kind: string, msg?: Omit<SidebandMessage, "kind" | "body">): string
  /** Render only the end part of a node. The same rules as {@link SidebandApi.open}. */
  close(kind: string): string
  /** The nodes of `text` that match `q`, in text order. */
  find(text: string, q?: SidebandQuery): SidebandNode[]
  /** True when `text` has a node that matches `q`. */
  has(text: string, q?: SidebandQuery): boolean
  /** True when the first non-space content of `text` is a node that matches `q`. */
  startsWith(text: string, q?: SidebandQuery): boolean
  /**
   * Replace each node that matches `q`. `fn` gives the new text, `""` to
   * remove the node, or `undefined` to keep it. Offsets stay correct.
   */
  replace(text: string, fn: (n: SidebandNode) => string | undefined, q?: SidebandQuery): string
  /**
   * Remove each node that matches `q`. With `q.lenient`, also remove broken
   * tag parts (see {@link SidebandStripOptions}).
   */
  strip(text: string, q?: SidebandStripOptions): string
  /**
   * The kind of the node at the first non-space character of `text` (a
   * start part with no end part counts when the codec can read it), else
   * `undefined`. The codec decides the kind: it can be a kind that is not
   * registered (see {@link SidebandApi.kindInfo}).
   */
  leadingKind(text: string): string | undefined
  /** The direction and placement of a registered kind, else `undefined`. */
  kindInfo(kind: string): Pick<SidebandKind, "direction" | "placement"> | undefined
  /**
   * The annotation region at the end of `text`. `bodyEnd` is the end of the
   * body before the region (`text.length` when there is none). It reads old
   * bracket notices.
   */
  trailing(text: string, q?: SidebandQuery): { bodyEnd: number; nodes: SidebandNode[] }
  /** Typed attribute values. Drops an attribute that is not declared or has a bad value. */
  attrs(node: SidebandNode): SidebandAttrs
  /** Make untrusted text safe. */
  neutralize(untrusted: string): string
  /** Make a streaming scanner. */
  scanner(opts?: StreamScanOptions): StreamScanner
  /** The name of a kind for prompt text (SB-DOC-2). */
  name(kind: string): string
  /** An example of a kind for prompt text (SB-DOC-1). */
  example(kind: string, msg?: Omit<SidebandMessage, "kind">): string
  /** The registered kinds that match `q`. */
  kinds(q?: Pick<SidebandQuery, "direction" | "placement">): readonly SidebandKind[]
  /**
   * True when the owner of `kind` gave a display handler that loaded. Cheap
   * (one map read).
   */
  hasDisplay(kind: string): boolean
  /**
   * The display of one node, or `undefined`: no handler, the handler gave
   * none, or it failed (a throw or a thenable result).
   */
  displayNode(node: SidebandNode, opts: SidebandDisplayOptions): SidebandDisplay | undefined
  /**
   * Split `text` at each top-level node that has a display. A node with no
   * display stays in a text segment. `changed` is false when no node has a
   * display: then `segments` is one text segment with all of `text` (none
   * for an empty text). A block with a `sideband` mark is the job of the
   * consumer: it must not call this for such a block.
   */
  display(
    text: string,
    opts: SidebandDisplayOptions,
  ): { segments: SidebandDisplaySegment[]; changed: boolean }
}

/** The display mode: `"label"` is one short line, `"full"` adds the text when the handler has it. */
export type SidebandDisplayMode = "label" | "full"

/** The result of one display handler, after the core checks. */
export interface SidebandDisplay {
  /** One line, no ANSI, no control characters. Core cleans it and cuts it to 80 cells. */
  label: string
  /** Full mode only (core drops it in label mode). Plain text, can have many lines. */
  text?: string
  /** True when the handler cut `text` to the size cap. */
  truncated?: boolean
  /** True when the node refers to data that is not there. Then `text` is absent. */
  missing?: boolean
}

/** Options of {@link SidebandApi.display} and {@link SidebandApi.displayNode}. */
export interface SidebandDisplayOptions {
  /** The display mode. */
  mode: SidebandDisplayMode
  /** The session of the text. Absent: the handler uses the attrs only. */
  sid?: string
  /** Full mode: the largest `text` in UTF-8 bytes that the consumer wants. Absent: the handler default. */
  maxBytes?: number
  /** Limit to these kinds. Default: each kind that has a display handler. */
  kinds?: readonly string[]
}

/** One part of a text after {@link SidebandApi.display}. */
export type SidebandDisplaySegment =
  | {
      /** Plain text. */
      type: "text"
      /** The text, as it is in the input. */
      text: string
    }
  | {
      /** A node with a display. */
      type: "node"
      /** The parsed node. */
      node: SidebandNode
      /** The kind name of the node. */
      kind: string
      /** The display of the node. */
      display: SidebandDisplay
      /** The span of the node in code points (the column model of the editor). */
      cp: SidebandSpan
    }

/** The read slice of {@link SidebandApi}, for pure functions. */
export type SidebandReader = Pick<
  SidebandApi,
  | "find"
  | "has"
  | "startsWith"
  | "replace"
  | "strip"
  | "trailing"
  | "attrs"
  | "leadingKind"
  | "kindInfo"
>

/**
 * Context handed to plugins (the S1.1 name stays): the full
 * {@link SidebandApi} plus the raw codec `parse`.
 */
export interface PluginSidebandContext extends SidebandApi {
  /** Parse text to nodes (the raw codec call). */
  parse(text: string): SidebandNode[]
}

/** Metadata a content block carries when it holds rendered text. */
export interface SidebandBlockMeta {
  /**
   * Kind of the rendered text, plus the optional `origin` label of the
   * writer (a hook or a plugin). The label is debug metadata: no encoder
   * sends it, and it never enters the block text.
   */
  sideband?: { kind: string; origin?: string }
}
