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

import { KNOWN_PLATFORMS } from "../../plugin-api/src/utils/platform.ts"
import { Severity } from "../bus/diagnostic-bus.ts"
import { processDiagnostics } from "../diagnostics/hub.ts"
import { emitTyped } from "../diagnostics/typed.ts"

import { type CapabilityToken, isCapabilityToken, KNOWN_CAPABILITIES } from "./host/capabilities.ts"
import { type CliWarn, parseCli } from "./manifest-cli.ts"
import { parseErrorRenderers } from "./manifest-error-renderer.ts"
import { isObject, ManifestError, parseHandlerEntry, requireString } from "./manifest-helpers.ts"
import { parseHostMode } from "./manifest-host-mode.ts"
import { parseSidebandCodec, parseSidebandKinds } from "./manifest-sideband.ts"
import { parseSyntheticText } from "./manifest-synthetic-text.ts"
import type {
  ColorRequest,
  ManifestCommand,
  ManifestEventSubscription,
  ManifestFile,
  ManifestHandler,
  ManifestHandlerEntry,
  ManifestHookSubscription,
  ManifestHostMode,
  ManifestMode,
  ManifestPromptFragment,
  ManifestTrigger,
  ModeStyleRequest,
  SurfaceStyleRequest,
  ThemeKey,
} from "./types.ts"

// Re-exported for existing importers (`manifest.ts` used to define this
// directly). Thrown by {@link parseManifest} when the input does not
// conform; see `manifest-helpers.ts` for why the class itself moved.
export { ManifestError }

/**
 * A package tried to claim a RESERVED plugin id.
 *
 * This is the ONE manifest error the loader does not skip. Discovery catches
 * {@link ManifestError} and continues to the next package, but it rethrows
 * this subclass so `PluginLoader.load` rejects and the process fails to
 * start. A reserved id would make the user config ambiguous, and a silently
 * skipped package would leave the user with a config key that does nothing.
 *
 * Currently reserved: `prompts`, because `plugins.prompts` in the user
 * config is the prompt-suppression setting (see
 * `./plugin-prompt-resolution.ts`).
 */
export class ReservedPluginIdError extends ManifestError {
  /** The reserved id the package tried to claim. */
  readonly reservedId: string
  constructor(message: string, manifestPath: string, reservedId: string) {
    super(message, manifestPath)
    this.name = "ReservedPluginIdError"
    this.reservedId = reservedId
  }
}

/** `required` is present and not a boolean (G11). Holds no text (D1). */
export class RequiredNotBooleanError extends ManifestError {
  readonly kind = "RequiredNotBooleanError"
  constructor(manifestPath: string) {
    super("", manifestPath)
    this.name = this.kind
  }
}

/** `provides` is present and not an array (G11). Holds no text (D1). */
export class ProvidesNotArrayError extends ManifestError {
  readonly kind = "ProvidesNotArrayError"
  constructor(manifestPath: string) {
    super("", manifestPath)
    this.name = this.kind
  }
}

/** A `provides` entry is not a non-empty string (G11). Holds no text (D1). */
export class ProvidesEntryInvalidError extends ManifestError {
  readonly kind = "ProvidesEntryInvalidError"
  /** Index of the bad entry. */
  readonly index: number
  constructor(manifestPath: string, index: number) {
    super("", manifestPath)
    this.name = this.kind
    this.index = index
  }
}

/** The manifest `embeddable` field is present and not a boolean. Carries no message text (R-API-13.5). */
export class EmbeddableNotBooleanError extends ManifestError {
  static readonly kind = "EmbeddableNotBooleanError"
  declare readonly kind: "EmbeddableNotBooleanError"
  constructor(manifestPath: string) {
    super("", manifestPath)
    this.name = new.target.kind
    Object.defineProperty(this, "kind", { value: new.target.kind, enumerable: true })
  }
}

/** Plugin ids core reserves for a user-config key. See {@link ReservedPluginIdError}. */
export const RESERVED_PLUGIN_IDS: readonly string[] = ["prompts"]

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/
const TAG_RE = /^[a-z0-9][a-z0-9_-]*$/

