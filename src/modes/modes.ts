/**
 * Operating-mode system.
 *
 * A "mode" is a lightweight UX state on top of the agent. When active, a mode
 * can:
 *
 * 1. Append a system-prompt fragment so the model behaves differently
 *    (e.g. ASK mode instructs the model to refuse Edit/Write tools and
 *    answer questions directly).
 * 2. Filter the tool list visible to the model. The disallowed tools are
 *    *literally not sent* to the API — the model never sees them.
 * 3. Re-skin the REPL prompt prefix (e.g. `ASK ❯ ` in blue).
 * 4. Re-skin the agent status spinner ("Asking..." instead of "Thinking...").
 *
 * Modes are mutually exclusive — at most one is active. Cycling
 * (Shift+Tab in the REPL) walks the list `[no-mode, mode-1, mode-2, ...]`.
 *
 * The {@link ModeManager} is the single source of truth for the active mode
 * within an agent process. It is shared between the {@link Agent} (which
 * reads the mode when assembling each request) and the REPL (which reads
 * the mode to render the prompt and status text).
 *
 * Spec / motivation: the agent project is moving toward "everything is a
 * plugin". Modes follow the same pattern — they are declared in
 * `manifest.json` files alongside `tuis`. See {@link ManifestMode}.
 *
 * @module modes
 */

import {
  clampLabel,
  detectStyleEnv,
  paint,
  type ResolvedModeStyle,
  type ResolvedSurfaceStyle,
  resolveModeStyle,
  type StyleEnv,
  styleFromLegacyColor,
} from "@minimal-agent/plugin-api/utils/mode-style"

import { c } from "../agent.ts"
import type { ContentBlock } from "../llm/messages.ts"
import type { ManifestMode, ModePermissions, ToolPermission } from "../plugins/types.ts"

/**
 * Resolved tool-permission rules for a mode.
 *
 * `tools` is an ordered list of {@link ToolPermission}. First-match wins.
 * An explicit `{ tool: "*", allow: true }` entry acts as the wildcard
 * allow-all. `source` records which layer the rules came from.
 */
export interface EffectiveModePermissions {
  tools: ToolPermission[]
  source: "manifest" | "user-config" | "default"
}

/**
 * One mode's user-config override.
 *
 *   plugins.<plugin-id>.modes.<mode-id>: ModeUserOverride
 */
export interface ModeUserOverride {
  permissions?: ModePermissions
}

/**
 * Convert a `ManifestMode` into a canonical `ToolPermission[]`, handling
 * the new `ToolPermission[]`, the old `ModePermissions`, and the legacy
 * `disallowedTools` sugar. Returns the default `[{ tool: "*", allow: true }]`
 * when nothing is set.
 */
function toolPermissionsFromMode(mode: ManifestMode): ToolPermission[] {
  // New-style: array of ToolPermission
  if (Array.isArray(mode.permissions) && mode.permissions.length > 0) {
    return [...mode.permissions]
  }
  // Old-style: ModePermissions object
  const mp = mode.permissions as ModePermissions | undefined
  if (
    mp &&
    typeof mp === "object" &&
    !Array.isArray(mp) &&
    (Array.isArray(mp.allow) || Array.isArray(mp.deny))
  ) {
    return modePermissionsToTools(mp)
  }
  // Back-compat: disallowedTools → deny rules
  if (mode.disallowedTools && mode.disallowedTools.length > 0) {
    return [
      { tool: "*", allow: true },
      ...mode.disallowedTools.map((t) => ({ tool: t, allow: false as const })),
    ]
  }
  return [{ tool: "*", allow: true }]
}

/**
 * Convert old {@link ModePermissions} into {@link ToolPermission}[].
 */
function modePermissionsToTools(mp: ModePermissions): ToolPermission[] {
  const tools: ToolPermission[] = []
  if (mp.allow && mp.allow.length > 0) {
    if (mp.allow.includes("*")) {
      tools.push({ tool: "*", allow: true })
    } else {
      for (const t of mp.allow) tools.push({ tool: t, allow: true })
    }
  } else if (!mp.deny || mp.deny.length === 0) {
    tools.push({ tool: "*", allow: true })
  }
  if (mp.deny && mp.deny.length > 0) {
    for (const t of mp.deny) tools.push({ tool: t, allow: false })
  }
  return tools
}

/**
 * Resolve effective tool permissions for a mode by overlaying user config
 * on top of the manifest, with hard defaults underneath.
 *
 * Resolution order (later wins, allow/deny resolve independently):
 *   1. defaults: `[{ tool: "*", allow: true }]`
 *   2. manifest: new `ToolPermission[]`, old `ModePermissions`, then back-compat `disallowedTools`
 *   3. user config: old `ModePermissions` shape, converted to `ToolPermission[]`
 *
 * Allow and deny resolve independently: a user override that sets only
 * `allow` inherits `deny` from the manifest (or default), and vice versa.
 */
