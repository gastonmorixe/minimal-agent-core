/**
 * Manifest parser for plugin packages.
 *
 * Validates the shape of a `manifest.json` file against the schema defined in
 * the spec. Returns a typed `ManifestFile` on success, or throws a
 * {@link ManifestError} with the offending path and a human-readable message.
 *
 * This module is intentionally dependency-free: no JSON schema libraries, no
 * zod, no ajv. Plugin manifests are small and rare, and hand-rolled checks
 * keep error messages precise.
 *
 * @module plugins/manifest
 */

import { diag } from "../diagnostic-bus.ts"

import type {
  ColorRequest,
  ManifestCommand,
  ManifestEventSubscription,
  ManifestFile,
  ManifestHandler,
  ManifestHandlerEntry,
  ManifestHookSubscription,
  ManifestLiveAreaSlot,
  ManifestMode,
  ManifestPromptFragment,
  ManifestTrigger,
  ModeStyleRequest,
  SurfaceStyleRequest,
  ThemeKey,
} from "./types.ts"

/**
 * Thrown by {@link parseManifest} when the input does not conform.
 *
 * The `manifestPath` field is the absolute path the loader was trying to
 * parse, so error logs can point the user at the right file.
 */
export class ManifestError extends Error {
  readonly manifestPath: string
  constructor(message: string, manifestPath: string) {
    super(message)
    this.name = "ManifestError"
    this.manifestPath = manifestPath
  }
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/
const TAG_RE = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Validate a parsed JSON object against the manifest schema.
 *
 * This does NOT read the file. Callers are responsible for reading and
 * JSON.parse-ing the file; this function takes the raw value and returns a
 * typed, validated `ManifestFile`.
 *
 * @param raw - Parsed JSON from `manifest.json`.
 * @param manifestPath - Absolute path for error reporting. Does not need to
 *   exist on disk.
 * @throws {@link ManifestError} on any validation failure.
 */
export function parseManifest(raw: unknown, manifestPath: string): ManifestFile {
  const err = (msg: string) => {
    throw new ManifestError(msg, manifestPath)
  }

  if (!isObject(raw)) err("manifest must be a JSON object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`id must match ${ID_RE} (got: ${JSON.stringify(id)})`)

  requireString(obj, "name", err)
  requireString(obj, "version", err)
  requireString(obj, "description", err)

  if (obj.prompt != null) {
    if (typeof obj.prompt !== "string") {
      err("prompt must be a string if present")
    }
    if ((obj.prompt as string).trim() === "") {
      err(
        "prompt must be a non-empty string if present (omit the field " +
          "to use the default ./PROMPT.md, or point at a custom path)",
      )
    }
  }

  // tuis is optional; modes is optional; every contribution field is
  // optional. The validator does NOT enforce "at least one contribution"
  // because PROMPT.md is implicit: a plugin can ship just a PROMPT.md
  // file with no manifest-declared contributions, and that's a legitimate
  // shape. The loader has filesystem access and surfaces a warning if a
  // plugin truly contributes nothing (no declared fields AND no PROMPT.md
  // on disk).
  if (obj.tuis != null && !Array.isArray(obj.tuis)) {
    err("tuis must be an array if present")
  }
  if (obj.modes != null && !Array.isArray(obj.modes)) {
    err("modes must be an array if present")
  }
  if (obj.events != null && !Array.isArray(obj.events)) {
    err("events must be an array if present")
  }
  if (obj.hooks != null && !Array.isArray(obj.hooks)) {
    err("hooks must be an array if present")
  }
  if (obj.promptFragments != null && !Array.isArray(obj.promptFragments)) {
    err("promptFragments must be an array if present")
  }
  if (obj.liveAreaSlots != null && !Array.isArray(obj.liveAreaSlots)) {
    err("liveAreaSlots must be an array if present")
  }
  if (obj.commands != null && !Array.isArray(obj.commands)) {
    err("commands must be an array if present")
  }
  if (obj.permissions != null) {
    if (!Array.isArray(obj.permissions)) err("permissions must be an array if present")
    for (const p of obj.permissions as unknown[]) {
      if (typeof p !== "string" || p.length === 0) {
        err(`permissions entries must be non-empty strings (got: ${JSON.stringify(p)})`)
      }
    }
  }
  if (obj.requiresUnsafeHooks != null && typeof obj.requiresUnsafeHooks !== "boolean") {
    err("requiresUnsafeHooks must be a boolean if present")
  }
  if (obj.enabled != null && typeof obj.enabled !== "boolean") {
    err("enabled must be a boolean if present")
  }

  const seenHandlerIds = new Set<string>()
  const tuis: ManifestHandler[] = []
  const tuisRaw = (obj.tuis ?? []) as unknown[]
  for (let i = 0; i < tuisRaw.length; i++) {
    tuis.push(parseHandler(tuisRaw[i], i, manifestPath, seenHandlerIds))
  }

  const seenModeIds = new Set<string>()
  const modes: ManifestMode[] = []
  const modesRaw = (obj.modes ?? []) as unknown[]
  for (let i = 0; i < modesRaw.length; i++) {
    modes.push(parseMode(modesRaw[i], i, manifestPath, seenModeIds))
  }

  const seenEventIds = new Set<string>()
  const events: ManifestEventSubscription[] = []
  const eventsRaw = (obj.events ?? []) as unknown[]
  for (let i = 0; i < eventsRaw.length; i++) {
    events.push(parseEventSub(eventsRaw[i], i, manifestPath, seenEventIds))
  }

  const seenHookIds = new Set<string>()
  const hooks: ManifestHookSubscription[] = []
  const hooksRaw = (obj.hooks ?? []) as unknown[]
  for (let i = 0; i < hooksRaw.length; i++) {
    hooks.push(parseHookSub(hooksRaw[i], i, manifestPath, seenHookIds))
  }

  const seenFragIds = new Set<string>()
  const promptFragments: ManifestPromptFragment[] = []
  const fragsRaw = (obj.promptFragments ?? []) as unknown[]
  for (let i = 0; i < fragsRaw.length; i++) {
    promptFragments.push(parsePromptFragment(fragsRaw[i], i, manifestPath, seenFragIds))
  }

  const seenSlotIds = new Set<string>()
  const liveAreaSlots: ManifestLiveAreaSlot[] = []
  const slotsRaw = (obj.liveAreaSlots ?? []) as unknown[]
  for (let i = 0; i < slotsRaw.length; i++) {
    liveAreaSlots.push(parseLiveAreaSlot(slotsRaw[i], i, manifestPath, seenSlotIds))
  }

  const seenCommandNames = new Set<string>()
  const commands: ManifestCommand[] = []
  const commandsRaw = (obj.commands ?? []) as unknown[]
  for (let i = 0; i < commandsRaw.length; i++) {
    commands.push(parseCommand(commandsRaw[i], i, manifestPath, seenCommandNames))
  }

  // Optional `setup` lifecycle handler. Module-only: setup must return
  // structured data the host acts on synchronously (binary provisioning),
  // so a subprocess JSON round-trip isn't wired.
  let setup: ManifestHandlerEntry | undefined
  if (obj.setup != null) {
    setup = parseHandlerEntry(obj.setup, "setup", manifestPath)
    if (setup.type !== "module") {
      err("setup handler must be type 'module' (subprocess setup is not supported)")
    }
  }

  // No "at least one contribution" gate here. PROMPT.md is implicit:
  // looked up by the loader on disk, and the manifest doesn't get to
  // see the filesystem. If a manifest declares zero contribution fields
  // AND ships no PROMPT.md, the loader logs a warning at load time.
  // The validator's job is purely syntactic shape checking.

  return {
    id,
    name: obj.name as string,
    version: obj.version as string,
    description: obj.description as string,
    prompt: typeof obj.prompt === "string" ? obj.prompt : undefined,
    setup,
    promptFragments,
    tuis,
    modes,
    events,
    hooks,
    liveAreaSlots,
    commands,
    permissions: (obj.permissions as string[] | undefined) ?? [],
    requiresUnsafeHooks: obj.requiresUnsafeHooks === true ? true : undefined,
    enabled: obj.enabled === false ? false : undefined,
  }
}

/**
 * Validate a single `commands[i]` entry.
 *
 * Names are lowercase ids, unique within the package (cross-plugin
 * uniqueness is enforced later by the loader, first-wins). Handlers must
 * be `module` type for now — a command returns a structured result the
 * host acts on synchronously, and subprocess JSON round-tripping isn't
 * wired yet.
 */
function parseCommand(
  raw: unknown,
  index: number,
  manifestPath: string,
  seenNames: Set<string>,
): ManifestCommand {
  const at = `commands[${index}]`
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("command must be an object")
  const obj = raw as Record<string, unknown>

  const name = requireString(obj, "name", err)
  if (!ID_RE.test(name)) err(`command name must match ${ID_RE} (got: ${JSON.stringify(name)})`)
  if (seenNames.has(name)) err(`duplicate command name: ${name}`)
  seenNames.add(name)

  const summary = requireString(obj, "summary", err)

  let argHint: string | undefined
  if (obj.argHint != null) {
    if (typeof obj.argHint !== "string") err("argHint must be a string if present")
    argHint = obj.argHint as string
  }

  const handler = parseHandlerEntry(obj.handler, at, manifestPath)
  if (handler.type !== "module") {
    err('command handler must be type "module" (subprocess commands are not supported yet)')
  }

  return argHint != null ? { name, summary, argHint, handler } : { name, summary, handler }
}

/**
 * Validate a single `liveAreaSlots[i]` entry.
 */
function parseLiveAreaSlot(
  raw: unknown,
  index: number,
  manifestPath: string,
  seenIds: Set<string>,
): ManifestLiveAreaSlot {
  const at = `liveAreaSlots[${index}]`
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("live-area slot must be an object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`live-area slot id must match ${ID_RE}`)
  if (seenIds.has(id)) err(`duplicate live-area slot id: ${id}`)
  seenIds.add(id)

  const handler = parseHandlerEntry(obj.handler, at, manifestPath)

  let position: "header" | "footer" | undefined
  if (obj.position != null) {
    if (obj.position !== "header" && obj.position !== "footer") {
      err(`position must be "header" or "footer" (got: ${JSON.stringify(obj.position)})`)
    }
    position = obj.position as "header" | "footer"
  }

  let refreshMs: number | undefined
  if (obj.refreshMs != null) {
    if (typeof obj.refreshMs !== "number" || !Number.isFinite(obj.refreshMs) || obj.refreshMs < 0) {
      err(`refreshMs must be a non-negative number (got: ${JSON.stringify(obj.refreshMs)})`)
    }
    refreshMs = obj.refreshMs as number
  }

  let timeoutMs: number | undefined
  if (obj.timeoutMs != null) {
    if (typeof obj.timeoutMs !== "number" || !Number.isFinite(obj.timeoutMs) || obj.timeoutMs < 0) {
      err(`timeoutMs must be a non-negative number (got: ${JSON.stringify(obj.timeoutMs)})`)
    }
    timeoutMs = obj.timeoutMs as number
  }

  let placeholder: string | undefined
  if (obj.placeholder != null) {
    if (typeof obj.placeholder !== "string") {
      err(`placeholder must be a string (got: ${JSON.stringify(obj.placeholder)})`)
    }
    placeholder = obj.placeholder as string
  }

  let refreshOn: string[] | undefined
  if (obj.refreshOn != null) {
    if (!Array.isArray(obj.refreshOn)) err("refreshOn must be an array of event names if present")
    const seen = new Set<string>()
    refreshOn = []
    for (let i = 0; i < (obj.refreshOn as unknown[]).length; i++) {
      const e = (obj.refreshOn as unknown[])[i]
      if (typeof e !== "string" || e.length === 0) {
        err(`refreshOn[${i}] must be a non-empty string event name`)
      }
      const name = e as string
      if (/\s/.test(name)) {
        err(`refreshOn[${i}] must not contain whitespace (got: ${JSON.stringify(name)})`)
      }
      if (seen.has(name)) {
        err(`refreshOn[${i}] duplicate event name: ${JSON.stringify(name)}`)
      }
      seen.add(name)
      refreshOn.push(name)
    }
  }

  for (const k of Object.keys(obj)) {
    if (
      !["id", "handler", "position", "refreshMs", "timeoutMs", "placeholder", "refreshOn"].includes(
        k,
      )
    ) {
      err(`unknown live-area slot key: ${JSON.stringify(k)}`)
    }
  }

  return { id, handler, position, refreshMs, timeoutMs, placeholder, refreshOn }
}

/**
 * Validate a single `promptFragments[i]` entry.
 */
function parsePromptFragment(
  raw: unknown,
  index: number,
  manifestPath: string,
  seenIds: Set<string>,
): ManifestPromptFragment {
  const at = `promptFragments[${index}]`
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("prompt fragment must be an object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`prompt fragment id must match ${ID_RE}`)
  if (seenIds.has(id)) err(`duplicate prompt fragment id: ${id}`)
  seenIds.add(id)

  const handler = parseHandlerEntry(obj.handler, at, manifestPath)

  let timeoutMs: number | undefined
  if (obj.timeoutMs != null) {
    if (typeof obj.timeoutMs !== "number" || !Number.isFinite(obj.timeoutMs) || obj.timeoutMs < 0) {
      err(`timeoutMs must be a non-negative number (got: ${JSON.stringify(obj.timeoutMs)})`)
    }
    timeoutMs = obj.timeoutMs as number
  }

  let order: number | undefined
  if (obj.order != null) {
    if (typeof obj.order !== "number" || !Number.isFinite(obj.order)) {
      err(`order must be a finite number (got: ${JSON.stringify(obj.order)})`)
    }
    order = obj.order as number
  }

  for (const k of Object.keys(obj)) {
    if (!["id", "handler", "timeoutMs", "order"].includes(k)) {
      err(`unknown prompt fragment key: ${JSON.stringify(k)}`)
    }
  }

  return { id, handler, timeoutMs, order }
}

/**
 * Validate a single `hooks[i]` entry.
 */
function parseHookSub(
  raw: unknown,
  index: number,
  manifestPath: string,
  seenIds: Set<string>,
): ManifestHookSubscription {
  const at = `hooks[${index}]`
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("hook subscription must be an object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`hook subscription id must match ${ID_RE}`)
  if (seenIds.has(id)) err(`duplicate hook subscription id: ${id}`)
  seenIds.add(id)

  const channel = requireString(obj, "channel", err)
  if (/\s/.test(channel)) {
    err(`channel must not contain whitespace (got: ${JSON.stringify(channel)})`)
  }

  const handler = parseHandlerEntry(obj.handler, at, manifestPath)

  let priority: number | undefined
  if (obj.priority != null) {
    if (typeof obj.priority !== "number" || !Number.isFinite(obj.priority)) {
      err(`priority must be a finite number if present (got: ${JSON.stringify(obj.priority)})`)
    }
    priority = obj.priority as number
  }

  let observeOnly: boolean | undefined
  if (obj.observeOnly != null) {
    if (typeof obj.observeOnly !== "boolean") err("observeOnly must be a boolean if present")
    observeOnly = obj.observeOnly as boolean
  }

  let timeoutMs: number | undefined
  if (obj.timeoutMs != null) {
    if (typeof obj.timeoutMs !== "number" || !Number.isFinite(obj.timeoutMs) || obj.timeoutMs < 0) {
      err(`timeoutMs must be a non-negative number (got: ${JSON.stringify(obj.timeoutMs)})`)
    }
    timeoutMs = obj.timeoutMs as number
  }

  for (const k of Object.keys(obj)) {
    if (!["id", "channel", "handler", "priority", "observeOnly", "timeoutMs"].includes(k)) {
      err(`unknown hook subscription key: ${JSON.stringify(k)}`)
    }
  }

  return { id, channel, handler, priority, observeOnly, timeoutMs }
}

/**
 * Validate a single `events[i]` entry. The handler entry shape is shared
 * with `tuis[i].handler` — we reuse {@link parseHandlerEntry} so subprocess
 * vs. module rules stay in sync.
 */
function parseEventSub(
  raw: unknown,
  index: number,
  manifestPath: string,
  seenIds: Set<string>,
): ManifestEventSubscription {
  const at = `events[${index}]`
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("event subscription must be an object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`event subscription id must match ${ID_RE}`)
  if (seenIds.has(id)) err(`duplicate event subscription id: ${id}`)
  seenIds.add(id)

  const on = requireString(obj, "on", err)
  // Event names are dot-separated lowercase words (`prompt.input.changed`).
  // We accept anything non-empty without spaces so plugin authors can
  // namespace freely; collisions across plugins are deliberate (plugins
  // listening to the same event is the common case).
  if (/\s/.test(on)) err(`event name must not contain whitespace (got: ${JSON.stringify(on)})`)

  const handler = parseHandlerEntry(obj.handler, at, manifestPath)

  let coalesce: boolean | undefined
  if (obj.coalesce != null) {
    if (typeof obj.coalesce !== "boolean") err("coalesce must be a boolean if present")
    coalesce = obj.coalesce as boolean
  }

  let throttleMs: number | undefined
  if (obj.throttleMs != null) {
    if (
      typeof obj.throttleMs !== "number" ||
      !Number.isFinite(obj.throttleMs) ||
      obj.throttleMs < 0
    ) {
      err(`throttleMs must be a non-negative number (got: ${JSON.stringify(obj.throttleMs)})`)
    }
    throttleMs = obj.throttleMs as number
  }

  for (const k of Object.keys(obj)) {
    if (!["id", "on", "handler", "coalesce", "throttleMs"].includes(k)) {
      err(`unknown event subscription key: ${JSON.stringify(k)}`)
    }
  }

  return { id, on, handler, coalesce, throttleMs }
}

const VALID_MODE_COLORS = new Set([
  "cyan",
  "blue",
  "magenta",
  "yellow",
  "green",
  "red",
  "pink",
  "purple",
  "orange",
  "sky",
  "lime",
  "gold",
])

function parseMode(
  raw: unknown,
  index: number,
  manifestPath: string,
  seenIds: Set<string>,
): ManifestMode {
  const at = `modes[${index}]`
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("mode must be an object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`mode id must match ${ID_RE} (got: ${JSON.stringify(id)})`)
  if (seenIds.has(id)) err(`duplicate mode id: ${id}`)
  seenIds.add(id)

  if (obj.label != null && typeof obj.label !== "string") {
    err("label must be a string if present")
  }
  if (obj.color != null) {
    if (typeof obj.color !== "string" || !VALID_MODE_COLORS.has(obj.color)) {
      err(
        `color must be one of ${[...VALID_MODE_COLORS].join(", ")} (got: ${JSON.stringify(obj.color)})`,
      )
    }
  }
  if (obj.statusLabel != null && typeof obj.statusLabel !== "string") {
    err("statusLabel must be a string if present")
  }
  if (obj.systemPromptAppend != null && typeof obj.systemPromptAppend !== "string") {
    err("systemPromptAppend must be a string if present")
  }
  if (obj.disallowedTools != null) {
    if (!Array.isArray(obj.disallowedTools)) err("disallowedTools must be an array")
    for (const t of obj.disallowedTools as unknown[]) {
      if (typeof t !== "string" || !t) err("disallowedTools entries must be non-empty strings")
    }
  }
  if (obj.default != null && typeof obj.default !== "boolean") {
    err("default must be a boolean if present")
  }
  if (obj.editorShowHidden != null && typeof obj.editorShowHidden !== "boolean") {
    err("editorShowHidden must be a boolean if present")
  }
  if (obj.refusalHint != null && typeof obj.refusalHint !== "string") {
    err("refusalHint must be a string if present")
  }

  let style: ModeStyleRequest | undefined
  if (obj.style != null) {
    style = parseModeStyle(obj.style, `${at}.style`, manifestPath)
  }
  if (style && obj.color != null) {
    // Both forms present. Style wins; warn so the author can tidy up.
    // Route through the diagnostic bus so the message gets the gold ⚠
    // chrome in scrollback and lands in the file log alongside every
    // other plugin warning.
    diag.warn(
      "plugin.manifest",
      `${manifestPath}: mode "${id}" declares both \`color\` and \`style\`; ` +
        `\`style\` takes precedence and \`color\` will be ignored.`,
    )
  }

  return {
    id,
    label: obj.label as string | undefined,
    color: obj.color as string | undefined,
    statusLabel: obj.statusLabel as string | undefined,
    systemPromptAppend: obj.systemPromptAppend as string | undefined,
    disallowedTools: obj.disallowedTools as string[] | undefined,
    refusalHint: obj.refusalHint as string | undefined,
    default: obj.default as boolean | undefined,
    editorShowHidden: obj.editorShowHidden as boolean | undefined,
    style,
  }
}

// ---------------------------------------------------------------------------
// Style request validation
// ---------------------------------------------------------------------------

const VALID_THEMES: ReadonlySet<ThemeKey> = new Set<ThemeKey>(["dark", "light", "high-contrast"])
const VALID_SURFACES = new Set(["label", "arrow", "status"])
/**
 * Semantic tokens recognized by the resolver. Plugins reference these by
 * name; the agent owns the concrete per-theme palette in `mode-style.ts`.
 * Kept here purely for validation.
 */
const VALID_SEMANTIC_TOKENS = new Set(["accent", "accent-soft", "danger", "muted"])
const HEX_RE = /^#[0-9a-fA-F]{6}$/

function parseModeStyle(raw: unknown, at: string, manifestPath: string): ModeStyleRequest {
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("style must be an object")
  const obj = raw as Record<string, unknown>

  const out: ModeStyleRequest = {}

  for (const surface of ["label", "arrow", "status"] as const) {
    if (obj[surface] != null) {
      out[surface] = parseSurfaceStyle(obj[surface], `${at}.${surface}`, manifestPath)
    }
  }

  if (obj.theme != null) {
    if (!isObject(obj.theme)) err("theme must be an object if present")
    const themeRaw = obj.theme as Record<string, unknown>
    const themeOut: Partial<Record<ThemeKey, ModeStyleRequest>> = {}
    for (const k of Object.keys(themeRaw)) {
      if (!VALID_THEMES.has(k as ThemeKey)) {
        err(
          `theme key must be one of ${[...VALID_THEMES].join(", ")} ` +
            `(got: ${JSON.stringify(k)})`,
        )
      }
      themeOut[k as ThemeKey] = parseModeStyle(themeRaw[k], `${at}.theme.${k}`, manifestPath)
    }
    out.theme = themeOut
  }

  // Reject unknown top-level keys so typos surface early.
  for (const k of Object.keys(obj)) {
    if (!VALID_SURFACES.has(k) && k !== "theme") {
      err(`unknown style key: ${JSON.stringify(k)} (allowed: label, arrow, status, theme)`)
    }
  }

  return out
}

function parseSurfaceStyle(raw: unknown, at: string, manifestPath: string): SurfaceStyleRequest {
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("surface style must be an object")
  const obj = raw as Record<string, unknown>

  const out: SurfaceStyleRequest = {}
  if (obj.fg != null) out.fg = parseColorRequest(obj.fg, `${at}.fg`, manifestPath)
  if (obj.bg != null) out.bg = parseColorRequest(obj.bg, `${at}.bg`, manifestPath)
  if (obj.bold != null) {
    if (typeof obj.bold !== "boolean") err("bold must be a boolean")
    out.bold = obj.bold as boolean
  }
  if (obj.dim != null) {
    if (typeof obj.dim !== "boolean") err("dim must be a boolean")
    out.dim = obj.dim as boolean
  }

  for (const k of Object.keys(obj)) {
    if (!["fg", "bg", "bold", "dim"].includes(k)) {
      err(`unknown surface key: ${JSON.stringify(k)} (allowed: fg, bg, bold, dim)`)
    }
  }

  return out
}

function parseColorRequest(raw: unknown, at: string, manifestPath: string): ColorRequest {
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }

  if (typeof raw === "string") {
    if (raw.includes("\x1b") || raw.includes("\\x1b") || raw.includes("\\e")) {
      err("raw ANSI escape strings are not allowed; use a token, legacy name, or #rrggbb")
    }
    if (raw === "transparent") return raw
    if (VALID_SEMANTIC_TOKENS.has(raw)) return raw
    if (VALID_MODE_COLORS.has(raw)) return raw
    if (HEX_RE.test(raw)) return raw
    err(
      `color string must be "transparent", a semantic token (` +
        [...VALID_SEMANTIC_TOKENS].join(", ") +
        `), a legacy color (` +
        [...VALID_MODE_COLORS].join(", ") +
        `), or "#rrggbb" (got: ${JSON.stringify(raw)})`,
    )
  }

  if (isObject(raw)) {
    const obj = raw as Record<string, unknown>
    const out: { token?: string; hex?: string; ansi256?: number } = {}
    if (obj.token != null) {
      if (typeof obj.token !== "string") err("token must be a string")
      const tok = obj.token as string
      if (!VALID_SEMANTIC_TOKENS.has(tok) && !VALID_MODE_COLORS.has(tok)) {
        err(`token ${JSON.stringify(tok)} is not a known semantic or legacy color`)
      }
      out.token = tok
    }
    if (obj.hex != null) {
      if (typeof obj.hex !== "string" || !HEX_RE.test(obj.hex)) {
        err(`hex must be a "#rrggbb" string (got: ${JSON.stringify(obj.hex)})`)
      }
      out.hex = obj.hex as string
    }
    if (obj.ansi256 != null) {
      if (
        typeof obj.ansi256 !== "number" ||
        !Number.isInteger(obj.ansi256) ||
        obj.ansi256 < 0 ||
        obj.ansi256 > 255
      ) {
        err(`ansi256 must be an integer in [0, 255] (got: ${JSON.stringify(obj.ansi256)})`)
      }
      out.ansi256 = obj.ansi256 as number
    }
    if (out.token == null && out.hex == null && out.ansi256 == null) {
      err("color object must specify at least one of: token, hex, ansi256")
    }
    for (const k of Object.keys(obj)) {
      if (!["token", "hex", "ansi256"].includes(k)) {
        err(`unknown color key: ${JSON.stringify(k)} (allowed: token, hex, ansi256)`)
      }
    }
    return out
  }

  err("color must be a string or an object")
  // unreachable
  return "transparent"
}

function parseHandler(
  raw: unknown,
  index: number,
  manifestPath: string,
  seenIds: Set<string>,
): ManifestHandler {
  const at = `tuis[${index}]`
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }

  if (!isObject(raw)) err("handler must be an object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`handler id must match ${ID_RE}`)
  if (seenIds.has(id)) err(`duplicate handler id: ${id}`)
  seenIds.add(id)

  if (typeof obj.interactive !== "boolean") {
    err("interactive must be a boolean")
  }

  const trigger = parseTrigger(obj.trigger, at, manifestPath)
  const handler = parseHandlerEntry(obj.handler, at, manifestPath)

  // Optional cosmetic fields. Only meaningful for tool triggers; tolerated
  // (but ignored at render time) for inline_tag triggers — the loader
  // forwards them anyway, and the agent only wires them for tool tools.
  let icon: string | undefined
  let color: string | undefined
  if (obj.icon != null) {
    if (typeof obj.icon !== "string" || obj.icon.length === 0) {
      err("icon must be a non-empty string")
    }
    icon = obj.icon as string
  }
  if (obj.color != null) {
    if (typeof obj.color !== "string" || obj.color.length === 0) {
      err("color must be a non-empty string")
    }
    color = obj.color as string
  }

  return {
    id,
    trigger,
    handler,
    interactive: obj.interactive as boolean,
    ...(icon ? { icon } : {}),
    ...(color ? { color } : {}),
  }
}

function parseTrigger(raw: unknown, at: string, manifestPath: string): ManifestTrigger {
  const err = (msg: string) => {
    throw new ManifestError(`${at}.trigger: ${msg}`, manifestPath)
  }

  if (!isObject(raw)) err("trigger must be an object")
  const obj = raw as Record<string, unknown>

  if (obj.type === "tool") {
    if (!isObject(obj.tool)) err("tool must be an object")
    const tool = obj.tool as Record<string, unknown>
    if (typeof tool.name !== "string" || !tool.name) err("tool.name is required")
    if (typeof tool.description !== "string") err("tool.description is required")
    if (!isObject(tool.input_schema)) err("tool.input_schema must be an object")

    // Optional aliases: array of alternate names this tool also responds
    // to. Validated locally here (shape, dup, self-collision); cross-
    // plugin collisions (alias vs another tool's canonical or alias, or
    // alias vs core tool name) are enforced in the loader at load time.
    let aliases: string[] | undefined
    if (tool.aliases != null) {
      if (!Array.isArray(tool.aliases)) err("tool.aliases must be an array of strings")
      const arr = tool.aliases as unknown[]
      const seen = new Set<string>()
      const out: string[] = []
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i]
        if (typeof a !== "string" || a.length === 0) {
          err(`tool.aliases[${i}] must be a non-empty string`)
        }
        const aStr = a as string
        if (aStr === tool.name) {
          err(`tool.aliases[${i}] (${JSON.stringify(aStr)}) duplicates tool.name`)
        }
        if (seen.has(aStr)) {
          err(`tool.aliases[${i}] (${JSON.stringify(aStr)}) is duplicated`)
        }
        seen.add(aStr)
        out.push(aStr)
      }
      if (out.length > 0) aliases = out
    }

    return {
      type: "tool",
      tool: {
        name: tool.name as string,
        description: tool.description as string,
        input_schema: tool.input_schema as Record<string, unknown>,
        ...(aliases ? { aliases } : {}),
      },
    }
  }

  if (obj.type === "inline_tag") {
    if (typeof obj.tag !== "string") err("tag is required")
    if (!TAG_RE.test(obj.tag as string)) {
      err(`tag must match ${TAG_RE} (got: ${JSON.stringify(obj.tag)})`)
    }
    return { type: "inline_tag", tag: obj.tag as string }
  }

  err(`unknown trigger.type: ${JSON.stringify(obj.type)}`)
  // unreachable; the line above throws.
  throw new Error("unreachable")
}

function parseHandlerEntry(raw: unknown, at: string, manifestPath: string): ManifestHandlerEntry {
  const err = (msg: string) => {
    throw new ManifestError(`${at}.handler: ${msg}`, manifestPath)
  }

  if (!isObject(raw)) err("handler must be an object")
  const obj = raw as Record<string, unknown>

  if (obj.type === "module") {
    if (typeof obj.path !== "string" || !obj.path) err("path is required for module handler")
    if (obj.export != null && obj.export !== "default") {
      err(`only export="default" is supported (got: ${JSON.stringify(obj.export)})`)
    }
    return { type: "module", path: obj.path as string, export: "default" }
  }

  if (obj.type === "subprocess") {
    if (!Array.isArray(obj.command) || obj.command.length === 0) {
      err("command must be a non-empty array for subprocess handler")
    }
    for (const c of obj.command as unknown[]) {
      if (typeof c !== "string") err("command entries must be strings")
    }
    return { type: "subprocess", command: obj.command as string[] }
  }

  err(`unknown handler.type: ${JSON.stringify(obj.type)}`)
  throw new Error("unreachable")
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  err: (msg: string) => void,
): string {
  if (typeof obj[key] !== "string" || !obj[key]) {
    err(`${key} is required and must be a non-empty string`)
  }
  return obj[key] as string
}
