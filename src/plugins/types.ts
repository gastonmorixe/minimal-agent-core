/**
 * TUI plugin public types.
 *
 * Author-facing surface for writing tui-plugin handler modules. These types
 * are also used internally by the loader and dispatcher. Nothing in this
 * file has runtime behavior — it's a types-only module.
 *
 * Spec: see `/Users/gaston/.claude/plans/polished-drifting-dijkstra.md`.
 *
 * @module plugins/types
 */

// ---------------------------------------------------------------------------
// Trigger shapes
// ---------------------------------------------------------------------------

/**
 * The event that activated a handler.
 *
 * `tool` fires when the model emits a `tool_use` block naming a tool the
 * plugin declared. `inline_tag` fires when the stream scanner detects a
 * matching `<tui::NAME ...>...</tui::NAME>` (or self-closing) span in
 * assistant text.
 */
export type TUITrigger =
  | {
      type: "tool"
      /** The tool name the model called. Same as `trigger.tool.name` in the manifest. */
      name: string
      /** Parsed JSON input the model provided. */
      input: Record<string, unknown>
      /** The tool_use id from the wire protocol. */
      tool_use_id: string
    }
  | {
      type: "inline_tag"
      /** Tag name from `<tui::NAME ...>`. */
      name: string
      /** Parsed attribute map. Values are always strings. */
      attrs: Record<string, string>
      /** Raw body text between opener and closer. Empty for self-closing. */
      body: string
      /** True if the tag was self-closing (`<tui::NAME ... />`). */
      self_closing: boolean
    }

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to a module handler's default export.
 *
 * Subprocess handlers receive an equivalent shape as a JSON object on stdin.
 */
export interface TUIContext {
  /** What triggered this handler. */
  trigger: TUITrigger
  /** Plugin package directory (absolute). Use as the base for relative paths. */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Plugin-scoped environment. The loader injects `TUI_PLUGIN_PROTOCOL=1`. */
  env: Record<string, string>
  /** Aborts when the turn is canceled or the per-call timeout fires. */
  abort: AbortSignal
  /** Terminal stdout handle for interactive tool-call handlers. */
  stdout: NodeJS.WriteStream
  /** Terminal stdin handle for interactive tool-call handlers. */
  stdin: NodeJS.ReadStream
  /** Debug log stream. */
  stderr: NodeJS.WriteStream
}

// ---------------------------------------------------------------------------
// Handler result
// ---------------------------------------------------------------------------

/**
 * Handler return value. Shape depends on the trigger and interactivity.
 *
 * - `tool_result` for tool-call triggers: becomes a `tool_result` content
 *   block in the conversation.
 * - `rendered` for inline non-interactive triggers: the ANSI bytes replace
 *   the original tag span in the output stream.
 * - `interactive_result` for inline interactive triggers: the value is
 *   JSON-encoded and injected as a synthetic user message after the
 *   truncated assistant turn.
 */
export type TUIResult =
  | {
      kind: "tool_result"
      content: string
      is_error?: boolean
      /**
       * Body content. Rendered line-by-line between the `┊` connector and
       * the closing `╰` glyph, with the standard `│` gutter. ANSI escapes
       * pass through verbatim and are NOT truncated (unlike `content`).
       *
       * When `displayFooter` is absent, the LAST line of `display` is
       * rewritten to start with `╰` instead of `│` (matching Edit/Write
       * diff rendering).
       */
      display?: string
      /**
       * Header CONTENT slot — fills the position that `formatToolInput(tool)`
       * occupies by default, AFTER the agent-drawn chrome:
       *
       *   ╭ <icon> <label>  <displayHeader || formatToolInput(tool)>
       *     ^^^^^^^^^^^^^^                  ^^^^^^^^^^^^^^^^^^^^^^
       *     agent-owned                     plugin-owned slot
       *
       * The icon, label, frame glyphs (`╭`, `┊`, `│`, `╰`), and the
       * two-space gap between label and content all come from the manifest
       * + agent unconditionally. A plugin that wants a richer summary than
       * the raw input JSON ("+ added 7 tasks · 0/7" instead of
       * `action="add_many"`) writes it here and the agent splices it into
       * the slot — without losing the tool's identity.
       *
       * Single-line. Empty string is treated as "no content slot, just
       * the chrome" (renders as `╭ <icon> <label>` with no trailing
       * separator).
       */
      displayHeader?: string
      /**
       * Footer CONTENT slot — fills the position after the closing `╰`:
       *
       *   ╰ <displayFooter>
       *
       * When omitted, the last body line of `display` absorbs the `╰`
       * connector. When present, the closer is its own row.
       */
      displayFooter?: string
    }
  | { kind: "rendered"; ansi: string }
  | { kind: "interactive_result"; value: unknown }