export function buildEffectiveModePermissions(
  mode: ManifestMode,
  userOverride?: ModeUserOverride | null,
): EffectiveModePermissions {
  const hasPermissions =
    (Array.isArray(mode.permissions) && mode.permissions.length > 0) ||
    (mode.permissions as ModePermissions | undefined)?.allow != null ||
    (mode.permissions as ModePermissions | undefined)?.deny != null ||
    (mode.disallowedTools != null && mode.disallowedTools.length > 0)

  const manifestTools = hasPermissions
    ? toolPermissionsFromMode(mode)
    : [{ tool: "*", allow: true }]

  if (!userOverride?.permissions) {
    return { tools: manifestTools, source: hasPermissions ? "manifest" : "default" }
  }

  if (!userOverride?.permissions) {
    return { tools: manifestTools, source: "manifest" }
  }

  // User config: resolve allow and deny independently.
  const userAllow = userOverride.permissions.allow
  const userDeny = userOverride.permissions.deny
  const manifestAllowTools = manifestTools.filter((t) => t.allow === true)
  const manifestDenyTools = manifestTools.filter((t) => t.allow === false || t.allow === "match")

  let resultTools: ToolPermission[]

  if (userAllow != null && userDeny != null) {
    // Both set → user replaces entirely
    resultTools = modePermissionsToTools(userOverride.permissions)
  } else if (userAllow != null) {
    // Only allow set → user allow + manifest deny
    const userAllowTools = userAllow.includes("*")
      ? [{ tool: "*", allow: true }]
      : userAllow.map((t) => ({ tool: t, allow: true }))
    resultTools = [...userAllowTools, ...manifestDenyTools]
  } else if (userDeny != null) {
    // Only deny set → manifest allow + user deny
    const userDenyTools = userDeny.map((t) => ({ tool: t, allow: false }))
    resultTools = [...manifestAllowTools, ...userDenyTools]
  } else {
    resultTools = manifestTools
  }

  return { tools: resultTools, source: "user-config" }
}

/**
 * Evaluate a tool name against an effective permissions policy.
 *
 * First-match wins by rule priority: exact tool name rules are checked
 * BEFORE wildcard `"*"` rules. Within each group, rule order in
 * `perms.tools` determines priority.
 *
 *   - `allow: true` → allowed.
 *   - `allow: false` → denied.
 *   - `allow: "match"` → defer to `rule.predicate(input)`. No predicate = deny.
 *   - No matching rule → denied.
 */
export function isToolAllowedByPermissions(
  tool: string,
  perms: EffectiveModePermissions,
  input?: Record<string, unknown>,
): boolean {
  // Phase 1: exact tool name match (checked before wildcard)
  for (const rule of perms.tools) {
    if (rule.tool !== tool) continue
    if (rule.allow === true) return true
    if (rule.allow === false) return false
    if (rule.predicate) return rule.predicate(input ?? {})
    return false
  }
  // Phase 2: wildcard "*" fallback
  for (const rule of perms.tools) {
    if (rule.tool !== "*") continue
    if (rule.allow === true) return true
    if (rule.allow === false) return false
    if (rule.predicate) return rule.predicate(input ?? {})
    return false
  }
  return false
}

/**
 * Subscriber callback notified whenever the active mode changes.
 *
 * Receives the new active mode (or `null` when no mode is active). The
 * optional second argument carries richer metadata about the transition
 * (the prior mode and the timestamp the change took effect) for
 * subscribers that want to render a scrollback chip or audit-log entry.
 * Subscribers that only care about the new active mode can keep ignoring
 * the second arg.
 */
export type ModeChangeListener = (active: ManifestMode | null, event?: ModeChangeEvent) => void

/**
 * Payload for a single mode transition. Built inside {@link ModeManager.notify}
 * and handed to every subscriber that opts in to the second arg.
 *
 * - `from` / `to` carry the FULL {@link ManifestMode} (not just the id) so
 *   chip renderers can read `label`, `style`, etc. without a second
 *   lookup. `null` means "no mode active".
 * - `at` is the wall-clock time the change took effect (i.e. when the
 *   user pressed Shift+Tab or a programmatic `setMode` ran). Set from the
 *   manager's injected `now` clock, so tests can pin it to a fixed Date.
 */
export interface ModeChangeEvent {
  from: ManifestMode | null
  to: ManifestMode | null
  at: Date
}

