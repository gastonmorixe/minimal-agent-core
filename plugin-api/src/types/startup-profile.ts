/**
 * Startup profile contract (subagent inherit).
 *
 * A lead session writes its FINAL startup settings (after CLI, env, and
 * config precedence) to `<sessionsDir>/<sid>.profile.json`. A child session
 * started with `--startup-profile <path>` reads it and uses it in place of
 * its own env and config tiers. Explicit child CLI flags still win.
 *
 * The profile holds override file CONTENTS, never file paths. The prompt
 * part shape mirrors `src/llm/system-prompt-overrides.ts` structurally,
 * because plugin-api must not import core src.
 *
 * The same module declares {@link HostPolicySnapshot}: the live mode and
 * tool policy a host exposes to plugins through `TUIContext.queryHostPolicy`.
 *
 * @module types/startup-profile
 */

/** The only profile schema version this core reads and writes. */
export const STARTUP_PROFILE_VERSION = 1 as const

/** One system-prompt part after precedence is resolved. */
export type StartupProfilePromptPart =
  | { readonly kind: "default" }
  | { readonly kind: "replace"; readonly text: string }
  | { readonly kind: "omit" }

/** Every named system-prompt part a profile may carry. */
export const STARTUP_PROFILE_PART_NAMES = [
  "full",
  "identity",
  "providerPreamble",
  "instructions",
  "sessionContext",
] as const

/** A named system-prompt part a profile may carry. */
export type StartupProfilePartName = (typeof STARTUP_PROFILE_PART_NAMES)[number]

/** Resolved system-prompt overrides, structurally equal to core `SystemPromptOverrides`. */
export type StartupProfileSystemPrompt = Readonly<
  Partial<Record<StartupProfilePartName, StartupProfilePromptPart>>
> & { readonly unsafeProviderOverrides?: boolean }

/** Tool name policy in profile form: all tools, no tools, or an allow-list. */
export type StartupProfileTools =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "list"; readonly names: readonly string[] }

/** The final startup settings of a session, as written to disk. */
export interface StartupProfile {
  readonly version: typeof STARTUP_PROFILE_VERSION
  /** Override CONTENTS, never file paths. */
  readonly systemPrompt: StartupProfileSystemPrompt
  readonly noAgentsMd: boolean
  readonly pluginPrompts: {
    readonly all: boolean
    readonly suppress: readonly string[]
    readonly keep: readonly string[]
  }
  readonly plugins: { readonly disable: readonly string[]; readonly enable: readonly string[] }
  readonly bare: boolean
  readonly tools: StartupProfileTools
  /** Prompt-cache anchor flag (F1) of the lead. Absent (older profile): the child resolves its own. */
  readonly cacheAnchor?: boolean
  /** Older-turn thinking mode (F2) of the lead. Absent (older profile): the child resolves its own. */
  readonly thinkingHistory?: "strip" | "keep"
}

/** One mode as seen by a plugin: id, label, and flattened allow/deny/match tool names. */
export interface ModePolicyEntry {
  readonly id: string
  readonly label?: string
  /**
   * Derived from the effective rules, first match wins: the FIRST rule for a
   * tool name (or for `"*"`) decides it, so the three lists are disjoint.
   * `allow: true` goes to `allow`. `allow: false` goes to `deny`.
   * `allow: "match"` with a predicate goes to `match` (input-dependent);
   * `"match"` without a predicate goes to `deny`.
   *
   * Evaluate tool `t` exactly as core does (exact name before `"*"`):
   * `t` in deny → denied; `t` in allow → allowed; `t` in match → input-dependent;
   * else the same three checks for `"*"`; else denied.
   *
   * Input-dependent (`match`) is unknown without the tool input: treat it as
   * ALLOW when judging how wide a role's mode is, and as DENY when judging
   * what the lead's mode permits.
   */
  readonly permissions: {
    readonly allow: readonly string[]
    readonly deny: readonly string[]
    readonly match: readonly string[]
  }
}

/** Live host policy at call time: active mode, all modes, and the tool name policy. */
export interface HostPolicySnapshot {
  /** Live mode id at call time, null = no mode (unrestricted). */
  readonly activeModeId: string | null
  readonly modes: readonly ModePolicyEntry[]
  /** Lead tool name policy (--tools/--no-tools). */
  readonly tools: StartupProfileTools
}