/** Top-level keys of a flat (pre-S31) manifest. Rejected since S41. */
const FLAT_MANIFEST_KEYS: readonly string[] = [
  "tuis",
  "tools",
  "modes",
  "events",
  "hooks",
  "promptFragments",
  "commands",
  "hostModes",
  "setup",
  "replayRenderers",
  "turnAttachments",
  "liveAreaSlots",
]

/** Tool presentation fields. Rejected on a tool entry since S41. */
const COSMETIC_TOOL_FIELDS: readonly string[] = ["icon", "color", "headerKey"]

/** Options for {@link parseManifest}. */
export interface ParseManifestOptions {
  /**
   * Sink for non-fatal warnings (for example a mode with both `color` and
   * `style`). The loader passes its diagnostics. Default: the process
   * diagnostics handle.
   */
  warn?: CliWarn
}

/**
 * Validate a parsed JSON object against the manifest schema.
 *
 * The identity fields sit at the top level. Core validates the `headless`
 * block and ignores the `ui` block (S31). A flat (pre-S31) manifest, or a
 * tool entry with `icon`, `color`, or `headerKey`, is rejected (S41).
 *
 * This does NOT read the file. Callers are responsible for reading and
 * JSON.parse-ing the file; this function takes the raw value and returns a
 * typed, validated `ManifestFile`.
 *
 * @param raw - Parsed JSON from `manifest.json`.
 * @param manifestPath - Absolute path for error reporting. Does not need to
 *   exist on disk.
 * @param options - Where non-fatal warnings go. See {@link ParseManifestOptions}.
 * @throws {@link ManifestError} on any validation failure.
 */