/**
 * Payload for a {@link ModeManager.onDeliver} listener call. Fires
 * when {@link ModeManager.consumePendingAttachment} actually returns
 * a non-null block (= the model has been TOLD about the change), as
 * opposed to {@link ModeChangeEvent} which fires on any toggle.
 *
 * `fromId` is the id the model previously believed (`null` = default).
 * `toId` is the id the model now believes (`null` = default).
 * `at` is the wall-clock the underlying toggle took effect, mirroring
 * `<ma::agent::mode-change at="...">`.
 *
 * Delivery is the "model now knows" event. Listeners that paint a
 * scrollback chip or clear a "pending" decoration should subscribe
 * here, not to the toggle channel.
 */
export interface ModeDeliveryEvent {
  fromId: string | null
  toId: string | null
  at: Date
}

/**
 * Read-only view of the pending advertisement (current active mode vs
 * the last mode the model was told about). Returned by
 * {@link ModeManager.peekPendingAttachment} so renderers can display a
 * "will ship on send" decoration WITHOUT consuming the attachment.
 *
 * `null` when nothing is pending : either the model already knows the
 * active mode, or the user toggled back to the previously-advertised
 * state before sending (the classic ASK → default → ASK net-zero case).
 *
 * - `fromId` is the id the model currently believes is active (`null` =
 *   default / no mode).
 * - `toId` is the id the active mode will be after the next consume
 *   (`null` = default / no mode).
 */
export interface PendingModeAttachment {
  fromId: string | null
  toId: string | null
}

/**
 * Color helpers indexed by the manifest's `color` field.
 *
 * Falls back to {@link c.cyan} for unknown values. Kept in sync with
 * `VALID_MODE_COLORS` in `plugins/manifest.ts`.
 */
const COLOR_HELPERS: Record<string, (s: string) => string> = {
  cyan: c.cyan,
  blue: c.blue,
  magenta: c.magenta,
  yellow: c.yellow,
  green: c.green,
  red: c.red,
  pink: c.pink,
  purple: c.purple,
  orange: c.orange,
  sky: c.sky,
  lime: c.lime,
  gold: c.gold,
}

/** Default fallback when a mode declares no `statusLabel`. */
function defaultStatusLabel(mode: ManifestMode): string {
  if (mode.statusLabel) return mode.statusLabel
  // ASK -> "Asking", PLAN -> "Planning", etc. We just append "ing" if the
  // label looks verb-like; for arbitrary labels we punt to "Working".
  const label = (mode.label ?? mode.id).toLowerCase()
  if (label.endsWith("e")) return capitalize(label.slice(0, -1) + "ing")
  if (/^[a-z]+$/.test(label)) return capitalize(label + "ing")
  return "Working"
}

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s[0].toUpperCase() + s.slice(1)
}

/**
 * Mutable holder of the active mode plus the list of available modes.
 *
 * Construct once per agent process and share between the {@link Agent} and
 * the REPL. The agent reads {@link active} on each request to mutate the
 * outgoing system prompt and tool list. The REPL reads it to render the
 * prompt and status spinner.
 *
 * @example
 * ```ts
 * const mgr = new ModeManager(loader.getModes(), loader.getDefaultModeId());
 * mgr.subscribe((mode) => console.log("active:", mode?.id ?? "(none)"));
 * mgr.cycleNext(); // walks no-mode -> mode-1 -> mode-2 -> no-mode
 * ```
 */
export class ModeManager {
  private readonly modes: ManifestMode[]
  /** Index into {@link modes}, or -1 for "no mode". */
  private idx: number
  private readonly listeners = new Set<ModeChangeListener>()
  /**
   * Delivery listeners (model-now-knows side effects). See
   * {@link onDeliver}. Fires from inside `consumePendingAttachment`
   * AFTER `lastAdvertisedModeId` is updated.
   */
  private readonly deliveryListeners = new Set<(event: ModeDeliveryEvent) => void>()
  private readonly env: StyleEnv
  /** Resolved style cache, one entry per mode in {@link modes}. */
  private readonly resolvedCache: (ResolvedModeStyle | null)[]
  /**
   * Mode the model was last *told* about (via a `<mode-change>` attachment
   * consumed by {@link consumePendingAttachment}). May lag {@link active}
   * between a Shift+Tab toggle and the next outgoing user message. `null`
   * means "the model has not yet been told any mode" (= default / no mode).
   *
   * Only `consumePendingAttachment` updates this field. `cycleNext`,
   * `cyclePrev`, and `setMode` deliberately do NOT touch it — toggling
   * modes is free until the next user turn ships an attachment.
   */
  private lastAdvertisedModeId: string | null = null
  /**
   * Mode that was active immediately before the most recent change.
   * Captured by `setMode`, `cycleNext`, `cyclePrev`. Used to render
   * `<mode-change from="…" to="…" at="…" />` when the next user turn assembles.
   */
  private prevModeId: string | null = null
  /**
   * One-shot guard for the {@link systemPromptAddition} deprecation
   * warning. We emit it at most once per process so a tight tool loop
   * doesn't spam stderr.
   */
  private warnedSystemPromptAppend = false
  /**
   * Wall-clock source for {@link ModeChangeEvent.at}. Injected so tests
   * can pin the timestamp to a fixed Date without monkey-patching
   * `Date.now`. Defaults to `() => new Date()`.
   */
  private readonly now: () => Date
  /**
   * Last transition we built and handed to subscribers. Retained so
   * late-attaching subscribers can ask "what was the most recent change?"
   * without having to derive it from `prevModeId` themselves. `null`
   * when no toggle has happened in this process.
   */
  private lastEvent: ModeChangeEvent | null = null
  /**
   * Wall-clock the active mode was entered (set on every successful
   * transition, including initial-default). Exposed as
   * {@link activeSince} and stamped onto every tool_result envelope
   * via {@link buildActiveModeStamp}.
   *
   * `null` when no mode has ever been active in this process.
   */
  private activeSinceAt: Date | null = null
  /**
   * Per-mode user-config override lookup. Optional. Called on every
   * dispatch-time `isToolAllowed` (cheap, single dict lookup).
   *
   * Returning `null`/`undefined` means "no override; use the manifest".
   *
   * Injected so the manager doesn't depend on the config loader
   * directly (cyclic-import-free, test-friendly).
   */
  private readonly getOverride: (modeId: string) => ModeUserOverride | null
  /**
   * Cache of resolved effective permissions, keyed by manifest index.
   * Invalidated by {@link invalidatePermissions} when the user config
   * reloads (rare; the host calls this explicitly).
   */
  private permissionsCache: (EffectiveModePermissions | null)[]