/**
 * Module-handler default export signature.
 *
 * A handler file must `export default` an async function of this type.
 */
export type TUIHandler = (ctx: TUIContext) => Promise<TUIResult>

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/**
 * The JSON body of a `manifest.json` file at the root of a tui-plugin package.
 *
 * Matches the schema in the spec. Every field is validated at load time; the
 * loader throws a descriptive error for malformed manifests and skips the
 * package.
 */
export interface ManifestFile {
  id: string
  name: string
  version: string
  description: string
  /** Optional relative path to a PROMPT.md file (default: `./PROMPT.md`). */
  prompt?: string
  /**
   * Async prompt fragments. Each fragment is a producer (subprocess or
   * module) that returns a string to inject into the system prompt. They
   * run in parallel during {@link PluginLoader.load} and are awaited the
   * first time the agent assembles a system prompt
   * ({@link PluginLoader.getPromptBlockAsync}).
   *
   * Fragment results are memoized for the rest of the session (the
   * system prompt sits on a cache breakpoint and must be stable). They
   * are NOT included in the sync {@link PluginLoader.getPromptBlock}
   * (used for the session hash) so that volatile content like the
   * current date doesn't bust resume drift detection.
   *
   * Optional; may be empty.
   */
  promptFragments?: ManifestPromptFragment[]
  /**
   * TUI handlers. May be empty if the plugin only contributes modes.
   * Either `tuis`, `modes`, or `events` must be non-empty.
   */
  tuis?: ManifestHandler[]
  /**
   * Named operating modes contributed by this plugin (e.g. ASK, PLAN).
   * See {@link ManifestMode}. Optional; may be empty.
   */
  modes?: ManifestMode[]
  /**
   * Event-bus subscriptions. See {@link ManifestEventSubscription}. The
   * loader installs each entry on the agent's event bus at load time;
   * handlers run asynchronously and never block the caller (see
   * {@link plugins/event-bus}).
   *
   * Optional; may be empty.
   */
  events?: ManifestEventSubscription[]
  /**
   * Hook-bus subscriptions. See {@link ManifestHookSubscription}.
   *
   * Hooks differ from `events` in that they participate in the agent's
   * lifecycle pipeline: a `chain`-shape hook can mutate or veto data
   * (e.g. rewrite a message before send, block a tool call); a `stream`
   * hook receives a multicast `AsyncIterable`. See `docs/hooks.md` for
   * the channel catalog and shapes.
   *
   * Each subscription must declare a `permission` matching the
   * channel's required permission, or carry a wildcard
   * (`hooks:turn.*`). The loader rejects manifests that subscribe to
   * channels they don't have permission for. See also {@link permissions}.
   *
   * Optional; may be empty.
   */
  hooks?: ManifestHookSubscription[]
  /**
   * Live-area slots contributed by this plugin. Each slot is a periodic
   * producer of a single line of ANSI text rendered into the REPL's
   * sticky bottom live area — either above the input (`position: "header"`)
   * or below it (`position: "footer"`).
   *
   * Use this for ambient, non-interactive status that should persist
   * without competing with scrollback (e.g. quota %, git branch state,
   * background-job progress). Slots run on a fixed interval; first
   * invocation fires immediately at REPL start. See
   * {@link ManifestLiveAreaSlot}.
   *
   * Optional; may be empty.
   */
  liveAreaSlots?: ManifestLiveAreaSlot[]
  /**
   * Permission grants this plugin requires. Each entry follows the form
   * `hooks:CHANNEL` or `hooks:CHANNEL.*` (wildcard). The loader denies
   * any hook subscription whose channel isn't covered by an entry here.
   *
   * Optional; defaults to `[]`.
   */
  permissions?: string[]
  /**
   * If `true`, this plugin needs `UNSAFE_HOOKS=1` in the environment
   * to load. The loader skips the plugin (with a clear log) when the
   * env var is unset. Use sparingly — meant for plugins that genuinely
   * need to register listeners in the agent priority band, override
   * core behavior, or do other privileged things.
   *
   * Defaults to `false`.
   */
  requiresUnsafeHooks?: boolean
}