export function parseManifest(
  raw: unknown,
  manifestPath: string,
  options: ParseManifestOptions = {},
): ManifestFile {
  const warn: CliWarn =
    options.warn ??
    ((msg, attrs) =>
      attrs
        ? emitTyped(processDiagnostics(), Severity.Warning, "plugin.manifest", msg, attrs)
        : processDiagnostics().warn("plugin.manifest", msg))
  const err = (msg: string) => {
    throw new ManifestError(msg, manifestPath)
  }

  if (!isObject(raw)) err("manifest must be a JSON object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`id must match ${ID_RE} (got: ${JSON.stringify(id)})`)
  // FATAL, not skipped: `plugins.prompts` in the user config is the
  // prompt-suppression setting, so a package named `prompts` would make that
  // key ambiguous. Discovery rethrows this subclass (see discovery.ts).
  if (RESERVED_PLUGIN_IDS.includes(id)) {
    throw new ReservedPluginIdError(
      `id ${JSON.stringify(id)} is reserved for the \`plugins.prompts\` config key ` +
        "(prompt-suppression settings). Rename the package, for example " +
        `"${id}-extra" or "my-${id}".`,
      manifestPath,
      id,
    )
  }

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

  // The headless and ui blocks (S31). A flat (pre-S31) manifest is
  // rejected since S41: its contribution keys sit at the top level.
  const flatKeys = FLAT_MANIFEST_KEYS.filter((k) => obj[k] !== undefined)
  if (flatKeys.length > 0) {
    err(
      `flat manifest keys are not supported since S41: ${flatKeys.join(", ")}. ` +
        "Move contributions into the headless block (tuis become headless.tools) " +
        "and liveAreaSlots into the ui block",
    )
  }
  const headlessRaw = obj.headless ?? {}
  if (!isObject(headlessRaw)) err("headless must be an object if present")
  if (obj.ui !== undefined && !isObject(obj.ui)) err("ui must be an object if present")
  const h = headlessRaw as Record<string, unknown>

  // Every contribution field is optional. The validator does NOT enforce
  // "at least one contribution" because PROMPT.md is implicit: a plugin
  // can ship just a PROMPT.md file with no manifest-declared
  // contributions, and that's a legitimate shape. The loader has
  // filesystem access and surfaces a warning if a plugin truly
  // contributes nothing (no declared fields AND no PROMPT.md on disk).
  for (const key of [
    "tools",
    "modes",
    "events",
    "hooks",
    "promptFragments",
    "commands",
    "hostModes",
  ]) {
    if (h[key] != null && !Array.isArray(h[key])) err(`headless.${key} must be an array if present`)
  }
  if (obj.permissions != null) {
    if (!Array.isArray(obj.permissions)) err("permissions must be an array if present")
    for (const p of obj.permissions as unknown[]) {
      if (typeof p !== "string" || p.length === 0) {
        err(`permissions entries must be non-empty strings (got: ${JSON.stringify(p)})`)
      }
    }
  }
  if (obj.capabilities != null) {
    if (!Array.isArray(obj.capabilities)) err("capabilities must be an array if present")
    const seenCaps = new Set<string>()
    for (const c of obj.capabilities as unknown[]) {
      if (typeof c !== "string" || !isCapabilityToken(c)) {
        err(
          `capabilities entries must be one of ${KNOWN_CAPABILITIES.join(", ")} ` +
            `(got: ${JSON.stringify(c)})`,
        )
      }
      if (seenCaps.has(c as string)) err(`duplicate capability: ${JSON.stringify(c)}`)
      seenCaps.add(c as string)
    }
  }
  const platforms = parsePlatforms(obj.platforms, "platforms", err)
  if (obj.requiresUnsafeHooks != null && typeof obj.requiresUnsafeHooks !== "boolean") {
    err("requiresUnsafeHooks must be a boolean if present")
  }
  if (obj.enabled != null && typeof obj.enabled !== "boolean") {
    err("enabled must be a boolean if present")
  }
  if (obj.required != null && typeof obj.required !== "boolean") {
    throw new RequiredNotBooleanError(manifestPath)
  }
  if (obj.provides != null) {
    if (!Array.isArray(obj.provides)) throw new ProvidesNotArrayError(manifestPath)
    const entries = obj.provides as unknown[]
    for (let i = 0; i < entries.length; i++) {
      const c = entries[i]
      if (typeof c !== "string" || c.length === 0) {
        throw new ProvidesEntryInvalidError(manifestPath, i)
      }
    }
  }
  if (obj.embeddable !== undefined && typeof obj.embeddable !== "boolean") {
    throw new EmbeddableNotBooleanError(manifestPath)
  }

  const seenHandlerIds = new Set<string>()
  const tools: ManifestHandler[] = []
  const toolsRaw = (h.tools ?? []) as unknown[]
  for (let i = 0; i < toolsRaw.length; i++) {
    tools.push(parseHandler(toolsRaw[i], i, manifestPath, seenHandlerIds))
  }

  const seenModeIds = new Set<string>()
  const modes: ManifestMode[] = []
  const modesRaw = (h.modes ?? []) as unknown[]
  for (let i = 0; i < modesRaw.length; i++) {
    modes.push(parseMode(modesRaw[i], i, manifestPath, seenModeIds, warn))
  }

  const seenEventIds = new Set<string>()
  const events: ManifestEventSubscription[] = []
  const eventsRaw = (h.events ?? []) as unknown[]
  for (let i = 0; i < eventsRaw.length; i++) {
    events.push(parseEventSub(eventsRaw[i], i, manifestPath, seenEventIds))
  }

  const seenHookIds = new Set<string>()
  const hooks: ManifestHookSubscription[] = []
  const hooksRaw = (h.hooks ?? []) as unknown[]
  for (let i = 0; i < hooksRaw.length; i++) {
    hooks.push(parseHookSub(hooksRaw[i], i, manifestPath, seenHookIds))
  }

  const seenFragIds = new Set<string>()
  const promptFragments: ManifestPromptFragment[] = []
  const fragsRaw = (h.promptFragments ?? []) as unknown[]
  for (let i = 0; i < fragsRaw.length; i++) {
    promptFragments.push(parsePromptFragment(fragsRaw[i], i, manifestPath, seenFragIds))
  }

  const seenCommandNames = new Set<string>()
  const commands: ManifestCommand[] = []
  const commandsRaw = (h.commands ?? []) as unknown[]
  for (let i = 0; i < commandsRaw.length; i++) {
    commands.push(parseCommand(commandsRaw[i], i, manifestPath, seenCommandNames))
  }

  const seenHostModeIds = new Set<string>()
  const hostModes: ManifestHostMode[] = []
  const hostModesRaw = (h.hostModes ?? []) as unknown[]
  for (let i = 0; i < hostModesRaw.length; i++) {
    hostModes.push(parseHostMode(hostModesRaw[i], i, manifestPath, seenHostModeIds, warn))
  }

  // Optional top-level `cli` block (SPEC-HELP Q-5, R-21). A bad block is
  // dropped with a warning. It never throws, so the plugin still loads.
  const cli = parseCli(obj.cli, manifestPath, warn)
  const sideband = parseSidebandKinds(obj.sideband, err, warn, manifestPath)
  const sidebandCodec = parseSidebandCodec(obj.sidebandCodec, err)
  const errorRenderers = parseErrorRenderers(obj.errorRenderers, warn, manifestPath)
  const syntheticText = parseSyntheticText(obj.syntheticText, warn)

  // Optional `setup` lifecycle handler. Module-only: setup must return
  // structured data the host acts on synchronously (binary provisioning),
  // so a subprocess JSON round-trip isn't wired.
  let setup: ManifestHandlerEntry | undefined
  if (h.setup != null) {
    setup = parseHandlerEntry(h.setup, "headless.setup", manifestPath)
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
    tools,
    modes,
    events,
    hooks,
    commands,
    hostModes,
    permissions: (obj.permissions as string[] | undefined) ?? [],
    capabilities: (obj.capabilities as CapabilityToken[] | undefined) ?? [],
    platforms,
    requiresUnsafeHooks: obj.requiresUnsafeHooks === true ? true : undefined,
    enabled: obj.enabled === false ? false : undefined,
    ...(obj.required === true ? { required: true } : {}),
    ...(Array.isArray(obj.provides) && obj.provides.length > 0
      ? { provides: [...(obj.provides as string[])] }
      : {}),
    embeddable: obj.embeddable as boolean | undefined,
    declaresUi: obj.ui !== undefined ? true : undefined,
    ...(cli ? { cli } : {}),
    ...(sideband ? { sideband } : {}),
    ...(sidebandCodec ? { sidebandCodec } : {}),
    ...(errorRenderers ? { errorRenderers } : {}),
    ...(syntheticText ? { syntheticText } : {}),
  }
}

/**
 * Validate an optional `platforms` whitelist (used at both the plugin
 * level and the per-handler level). Returns the normalized string array
 * when present, or `undefined` when absent (meaning "all platforms").
 *
 * Each entry must be one of {@link KNOWN_PLATFORMS} (`macos`, `linux`,
 * `windows`). Aliases (`darwin`, `unix`, `win32`, …) are deliberately NOT
 * accepted in a manifest: authors write the canonical bucket; aliases are
 * only forgiven in the user-facing env/CLI override. Duplicates are
 * rejected. An empty array is treated as `undefined` (all platforms).
 */
function parsePlatforms(
  raw: unknown,
  at: string,
  err: (msg: string) => void,
): string[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) {
    err(`${at} must be an array of platform names if present`)
  }
  const arr = raw as unknown[]
  if (arr.length === 0) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    if (typeof v !== "string" || v.length === 0) {
      err(`${at}[${i}] must be a non-empty string`)
    }
    const s = v as string
    if (!(KNOWN_PLATFORMS as readonly string[]).includes(s)) {
      err(`${at}[${i}] must be one of ${KNOWN_PLATFORMS.join(", ")} (got: ${JSON.stringify(s)})`)
    }
    if (seen.has(s)) err(`${at}[${i}] duplicate platform: ${JSON.stringify(s)}`)
    seen.add(s)
    out.push(s)
  }
  return out
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

  let placement: ManifestPromptFragment["placement"] | undefined
  if (obj.placement != null) {
    if (obj.placement !== "sessionContext" && obj.placement !== "afterInstructions") {
      err(
        `placement must be "sessionContext" or "afterInstructions" (got: ${JSON.stringify(obj.placement)})`,
      )
    }
    placement = obj.placement as ManifestPromptFragment["placement"]
  }

  for (const k of Object.keys(obj)) {
    if (!["id", "handler", "timeoutMs", "order", "placement"].includes(k)) {
      err(`unknown prompt fragment key: ${JSON.stringify(k)}`)
    }
  }

  return { id, handler, timeoutMs, order, placement }
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

  let failClosed: boolean | undefined
  if (obj.failClosed != null) {
    if (typeof obj.failClosed !== "boolean") err("failClosed must be a boolean if present")
    failClosed = obj.failClosed as boolean
    if (failClosed && observeOnly) err("failClosed and observeOnly cannot both be true")
  }

  const keys = ["id", "channel", "handler", "priority", "observeOnly", "timeoutMs", "failClosed"]
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) err(`unknown hook subscription key: ${JSON.stringify(k)}`)
  }

  return {
    id,
    channel,
    handler,
    priority,
    observeOnly,
    timeoutMs,
    ...(failClosed !== undefined ? { failClosed } : {}),
  }
}