  /**
   * Builds the manager and resolves the starting mode.
   *
   * @param modes - The list of available modes (in cycle order).
   * @param defaultModeId - Optional id of the mode to start in. When the id
   *   is unknown or omitted, the manager starts with no active mode.
   * @param env - Style resolver environment. Defaults to {@link detectStyleEnv}.
   * @param now - Wall-clock injection point for {@link ModeChangeEvent.at}.
   *   Defaults to `() => new Date()`. Tests use a fixed Date for byte-stable
   *   chip rendering.
   * @param getOverride - Per-mode user-config lookup. Defaults to a no-op
   *   that always returns `null`. Wire it to the host's config loader to
   *   honor `plugins.<plugin-id>.modes.<mode-id>.permissions` overrides.
   */
  constructor(
    modes: ManifestMode[],
    defaultModeId?: string | null,
    env?: StyleEnv,
    now?: () => Date,
    getOverride?: (modeId: string) => ModeUserOverride | null,
  ) {
    this.modes = [...modes]
    this.idx = -1
    this.env = env ?? detectStyleEnv()
    this.now = now ?? (() => new Date())
    this.getOverride = getOverride ?? (() => null)
    this.resolvedCache = this.modes.map((m) => {
      const req = m.style ?? styleFromLegacyColor(m.color)
      return req ? resolveModeStyle(req, this.env) : null
    })
    this.permissionsCache = this.modes.map(() => null)
    if (defaultModeId) {
      const i = this.modes.findIndex((m) => m.id === defaultModeId)
      if (i !== -1) {
        this.idx = i
        this.activeSinceAt = this.now()
      }
    }
  }

  /**
   * Drop the cached effective permissions for one mode (or all modes).
   * Call this after the user config reloads.
   *
   * @param modeId - Specific mode to invalidate, or `null` for all.
   */
  invalidatePermissions(modeId: string | null = null): void {
    if (modeId == null) {
      this.permissionsCache = this.modes.map(() => null)
      return
    }
    const i = this.modes.findIndex((m) => m.id === modeId)
    if (i !== -1) this.permissionsCache[i] = null
  }

  /**
   * Resolved effective permissions for a mode, building (and caching)
   * on first access. Returns `null` when the id is unknown.
   *
   * Cache key is the manifest index. Invalidate via
   * {@link invalidatePermissions} after a config reload.
   */
  effectivePermissions(modeId: string | null): EffectiveModePermissions | null {
    if (modeId == null) return null
    const i = this.modes.findIndex((m) => m.id === modeId)
    if (i === -1) return null
    const cached = this.permissionsCache[i]
    if (cached) return cached
    const built = buildEffectiveModePermissions(this.modes[i], this.getOverride(modeId))
    this.permissionsCache[i] = built
    return built
  }

  /**
   * Wall-clock when the currently active mode took effect. `null` when
   * no mode is (or has ever been) active in this process.
   *
   * Set in the constructor (if `defaultModeId` was provided) and on
   * every successful {@link setMode} / {@link cycleNext} / {@link cyclePrev}
   * transition that lands on a non-null mode. Cleared when the user
   * leaves a mode for "no mode active".
   */
  activeSince(): Date | null {
    return this.activeSinceAt
  }