/**
 * One async prompt fragment contributed by a plugin.
 *
 * The producer is either a subprocess that writes the fragment text to
 * stdout, or a module whose default export returns a string. Producers
 * run in parallel at loader-init time, are awaited (with a per-fragment
 * `timeoutMs`) on first prompt assembly, and are memoized thereafter.
 *
 * On timeout the fragment is dropped silently and a diagnostic is logged.
 */
export interface ManifestPromptFragment {
  /** Stable id, unique within the package. */
  id: string
  /** Producer entry. Subprocess receives empty stdin and writes to stdout. */
  handler: ManifestHandlerEntry
  /**
   * Per-fragment deadline. If the producer hasn't resolved by this many
   * ms after first prompt assembly, the fragment is dropped. Defaults to
   * 2000.
   */
  timeoutMs?: number
  /**
   * Insertion order across all fragments and plugins. Lower numbers come
   * first. Defaults to 100.
   */
  order?: number
}

/**
 * Module-handler default export signature for prompt fragments.
 *
 * Returns the fragment text as a string. The loader wraps the call with
 * a timeout; long-running producers should respect `ctx.abort`.
 */
export type PromptFragmentHandler = (ctx: PromptFragmentContext) => Promise<string> | string

/**
 * Runtime context passed to a prompt-fragment module handler.
 */
export interface PromptFragmentContext {
  /** Plugin package directory (absolute). */
  packageDir: string
  /** The agent's current working directory at load time. */
  cwd: string
  /** Plugin-scoped environment. The loader injects `TUI_PLUGIN_PROTOCOL=1`. */
  env: Record<string, string>
  /**
   * Agent session id (UUID v4). Same value `metadata.getSessionId()`
   * returns. Available because `getSessionId()` is lazy-init and is
   * always called before {@link PluginLoader.load} in the agent boot
   * path. May be `undefined` only when the loader is invoked outside
   * the agent (tests, ad-hoc tooling) without a session id passed.
   */
  sessionId?: string
  /** Aborts when the fragment's timeout fires. */
  abort: AbortSignal
  /** Diagnostic stream. */
  stderr: NodeJS.WriteStream
}

/**
 * One event-bus subscription contributed by a plugin.
 *
 * Plugins use events to react to host signals that don't fit the
 * `tool` / `inline_tag` trigger model — for example,
 * `prompt.input.changed` (the user typed in the prompt input), or
 * lifecycle events like `mode.changed`.
 *
 * Handlers receive an {@link EventHandlerContext} (similar to
 * {@link TUIContext} but with `event` + `payload` + `emit` instead of a
 * `trigger`). They return `void` — events are one-way notifications, not
 * filters; a handler that wants to influence host state does so by
 * emitting follow-up events on the bus (e.g. `mode.set.request`).
 */
export interface ManifestEventSubscription {
  /** Stable id, unique within the package. */
  id: string
  /** Event name to subscribe to (e.g. `"prompt.input.changed"`). */
  on: string
  /** How to run the handler when the event fires. */
  handler: ManifestHandlerEntry
  /**
   * If true, only one invocation runs at a time per listener. While one
   * is in flight, intermediate emits collapse into a single pending
   * slot keyed by the latest payload. Defaults to `false`.
   *
   * Recommended for high-frequency events like `prompt.input.changed`.
   */
  coalesce?: boolean
  /**
   * Minimum interval in milliseconds between deliveries to this
   * listener. Emits inside the window are dropped. Defaults to `0`.
   */
  throttleMs?: number
}

/**
 * Runtime context passed to an event-subscription handler's default
 * export. Mirrors {@link TUIContext} except the activation is an event
 * (not a trigger) and the handler can re-emit on the bus via {@link emit}.
 *
 * Subprocess event handlers receive an equivalent shape as a JSON object
 * on stdin. They write follow-up emits as one JSON line per event to
 * stdout, e.g. `{"emit":"mode.set.request","payload":{"id":"ask"}}`.
 */