/**
 * Validate a single `events[i]` entry. The handler entry shape is shared
 * with `headless.tools[i].handler` — we reuse {@link parseHandlerEntry} so subprocess
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
  warn: CliWarn,
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
    // The loader passes its diagnostics, so the message lands in the file
    // log alongside every other plugin warning.
    warn(
      `${manifestPath}: mode "${id}" declares both \`color\` and \`style\`; ` +
        `\`style\` takes precedence and \`color\` will be ignored.`,
      { code: "mode_color_ignored", manifestPath, modeId: id },
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
 * name; the agent owns the concrete per-theme palette in `ui/style/mode.ts`.
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

/**
 * The ESC character, built from its code point. The validator only looks
 * for it, to reject raw ANSI in a plugin string. Core never writes it.
 */
const ESC_CHAR = String.fromCodePoint(0x1b)

function parseColorRequest(raw: unknown, at: string, manifestPath: string): ColorRequest {
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }

  if (typeof raw === "string") {
    if (raw.includes(ESC_CHAR) || raw.includes("\\x1b") || raw.includes("\\e")) {
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
  const at = `headless.tools[${index}]`
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

  // Tool presentation (icon, color, headerKey) is not a tool field since
  // S41: the terminal host keeps it (the CLI presentation map).
  const cosmetic = COSMETIC_TOOL_FIELDS.filter((k) => obj[k] !== undefined)
  if (cosmetic.length > 0) {
    err(
      `${cosmetic.join(", ")} ${cosmetic.length === 1 ? "is" : "are"} not tool fields ` +
        "since S41 (the terminal host keeps tool presentation); remove them",
    )
  }

  const platforms = parsePlatforms(obj.platforms, `${at}.platforms`, err)

  return {
    id,
    trigger,
    handler,
    interactive: obj.interactive as boolean,
    ...(platforms ? { platforms } : {}),
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

    if (typeof tool.mayReturnBinary !== "boolean" && tool.mayReturnBinary != null)
      err("tool.mayReturnBinary must be a boolean if present")

    return {
      type: "tool",
      tool: {
        name: tool.name as string,
        description: tool.description as string,
        input_schema: tool.input_schema as Record<string, unknown>,
        ...(typeof tool.explicitName === "boolean" ? { explicitName: tool.explicitName } : {}),
        ...(typeof tool.reason === "string" && tool.reason.length > 0
          ? { reason: tool.reason }
          : {}),
        ...(tool.mayReturnBinary ? { mayReturnBinary: true } : {}),
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

// `parseHandlerEntry`, `isObject`, and `requireString` moved to
// `manifest-helpers.ts` (imported above) so `manifest-host-mode.ts` can use
// them without importing this file back (which would cycle, since this
// file imports `parseHostMode` from there).