  /** True if the manager has any modes available. */
  hasModes(): boolean {
    return this.modes.length > 0
  }

  /** Active mode, or `null` when none is selected. */
  active(): ManifestMode | null {
    return this.idx === -1 ? null : this.modes[this.idx]
  }

  /** All modes available to cycle through. */
  list(): ManifestMode[] {
    return [...this.modes]
  }

  /**
   * Subscribe to mode-change notifications. Returns an unsubscribe handle.
   * Listeners are invoked synchronously after a successful change.
   */
  subscribe(listener: ModeChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Set the active mode by id, or pass `null` to clear it.
   *
   * Returns `true` if the requested mode existed (or was `null`) and the
   * change took effect. An unknown id is a silent no-op returning `false`.
   */
  setMode(id: string | null): boolean {
    if (id === null) {
      if (this.idx === -1) return true
      this.prevModeId = this.activeId()
      this.idx = -1
      this.activeSinceAt = null
      this.notify()
      return true
    }
    const i = this.modes.findIndex((m) => m.id === id)
    if (i === -1) return false
    if (this.idx === i) return true
    this.prevModeId = this.activeId()
    this.idx = i
    this.activeSinceAt = this.now()
    this.notify()
    return true
  }

  /**
   * Move forward in the cycle: `no-mode -> modes[0] -> modes[1] -> ... -> no-mode`.
   * Returns the new active mode (or `null` for no-mode).
   */
  cycleNext(): ManifestMode | null {
    if (this.modes.length === 0) return null
    this.prevModeId = this.activeId()
    if (this.idx === this.modes.length - 1) {
      this.idx = -1
      this.activeSinceAt = null
    } else {
      this.idx += 1
      this.activeSinceAt = this.now()
    }
    this.notify()
    return this.active()
  }

  /**
   * Move backward in the cycle. Useful when bound to Ctrl+Shift+Tab. Returns
   * the new active mode (or `null` for no-mode).
   */
  cyclePrev(): ManifestMode | null {
    if (this.modes.length === 0) return null
    this.prevModeId = this.activeId()
    if (this.idx === -1) {
      this.idx = this.modes.length - 1
      this.activeSinceAt = this.now()
    } else if (this.idx === 0) {
      this.idx = -1
      this.activeSinceAt = null
    } else {
      this.idx -= 1
      this.activeSinceAt = this.now()
    }
    this.notify()
    return this.active()
  }

  /**
   * Convenience: id of the currently active mode, or `null` for no mode.
   * Mirror of {@link active}().id without the optional-chaining ceremony.
   */
  activeId(): string | null {
    return this.active()?.id ?? null
  }

  /**
   * Dispatch-time tool gate.
   *
   * Tools are ALWAYS registered in the request body. The agent's tool
   * loop calls this before invoking each `tool_use` block; on `allowed:false`
   * it synthesizes an `is_error: true` result with the refusal
   * message.
   *
   * Evaluation iterates the mode's `ToolPermission[]` rules in order,
   * first-match wins. See {@link isToolAllowedByPermissions}.
   *
   * @param toolName - Tool name (e.g. `"Bash"`).
   * @param toolInput - Optional tool input for predicate evaluation.
   */
  isToolAllowed(
    toolName: string,
    toolInput?: Record<string, unknown>,
  ): { allowed: true } | { allowed: false; message: string } {
    const m = this.active()
    if (!m) return { allowed: true }
    const perms = this.effectivePermissions(m.id)
    if (!perms) return { allowed: true }
    if (isToolAllowedByPermissions(toolName, perms, toolInput)) return { allowed: true }
    const label = (m.label ?? m.id).toUpperCase()
    const tail = m.refusalHint ? ` ${m.refusalHint}` : ""
    return {
      allowed: false,
      message: `Tool "${toolName}" is not permitted in ${label} mode.${tail}`,
    }
  }

  /**
   * Build the `<ma::agent::mode-active />` envelope text to stamp onto a
   * tool_result. The model gets a fresh, machine-readable view of the
   * active mode on every tool round, killing reasoning-inertia bugs
   * where a long thinking block predates a user mode toggle.
   *
   * Returns `null` when no mode is active : the stamp is only emitted
   * for non-default policy, keeping no-mode turns byte-identical to
   * pre-permissions tool_result output.
   *
   * Format (single self-closing tag, no inner content):
   *
   * ```text
   * <ma::agent::mode-active id="ask" since="2026-05-27T15:02:19.000Z" />
   * ```
   *
   * The tag rides on the tail of the tool_result `content` (text) so
   * it sits in the rolling-tail cache breakpoint that's invalidated
   * every turn anyway. Zero cache cost.
   */
  buildActiveModeStamp(): string | null {
    const m = this.active()
    if (!m) return null
    const since = (this.activeSinceAt ?? this.now()).toISOString()
    return `<ma::agent::mode-active id="${m.id}" since="${since}" />`
  }

  /**
   * Activation-signal channel.
   *
   * If the active mode differs from the one the model was last told
   * about (via a previously-consumed attachment), returns a small
   * `<mode-change from="…" to="…" at="…" />` text content block to
   * prepend to the next outgoing user message. If active === lastAdvertised,
   * returns `null` and emits nothing.
   *
   * The block is intentionally minimal: the policy / behavior text for
   * each mode lives permanently in the cached `pluginBlock` (each mode
   * plugin's `PROMPT.md`), so the attachment only needs to carry the
   * activation pointer. Riding the user-turn boundary keeps it inside
   * the rolling-tail breakpoint that's invalidated every turn anyway —
   * mode toggles cost zero additional cache.
   *
   * The `at` attribute is an ISO-8601 timestamp of the most recent
   * toggle ({@link lastEvent}.at). When several toggles happen between
   * two consumes (e.g. the user fidgets Shift+Tab while the agent is
   * idle), only the final net change is advertised and `at` reflects
   * the last toggle. Falls back to `now()` if no toggle has happened
   * yet (only possible when `defaultModeId` was set at startup).
   *
   * Idempotent: consuming twice without an intervening toggle returns
   * `null` the second time. Also safe to call when no plugins/modes are
   * loaded — just always returns `null`.
   *
   * @returns A `text` content block to prepend to the next user message,
   *   or `null` if no advertisement is needed.
   */
  consumePendingAttachment(): ContentBlock | null {
    const currentId = this.activeId()
    if (currentId === this.lastAdvertisedModeId) return null
    const fromId = this.lastAdvertisedModeId
    const from = fromId ?? "default"
    const to = currentId ?? "default"
    this.lastAdvertisedModeId = currentId
    const at = this.lastEvent?.at ?? this.now()
    // Notify delivery listeners (chip renderer, queue-decoration
    // clearer, audit log, ...) AFTER `lastAdvertisedModeId` has been
    // updated so peek calls inside listeners return null (they would
    // otherwise see the same pending state and double-render).
    const deliveryEvent: ModeDeliveryEvent = { fromId, toId: currentId, at }
    for (const l of this.deliveryListeners) l(deliveryEvent)
    // Tag namespace: `<ma::...>` is the convention going forward
    // (see TODOS.md#T-ca2ce1). The session-replay parser accepts both
    // the new `<ma::agent::mode-change>` and the legacy bare `<mode-change>`
    // forms for one release so resumed pre-migration sessions still
    // render their chip history correctly.
    return {
      type: "text",
      text: `<ma::agent::mode-change from="${from}" to="${to}" at="${at.toISOString()}" />`,
    }
  }

  /**
   * Subscribe to mode-change DELIVERY events. Fires synchronously
   * from inside {@link consumePendingAttachment} right after the
   * attachment is built and `lastAdvertisedModeId` updated.
   *
   * Use this for "the model now knows about the change" side effects
   * (scrollback chip, queue-decoration clearer, audit log). DO NOT
   * use {@link subscribe} for those : that fires on TOGGLE, not on
   * delivery, and the model may not learn about a toggle for many
   * tool rounds.
   *
   * Returns an unsubscribe handle.
   */
  onDeliver(listener: (event: ModeDeliveryEvent) => void): () => void {
    this.deliveryListeners.add(listener)
    return () => {
      this.deliveryListeners.delete(listener)
    }
  }

  /**
   * Set `lastAdvertisedModeId` from outside : used by session resume
   * to seed the manager from the last `<ma::agent::mode-change to="...">` in
   * the persisted message history. Prevents the manager from re-emitting
   * a redundant `from="default" to="<id>"` attachment on first consume
   * after resume.
   *
   * Pure setter; does NOT trigger {@link notify} (no transition
   * happened, just bookkeeping).
   */
  primeLastAdvertised(modeId: string | null): void {
    this.lastAdvertisedModeId = modeId
  }

  /**
   * Mode active immediately before the most recent toggle. Useful for
   * UI ("you exited ASK and are back in $prev") and for symmetric
   * restore semantics in future modes that nest. Returns `null` when
   * there has been no toggle yet, or when the previous state was
   * "no mode active".
   */
  previousModeId(): string | null {
    return this.prevModeId
  }

  /**
   * Most-recent {@link ModeChangeEvent} this manager built, or `null`
   * when no transition has happened yet in this process. Late-attaching
   * subscribers can use this to render a one-time chip on attach
   * (e.g. session-replay rendering historical changes).
   */
  lastTransition(): ModeChangeEvent | null {
    return this.lastEvent
  }

  /**
   * Non-mutating peek at the pending advertisement: what
   * {@link consumePendingAttachment} would emit if called right now.
   * Returns `null` when nothing is pending (current active matches the
   * last-advertised mode).
   *
   * Used by the decoration band to surface a "mode change queued · will
   * ship on send" hint between the live-area status row and the editor
   * prompt. The decoration peeks every frame; the actual `consume` only
   * runs at user-turn assembly inside `agent.ts`. Calling this is free
   * and side-effect-free.
   */
  peekPendingAttachment(): PendingModeAttachment | null {
    const currentId = this.activeId()
    if (currentId === this.lastAdvertisedModeId) return null
    return { fromId: this.lastAdvertisedModeId, toId: currentId }
  }

  /** Look up a mode by id. Convenience for chip renderers that hold an id. */
  modeById(id: string | null): ManifestMode | null {
    if (id == null) return null
    return this.modes.find((m) => m.id === id) ?? null
  }

  /**
   * No-op pass-through that returns `tools` unchanged.
   *
   * @deprecated Use {@link isToolAllowed} at dispatch time instead.
   * Kept for one release as a no-op pass-through so external callers
   * don't crash; tools are no longer filtered out of the request body.
   * Will be removed in v2.2.
   */
  filterTools<T extends { name: string }>(tools: T[]): T[] {
    return tools
  }

  /**
   * Always returns `""`, warning once per process when an active mode still
   * declares the retired `systemPromptAppend` field.
   *
   * @deprecated Mode behavior text should live in the plugin's own
   * `PROMPT.md` (which is part of the cached `pluginBlock`). Splicing
   * `systemPromptAppend` into `sys[3]` invalidates the prompt cache on
   * every mode toggle. This method now returns `""` and warns once per
   * process if any active mode declares the deprecated field.
   * Will be removed in v2.2.
   */
  systemPromptAddition(): string {
    const m = this.active()
    if (m?.systemPromptAppend && !this.warnedSystemPromptAppend) {
      this.warnedSystemPromptAppend = true
      console.error(
        `  ${c.yellow("⚠")} mode "${m.id}" declares deprecated ` +
          `\`systemPromptAppend\` — move the text to the plugin's ` +
          `PROMPT.md so the system-prompt cache survives toggles. ` +
          `(see ManifestMode.systemPromptAppend JSDoc)`,
      )
    }
    return ""
  }

  /**
   * Whether the active mode requests visible rendering of invisible editor
   * characters (spaces as `·`, tabs as `→`, line-ends as `↵`).
   *
   * Returns `false` when no mode is active or the active mode does not
   * set `editorShowHidden: true`.
   */
  editorShowHidden(): boolean {
    return this.active()?.editorShowHidden ?? false
  }

  /**
   * The status spinner label to use while the agent is awaiting a response.
   *
   * @param fallback - Label to use when no mode is active. Typically "Thinking".
   */
  statusLabel(fallback: string): string {
    const m = this.active()
    if (!m) return fallback
    return defaultStatusLabel(m)
  }

  /**
   * REPL prompt prefix string, including a trailing space.
   *
   * Ends in the `❯ ` arrow with the mode label colored when a mode is
   * active. When no mode is active, returns the bare arrow so existing UI
   * looks unchanged.
   *
   * The arrow surface is *also* mode-styleable: if `style.arrow.fg` is set
   * the arrow is repainted with that color (this is what lets ASK opt into
   * a blue arrow next to the blue `ASK` label). If the mode does not
   * request an arrow color, the caller's pre-styled `baseArrow` is reused.
   *
   * @param baseArrow - Default pre-styled arrow including trailing space
   *   (e.g. `${pink("❯")} `). Used as-is when no mode requests a restyle.
   * @param arrowGlyph - Raw glyph used to rebuild the arrow when the mode
   *   restyles it. Defaults to `"❯"`.
   */
  promptPrefix(baseArrow: string, arrowGlyph = "❯"): string {
    return this.promptPrefixForId(this.activeId(), baseArrow, arrowGlyph)
  }

  /**
   * Like {@link promptPrefix}, but resolves against an explicit mode id
   * instead of the currently active one. Pass `null` (or any unknown id,
   * including the literal `"default"` placeholder used as the "no mode"
   * token in `<mode-change>` activation blocks) to get the bare
   * `baseArrow`.
   *
   * Used by session replay (see `session-replay.ts`) to render past
   * user turns under the prompt prefix that was active at the time,
   * reconstructed from the `<mode-change from=… to=… at=… />` attachments
   * stored alongside the user content. Pure: never mutates `this.idx` or
   * `lastAdvertisedModeId` — safe to call repeatedly while walking
   * historical messages.
   *
   * @param modeId - Id of the mode whose prefix to render, or `null`.
   * @param baseArrow - Default pre-styled arrow (with trailing space)
   *   used when `modeId` is `null` or unknown, or when the resolved
   *   mode does not request its own arrow color.
   * @param arrowGlyph - Raw glyph used to rebuild the arrow when the
   *   resolved mode restyles it. Defaults to `"❯"`.
   */
  promptPrefixForId(modeId: string | null, baseArrow: string, arrowGlyph = "❯"): string {
    if (modeId == null) return baseArrow
    const idx = this.modes.findIndex((mm) => mm.id === modeId)
    if (idx === -1) return baseArrow
    const m = this.modes[idx]
    const resolved = this.resolvedCache[idx]
    const label = clampLabel((m.label ?? m.id).toUpperCase())
    const labelStyle = resolved?.label ?? null
    const arrowStyle = resolved?.arrow ?? null

    const paintedLabel = labelStyle
      ? paint(label, { ...labelStyle, bold: labelStyle.bold || true })
      : c.bold(label)

    const arrow =
      arrowStyle && arrowStyle.fgOpen
        ? `${paint(arrowGlyph, { ...arrowStyle, bold: arrowStyle.bold || true })} `
        : baseArrow

    return `${paintedLabel} ${arrow}`
  }

  /**
   * Resolved style for the active mode, or `null` when no mode is active or
   * the active mode declared no style.
   */
  resolved(): ResolvedModeStyle | null {
    if (this.idx === -1) return null
    return this.resolvedCache[this.idx]
  }

  /**
   * Resolved style for an arbitrary mode by id. Returns `null` when the
   * id is unknown OR when the mode declared no style. Used by the chip
   * renderer to look up the target mode's accent color without binding
   * the renderer to the manager's internal cache.
   */
  resolvedForId(id: string | null): ResolvedModeStyle | null {
    if (id == null) return null
    const idx = this.modes.findIndex((m) => m.id === id)
    if (idx === -1) return null
    return this.resolvedCache[idx]
  }

  /**
   * Resolved style for the status spinner surface, or `null` when no mode
   * is active or the mode does not contribute a style.
   */
  statusStyle(): ResolvedSurfaceStyle | null {
    return this.resolved()?.status ?? null
  }

  /**
   * Color helper for the active mode (defaults to {@link c.cyan}). Useful
   * when the REPL wants to color the spinner accent or other small UI bits
   * via the legacy `c.*` helper signature.
   *
   * @deprecated Prefer {@link statusStyle} or {@link resolved} so callers
   * also get bold/dim/bg, not just a fg-only function.
   */
  color(): (s: string) => string {
    const m = this.active()
    if (!m) return c.cyan
    return COLOR_HELPERS[m.color ?? "cyan"] ?? c.cyan
  }

  private notify(): void {
    const a = this.active()
    // Build the event from prevModeId (captured right before idx moved)
    // and the now-current active mode. `modeById(null)` returns null so
    // the default ↔ default edge case stays type-safe even though notify
    // is never called for it (the setters bail before reaching here).
    const event: ModeChangeEvent = {
      from: this.modeById(this.prevModeId),
      to: a,
      at: this.now(),
    }
    this.lastEvent = event
    for (const l of this.listeners) l(a, event)
  }
}

/**
 * Match a `<ma::agent::mode-change>` (or legacy `<mode-change>`) self-closing
 * tag and capture the `to=` value. Tolerant of attribute order and
 * stray whitespace.
 *
 * Pure regex. The only consumer is {@link lastAdvertisedModeFromHistory}.
 */
const MODE_CHANGE_TO_RE = /<(?:ma::(?:agent::)?)?mode-change\b[^>]*\bto="([^"]*)"[^>]*\/>/