export interface EventHandlerContext<TPayload = unknown> {
  /** The event name that triggered this invocation. */
  event: string
  /** Payload provided by the emitter. Shape is event-specific. */
  payload: TPayload
  /** Plugin package directory (absolute). Use as the base for relative paths. */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Plugin-scoped environment. The loader injects `TUI_PLUGIN_PROTOCOL=1`. */
  env: Record<string, string>
  /** Re-emit on the same bus. */
  emit: (event: string, payload?: unknown) => void
  /** Aborts when the agent is shutting down. */
  abort: AbortSignal
  /** Debug log stream. */
  stderr: NodeJS.WriteStream
}

/**
 * One hook-bus subscription contributed by a plugin.
 *
 * Hooks ride either the {@link EventBus} (for `broadcast-async`
 * channels) or the {@link HookBus} (for `chain` / `broadcast-sync` /
 * `stream` channels). The shape is determined by the channel registry
 * in `plugins/hooks/channels.ts`; the plugin doesn't pick.
 *
 * For `chain` channels the handler must return `void`,
 * `{payload: T}`, `{payload: T, halt: true}`, or `{halt: true,
 * reason?: string}`. Plugin-priority is clamped to `[0..100]` unless
 * `UNSAFE_HOOKS=1` is set.
 */
export interface ManifestHookSubscription {
  /** Stable id, unique within the package. */
  id: string
  /** Channel name (e.g. `"turn.didEnd"`, `"tool.willInvoke"`). */
  channel: string
  /** How to run the handler when the channel fires. */
  handler: ManifestHandlerEntry
  /**
   * Listener priority. Plugin range `[0..100]`. Higher runs first.
   * Defaults to 50.
   */
  priority?: number
  /**
   * For `chain` channels: declare the listener as observation-only.
   * Mutating returns are dropped with a warning. Defaults to false.
   */
  observeOnly?: boolean
  /**
   * For `chain` channels: per-listener timeout in ms. Defaults to
   * 2000 for plugins.
   */
  timeoutMs?: number
}

/**
 * Module-handler default export signature for event subscriptions.
 *
 * A handler file must `export default` an async function of this type.
 * Returning a value is allowed but ignored — events are one-way.
 */
export type EventHandler<TPayload = unknown> = (
  ctx: EventHandlerContext<TPayload>,
) => void | Promise<void>

/**
 * One live-area slot contributed by a plugin.
 *
 * A slot is a periodic, non-interactive producer of a single line of
 * ANSI text that the REPL paints into its sticky bottom live area. Two
 * positions are supported:
 *
 * - `"header"` — rendered above the input, alongside other decoration
 *   rows (queued user messages, etc.). Useful for "what's coming next"
 *   info.
 * - `"footer"` — rendered BELOW the input, pinned to the very bottom of
 *   the terminal. Useful for ambient status that should never compete
 *   with what the user is typing (quota %, git state, etc.).
 *
 * The handler is invoked at REPL start (t=0) and then every
 * `refreshMs`. It returns a string (the new value), `null` (clear the
 * slot), or throws (error → slot cleared, diagnostic logged). The
 * scheduler skips ticks while a previous invocation is still in flight,
 * so a slow handler can't pile up.
 */
export interface ManifestLiveAreaSlot {
  /** Stable id, unique within the package. */
  id: string
  /** How to run the producer. Module or subprocess. */
  handler: ManifestHandlerEntry
  /** Where in the live area to render the result. Defaults to `"footer"`. */
  position?: "header" | "footer"
  /**
   * Refresh interval in milliseconds. Defaults to 60_000 (1 min).
   * Minimum enforced by the scheduler is 1000 ms.
   */
  refreshMs?: number
  /**
   * Per-invocation deadline. If the producer hasn't resolved by this
   * many ms, the in-flight call is abandoned and the previous value is
   * preserved. Defaults to 5000.
   */
  timeoutMs?: number
  /**
   * Initial line painted into the slot at REPL start, BEFORE the first
   * invoke resolves. Reserves the live-area row so the prompt doesn't
   * visually shift up by one row when the first real value arrives.
   * Use a faint loader/skeleton (e.g. `quota  ·`); empty string is
   * treated as "no row" and re-introduces the jump.
   *
   * When omitted, the slot's row appears only after the first non-null
   * invoke result. ANSI escapes are allowed; the editor counts visual
   * rows, not characters.
   */
  placeholder?: string
  /**
   * Plugin-bus event names that should trigger an off-cycle re-fire of
   * this slot. Use for event-driven refresh — e.g. `quota` re-renders
   * on every API response (`quota.headersReceived`), not just on the
   * timer. The scheduler subscribes via the loader's event bus; the
   * existing in-flight/timeout machinery prevents pile-up under bursts.
   *
   * Optional. Empty array = timer-only refresh (same as omitting).
   */
  refreshOn?: string[]
}