/**
 * Walk a list of API-shape `Message`s and return the `to=` value of
 * the LAST `<ma::agent::mode-change>` advertisement found in any user-role
 * text block. Returns `null` when no advertisement is found OR when
 * the last one targeted `"default"`.
 *
 * Used by `src/index.ts` on session resume to prime
 * {@link ModeManager.primeLastAdvertised} so the first consume after
 * resume does not re-announce the mode the model already knows about
 * from its persisted conversation history.
 *
 * Tolerates both the new `<ma::agent::mode-change>` and legacy bare
 * `<mode-change>` spellings during the tag-namespace migration
 * window (TODOS.md#T-ca2ce1).
 *
 * Pure: no I/O, no allocations beyond the regex match. Walks
 * messages in reverse so the typical "last turn" case is constant-time.
 */
export function lastAdvertisedModeFromHistory(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user") continue
    if (!Array.isArray(m.content)) continue
    for (let j = m.content.length - 1; j >= 0; j--) {
      const block = m.content[j] as { type?: string; text?: unknown }
      if (block?.type !== "text") continue
      if (typeof block.text !== "string") continue
      const match = block.text.match(MODE_CHANGE_TO_RE)
      if (match) {
        const to = match[1]
        return to === "default" || to === "" ? null : to
      }
    }
  }
  return null
}