/**
 * Module-handler default export signature for live-area slots.
 *
 * Returns the new line to render, `null` to clear the slot, or throws
 * to clear and log a diagnostic.
 */
export type LiveAreaHandler = (
  ctx: LiveAreaHandlerContext,
) => Promise<string | null> | string | null

/**
 * Runtime context passed to a live-area slot handler.
 */
export interface LiveAreaHandlerContext {
  /** Plugin package directory (absolute). */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Plugin-scoped environment. */
  env: Record<string, string>
  /** Aborts when the per-invocation timeout fires or the REPL is closing. */
  abort: AbortSignal
  /** Diagnostic stream. Writers should be lightweight; the live area is hot. */
  stderr: NodeJS.WriteStream
  /**
   * Monotonically increasing tick counter for this slot. `0` for the
   * first call, `1` for the second, etc. Useful for slots that want to
   * stagger heavy work (e.g. only refresh "real" data every N ticks).
   */
  tick: number
}

/**
 * One named operating mode.
 *
 * A mode is a lightweight UX state on top of the agent. When active it can:
 *
 * - Append a system-prompt fragment so the model knows to behave a certain way
 *   (e.g. "you are in ASK mode, refuse to call Edit/Write tools").
 * - Filter the tool list visible to the model (`disallowedTools`).
 * - Re-skin the REPL prompt with a colored label like `ASK > `.
 * - Re-skin the agent status spinner ("Asking..." instead of "Thinking...").
 *
 * Modes are mutually exclusive: at most one is active at a time. Cycling
 * (Shift+Tab in the REPL) walks the list `[no-mode, mode-1, mode-2, ...]`.
 */
export interface ManifestMode {
  /** Stable id, unique across all loaded plugins. Lowercase / kebab. */
  id: string
  /**
   * Short uppercase label for the prompt and status bar (e.g. "ASK", "PLAN").
   * Defaults to the upper-cased id.
   */
  label?: string
  /**
   * Color name for the prompt prefix and status spinner accent. One of:
   * `cyan`, `blue`, `magenta`, `yellow`, `green`, `red`, `pink`, `purple`,
   * `orange`, `sky`, `lime`, `gold`. Defaults to `cyan`.
   *
   * @deprecated Prefer {@link ManifestMode.style}. If both are set, `style`
   * wins and a one-time warning is emitted. Kept for backwards compatibility
   * with manifests that pre-date the richer style surface.
   */
  color?: string
  /**
   * Per-surface style request. Declarative: the mode states what it would
   * like (foreground, background, bold, dim, per-theme variants); the agent
   * resolves those wishes against the active theme, terminal capabilities,
   * and accessibility rules to produce concrete render output. The plugin
   * never paints; the agent does. See `work/mode-style-spec.md`.
   *
   * If absent and {@link ManifestMode.color} is present, the agent
   * synthesizes a style request equivalent to the legacy color (label,
   * arrow, status all share the named color; backgrounds transparent).
   */
  style?: ModeStyleRequest
  /**
   * Status spinner label. Defaults to `${capitalize(label)}ing` if absent
   * (e.g. ASK -> "Asking"), otherwise to "Thinking".
   */
  statusLabel?: string
  /**
   * Markdown text to append to the system prompt's session-context block
   * while this mode is active.
   *
   * @deprecated As of v2.1.119 the recommended channel for mode behavior
   *   text is the plugin's own `PROMPT.md` (which is part of the cached
   *   `pluginBlock` of the system prompt). Reword the content from
   *   "you have switched into X mode" to "when the active mode is `x`,
   *   behave as follows…" so it remains valid whether the mode is active
   *   or not. The activation signal is delivered as a small
   *   `<mode-change>` attachment in the next user turn (see
   *   {@link ModeManager.consumePendingAttachment}).
   *
   *   Concrete reason: any change to `systemPromptAppend` between turns
   *   mutates the tail of `sys[3]` which carries `cache_control`; that
   *   invalidates the entire ~12k-token system-prompt cache entry on
   *   every mode toggle. PROMPT.md text is byte-stable across toggles.
   *
   *   Setting this field still works for one release (v2.1.x) but emits
   *   a one-time stderr warning. It will be removed in v2.2.
   */
  systemPromptAppend?: string
  /**
   * Tool names the harness will refuse to execute while this mode is
   * active. The tools STAY REGISTERED in the request — the model still
   * sees them in its tool list — but
   * {@link ModeManager.isToolAllowed} returns `allowed: false` for
   * them and the agent's tool-dispatch loop synthesizes a structured
   * `is_error: true` tool_result instead of running the tool.
   *
   * Why "registered + refused" rather than "filtered out": removing a
   * tool from the request changes the `tools` array bytes, which sits
   * in the cached request prefix; that invalidates the prompt cache on
   * every mode toggle. Keeping the array byte-stable preserves the
   * cache. Mode mechanics live in code (the dispatch gate), not in
   * the wire shape.
   *
   * Use exact tool names (e.g. `["Edit", "Write"]`).
   */
  disallowedTools?: string[]
  /**
   * Optional teaching string appended to the refusal `tool_result`'s
   * content when the model calls a disallowed tool. The model sees the
   * full message in its next turn and can adapt within the same agentic
   * loop without a user round-trip.
   *
   * Example for ASK mode:
   *   "Present the proposed change as a unified diff in a code block;
   *    the user will apply it manually."
   *
   * The full refusal payload is rendered as
   *   `Tool "<name>" is not permitted in <LABEL> mode. <refusalHint>`
   *
   * Keep it short (one sentence). The longer "policy" explanation
   * belongs in the plugin's `PROMPT.md`, which is permanently in the
   * cached system prompt.
   */
  refusalHint?: string
  /**
   * If `true`, this mode is the agent's startup mode. Only one mode across
   * all loaded plugins may declare itself default. If multiple do, the
   * loader keeps the first.
   */
  default?: boolean
  /**
   * When `true`, the live editor renders invisible characters as faint
   * glyphs (spaces → `·`, tabs → `→`, line-ends → `↵`) while this mode
   * is active. Useful for a dedicated "debug" mode in test harnesses or
   * developer setups.
   */
  editorShowHidden?: boolean
}

// ---------------------------------------------------------------------------
// Mode style request (declarative — see work/mode-style-spec.md)
// ---------------------------------------------------------------------------

/**
 * A color value as a mode wishes to express it. Most-restrictive forms first.
 *
 * - `"transparent"` — sentinel, never paints. Default for backgrounds.
 * - Semantic token (`"accent"`, `"accent-soft"`, `"danger"`, `"muted"`, ...) —
 *   theme-aware. **Preferred** for plugin authors.
 * - Legacy color name (`"blue"`, `"pink"`, ...) — same set the manifest's
 *   `color` field has always accepted. Kept for compat.
 * - Literal hex `"#rrggbb"` — escape hatch. May be downgraded by the
 *   resolver on terminals without truecolor.
 * - Explicit fallback object — let the plugin author specify a chain
 *   (`token` first, then `hex`, then `ansi256`). The resolver picks the
 *   richest form the terminal supports.
 *
 * Raw ANSI escape strings are forbidden by validation; they bypass the
 * policy layer.
 */
export type ColorRequest =
  | string
  | {
      token?: string
      hex?: string
      ansi256?: number
    }

/**
 * Style request for one renderable surface (label, arrow, status spinner).
 *
 * All fields are optional. Omitted `fg` inherits from the `label` surface.
 * Omitted `bg` defaults to `"transparent"`.
 */
export interface SurfaceStyleRequest {
  fg?: ColorRequest
  bg?: ColorRequest
  bold?: boolean
  dim?: boolean
}

/**
 * Theme keys recognized by the resolver. Plugins may provide overrides for
 * any subset; missing keys fall through to the base style.
 */
export type ThemeKey = "dark" | "light" | "high-contrast"

/**
 * The full style request for a mode.
 *
 * Three named surfaces (`label`, `arrow`, `status`) and an optional `theme`
 * map for per-theme overrides. The agent's resolver merges base + theme
 * override, applies policy (capability fallback, contrast guard, width cap,
 * background opt-in), and emits a `ResolvedModeStyle` the TUI can render
 * without making any color decisions itself.
 */
export interface ModeStyleRequest {
  label?: SurfaceStyleRequest
  arrow?: SurfaceStyleRequest
  status?: SurfaceStyleRequest
  theme?: Partial<Record<ThemeKey, ModeStyleRequest>>
}

/**
 * Per-handler declaration inside the manifest's `tuis` array.
 */
export interface ManifestHandler {
  /** Stable id, unique within the package. */
  id: string
  /** What activates this handler. */
  trigger: ManifestTrigger
  /** How to run it when activated. */
  handler: ManifestHandlerEntry
  /**
   * True if this handler blocks the turn until it returns (waits for user
   * input). Drives conversation flow: interactive tool-call handlers serialize
   * the agent loop; interactive inline handlers abort the stream and restart.
   */
  interactive: boolean
  /**
   * Optional cosmetic glyph rendered next to the tool name in transcript
   * headers. Only meaningful when `trigger.type === "tool"`. Purely visual —
   * never sent to the model. Pick a single-cell character (nerd-font glyphs
   * work) so the header stays aligned.
   */
  icon?: string
  /**
   * Optional palette color for the tool's label in transcript headers.
   * Only meaningful when `trigger.type === "tool"`. Allowed values match
   * `ToolColor` in `src/tools.ts` (e.g. `"cyan"`, `"orange"`). Purely
   * visual — never sent to the model.
   */
  color?: string
}

/** Trigger variant tag. */
export type ManifestTrigger =
  | {
      type: "tool"
      tool: {
        name: string
        description: string
        input_schema: Record<string, unknown>
        /**
         * Optional alternate names this tool also responds to. Aliases are
         * NOT advertised to the model — `getExtraTools()` only emits the
         * canonical `name`. Their sole job is to silently catch tool calls
         * the model emits with an old/legacy name (resumed history,
         * user-typed names, training muscle memory) and route them to the
         * canonical handler. The model-facing tool list, the JSONL log,
         * and the transcript all see whatever name was emitted; aliases
         * never mutate content or display. See `dispatch()` in
         * `src/plugins/loader.ts`.
         *
         * Validation:
         *   - each alias is a non-empty string
         *   - no alias equals the canonical name (would be a no-op)
         *   - no two aliases in the same array are equal
         *   - alias names follow the same regex as core tool names
         *     (alphanumerics + `_-`)
         *
         * Cross-plugin collision (alias vs another canonical, alias vs
         * another alias, alias vs core tool name) is checked at load time
         * in the loader and rejects the offending plugin entirely.
         */
        aliases?: string[]
      }
    }
  | {
      type: "inline_tag"
      /**
       * Tag name matched against `<tui::NAME ...>`.
       *
       * NAME must match `[a-z0-9][a-z0-9_-]*` (kebab/snake lowercase). The
       * loader rejects anything else.
       */
      tag: string
    }

/** Handler entry variant tag (module or subprocess). */
export type ManifestHandlerEntry =
  | {
      type: "module"
      /** Relative path to a TS file with a default async export. */
      path: string
      /** Export name. Default and only supported value for now: "default". */
      export?: "default"
    }
  | {
      type: "subprocess"
      /** argv. First element is the executable (relative or absolute). */
      command: string[]
    }

// ---------------------------------------------------------------------------
// Loaded plugin (internal runtime form)
// ---------------------------------------------------------------------------

/**
 * A plugin package after manifest parse and handler resolution.
 *
 * This is the internal runtime form used by the loader. Plugin authors
 * never construct or observe this type directly.
 */
export interface LoadedPlugin {
  /** Absolute path to the package directory. */
  packageDir: string
  /** Which root the package came from. */
  root: "embedded" | "home" | "project"
  /** Parsed manifest (validated). */
  manifest: ManifestFile
  /** Handlers resolved to invocable form. Order matches manifest `tuis` order. */
  handlers: ResolvedHandler[]
  /**
   * Event subscriptions resolved to invocable form. Order matches the
   * manifest's `events` order. Empty when the manifest declares none.
   */
  eventSubs: ResolvedEventSub[]
  /**
   * Hook subscriptions resolved to invocable form. Order matches the
   * manifest's `hooks` order. Empty when the manifest declares none.
   */
  hookSubs: ResolvedHookSub[]
  /**
   * Live-area slots resolved to invocable form. Order matches the
   * manifest's `liveAreaSlots` order. Empty when none declared.
   */
  liveAreaSlots: ResolvedLiveAreaSlot[]
  /** Contents of the plugin's PROMPT.md, or null if absent. */
  prompt: string | null
}

/**
 * A manifest live-area slot paired with its resolved handler entry.
 *
 * The loader produces these at load time. The REPL's live-area
 * scheduler drives them on a fixed interval; producers receive a
 * {@link LiveAreaHandlerContext} and return either the line to render,
 * `null` to clear, or throw to clear-and-log.
 */
export interface ResolvedLiveAreaSlot {
  /** The original manifest entry (with normalized defaults applied). */
  definition: ManifestLiveAreaSlot
  /** Plugin id this slot belongs to (for labeling / diagnostics). */
  pluginId: string
  /** Absolute path to the package directory (the slot's `cwd` for subprocess). */
  packageDir: string
  /** Absolute path to the handler entry (module path or executable). */
  entryAbsolute: string
  /** Invokes the producer once. */
  invoke: (ctx: LiveAreaHandlerContext) => Promise<string | null>
}

/**
 * A manifest hook subscription paired with its resolved handler entry.
 *
 * Unlike {@link ResolvedEventSub}, hooks may participate in chain
 * dispatch (return values matter) or stream dispatch (the handler
 * receives an `AsyncIterable`). The loader narrows this at register
 * time based on the channel's shape.
 */
export interface ResolvedHookSub {
  definition: ManifestHookSubscription
  entryAbsolute: string
  /**
   * The user handler is invoked through this thunk; the loader passes
   * the hook payload (or stream) plus a hook context. Return is the
   * raw user return — the loader interprets it for chain channels.
   */
  invoke: (payload: unknown, ctx: HookHandlerContext) => unknown
}

/**
 * Runtime context passed to a hook-subscription handler.
 *
 * Mirrors {@link EventHandlerContext} but adds the `channel` name and
 * the listener's resolved `priority` for diagnostics.
 */
export interface HookHandlerContext {
  /** Channel name being dispatched. */
  channel: string
  /** Plugin package directory (absolute). */
  packageDir: string
  /** The agent's current working directory. */
  cwd: string
  /** Plugin-scoped environment. */
  env: Record<string, string>
  /** Aborts when the bus disposes. */
  abort: AbortSignal
  /** Resolved priority (post-clamping). */
  priority: number
  /** Diagnostic stream. */
  stderr: NodeJS.WriteStream
}

/**
 * A manifest event subscription paired with its resolved handler entry.
 *
 * The loader registers `invoke` on the bus at load time; the bus calls
 * back per event. Errors and timeouts are absorbed by the bus so the
 * agent never sees a plugin exception.
 */
export interface ResolvedEventSub {
  /** Same as `ManifestEventSubscription` from the manifest. */
  definition: ManifestEventSubscription
  /** Absolute path of the handler entry (for module) or executable (for subprocess). */
  entryAbsolute: string
  /** Invoke the user's event handler with a built {@link EventHandlerContext}. */
  invoke: (ctx: EventHandlerContext) => void | Promise<void>
}

/**
 * A manifest handler paired with its resolved entry point.
 *
 * For module handlers, `invoke` dynamically imports the path and calls the
 * default export. For subprocess handlers, `invoke` spawns the command with
 * the stdio protocol from the spec.
 */
export interface ResolvedHandler {
  /** Same as `ManifestHandler` from the manifest, narrowed for convenience. */
  definition: ManifestHandler
  /** Absolute path of the handler entry (for module) or executable (for subprocess). */
  entryAbsolute: string
  /**
   * Invoke the handler. The loader wires timeout and abort handling around
   * this call; handlers themselves just await whatever the user wrote.
   */
  invoke: (ctx: TUIContext) => Promise<TUIResult>
}
