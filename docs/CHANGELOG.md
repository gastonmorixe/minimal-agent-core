---
project: "minimal-agent"
title: "Changelog"
type: changelog
status: living
created-at: "2026-05-01T00:00:00-0400"
updated-at: "2026-11-18T00:00:00-0500"
format: "Keep a Changelog (pragmatic, date-stamped)"
latest-unreleased:
  - id: "2026-11-18-session-plugin-scope"
    type: fix
    status: landed
    detail: "A host with many sessions in one process (the web host) gives each session its own plugin scope: openSession({ pluginScope: { version } }). Each run of that session runs in an AsyncLocalStorage session scope (infra/session-scope.ts). In it, a plugin tool dispatch gives ctx.agent, ctx.env MINIMAL_AGENT_*, queryModelInfo, recommendSubagentModels, queryTarget and host.sessionInfo.tokens of THIS session from its live AgentCore; event and hook handlers get its agent; addSessionUsage also folds into the session's own SessionTokenCounter; net-dbg records into a folder named by the session id; the transport sends the session id as the provider conversation id. Why: in the web host SessionInfo and ModelInfo reported the boot default model (deepseek-v4.1-flash / opencode-zen) in a cursor session, the process sid or 'unknown', and the usage of every session together, and two sessions shared one net-dbg folder (owner, 11-18). A session without pluginScope (the CLI) changes nothing: the loader values and the process counters stay as before."
  - id: "2026-11-18-prompt-cache-anchor-append-only"
    type: feat
    status: landed
    detail: "Prompt-cache fix, behind flags that are OFF by default, so request bodies stay byte-identical to before. (1) Anchor: a second rolling cache_control marker on the message before the latest assistant turn (MINIMAL_AGENT_CACHE_ANCHOR, --cache-anchor, config cacheAnchor). (2) Cap: at most 4 cache_control markers in the final Anthropic body; the anchor is dropped first, the tail never. No effect today (the maximum is 3+1). (3) Append-only thinking for keep-all Anthropic models (MINIMAL_AGENT_THINKING_HISTORY=keep, --thinking-history keep, config thinkingHistory); the default stays strip. (4) Recovery: a 400 about modified thinking or its signature retries the same turn once with strip, and latches strip for the session. Why: stripStaleThinking removed thinking from older assistant messages on every request, so the previous request's prefix never matched and a long tool loop read 0 cached tokens (about 2.1M tokens written in 11 requests in one session). Live A/B on Haiku 5.5: keep + anchor is 40-44% of today's cost with 0 cache misses and 0 400s. Open: sub-agent flag inheritance, the strip-mode gap, keep plus compaction, and a large-body live gate before keep can be the default."
  - id: "2026-11-18-tool-result-text-rendered-by-core"
    type: feat
    status: landed
    detail: "Erratum E8, owner rule 5. The stage contract (experimental) changes: for a registered kind core now renders the text of a plugin annotation from kind, attrs and body, and overwrites the text that the plugin gave. The body is neutralized first with the codec of the sideband registry. A render failure drops that one annotation with the diagnostic tool-result-chain.sideband-render-failed (cause throw, non-string or no-codec); the rest of the stage result stays. The caps count the rendered text. A body field above 2048 bytes drops the stage result (reason size). The tool round gets the codec through a new optional ToolRoundContext.sideband that the executor adapter builds from the sideband registry (createTextRenderer). The stage context stays {signal}. No model-byte change for existing plugins: none returns annotations today."
  - id: "2026-11-18-resume-waits-for-user"
    type: fix
    status: landed
    detail: "A resumed session never continues an unfinished turn by itself. noteSessionResumed() (the /continue command) now continues a turn that a crash, a kill or a pause left unfinished (a round checkpoint with round > 0), at its next round, the same as run(_, { resume: true }): no new user turn and no resumed marker. With no unfinished turn it keeps the resumed-marker turn. A new message instead starts a new turn at round 1, and that turn clears the checkpoint when it settles. The lastTurnRoundCheckpoint doc says a host must wait for the user. The CLI part (cli fix/resume-waits-for-user) removes the automatic continue before the REPL mounts and from --prompt runs, and shows a /continue hint"
  - id: "2026-11-18-second-clamp-grown-blob"
    type: feat
    status: landed
    detail: "Milestone M3c, step C. When a pre-outcome or post-blob stage grows the text and the second clamp cuts it, core now writes the grown text (the body before the cut, with no footer and no notice) to <toolUseId>_grown.raw in the blob store, and the raw-output annotation points to it. An existing raw-output annotation of the first blob is replaced in place; if there is none, it is added right after output-truncated. The output-preview path and the rawPath of the session record also point to the grown file. The first blob file is not changed. The same guards as the first blob apply: no store, a skip-list tool, an aborted call, a text under the minimum, or a failed write keep the old behavior (cut text and notice, no blob). No stage means no change; the 51 request goldens do not change. No plugin in the repos declares stages, so no live path reaches this today. The blob id is `<id>_grown` (an underscore, not a dot), so the host capability blobs:read lists it and can read it (its id rule is ^[A-Za-z0-9_-]+$); a test checks that a listed id is readable. Known limits: (1) the outcome event that the host already got keeps the old truncInfo; (2) with a very small maxBlobsPerSession (1) the grown write evicts the first blob of the same call, but the raw-output footer and the session record cite the grown file, so no cited path is lost; (3) the session blob count (countBlobs in sessions-read.ts) counts every .raw file, so it rises by one for each call with a grown blob; (4) the persisted record keeps its existing optional fields rawPath, rawBytes and rawSha256 and only their values change (they point to the grown file); no field is added, and an older build reads the same fields; (5) after a chain phase the tool_result is_error is the stage outcome value (false), and with no stage it stays undefined when the tool gives none (lead decision Q5); nothing in the repos compares it with === false."
  - id: "2026-11-18-tool-outcome-readers"
    type: feat
    status: landed
    detail: "Milestone M3 (core part). Additive. The tool_result event of the SDK (ToolResultEvent) and the wire event carry two optional metadata fields: data (the structured data of the tool outcome) and annotations (each one has the kind and the attrs only, never offsets or text). A key is absent when there is nothing to report, so an existing event snapshot and a consumer that ignores the new keys do not change; the stream-json tool_result line carries them when present (for example output-preview with shown, total and tool). New leaf export viewPersistedOutcome and the type OutcomeView in plugin-api (plugin-api/src/types/tool-outcome-view.ts): the guarded reader of a stored outcome. It checks the offsets against the content (D8 rule 1), never throws, and returns undefined when the offsets do not fit, for example after an attachment that a model cannot take became a placeholder text block; a reader then keeps its own text reading. ToolViewOutcome (the host view port) gets an optional outcome {bodyEnd, annotations: [{kind, attrs?, start, end}], data?}, built from finalizeOutcome in the tool round and omitted when the final text differs from the joined outcome. The model-facing bytes do not change (the request goldens are unchanged). The tool-outcome host golden (src/agent/tool-outcome.golden.json) gained the new keys: the model part is equal, and the events differ only by the added outcome blocks and one annotations key on the stream-json route line"
  - id: "2026-11-18-tool-output-clamp-surrogate"
    type: fix
    status: landed
    detail: "Milestone M3c, core part (steps 4a and 4b). The per-line clamp (8192 UTF-16 units) no longer splits a surrogate pair. When the high unit is the last kept unit and the low unit follows, the kept text has one unit less (maxChars - 1), and the marker \"...(+Nch)\" shows the real number of removed units. Every other line is byte-equal to before (lone surrogates, a pair that ends at the cap, ASCII). A fuzz test against the old function (8000 seeded cases, 768 split cases) proves it. No request golden holds a per-line marker, so no golden changes. The clamp facts now include totalLinesKnown (true when the caller gave the total lines, false when core measured them). The notice renderer sends cutMidLine, longLines, lineCharCap, lastLinePartial, nextOffset and totalLinesKnown to the text kind as optional facts. An older text plugin ignores them, so the notice bytes do not change. The output-truncated annotation attrs carry totalLinesKnown. Known issue K1 (not changed): in the Read notice, shown bytes count the numbered text and total bytes count the raw file."
  - id: "2026-11-18-read-truncation-notice-text"
    type: fix
    status: landed
    detail: "Milestone M3c, step 4c (text part, in the plugin ma-core-tools-plugin; core changes only 2 test pins). The Read truncation notice text changes in 3 cases. A: only the per-line clamp cut text (every line is shown, no byte cut inside a line): the notice says that all lines are shown, how many long lines the harness cut and at about how many characters, and sends the model to Grep or Bash with cut -c (no offset hint; the old text pointed at an offset past the end). B: the byte cut is inside a line: the hint says that the line is partial and gives the new offset, which shows that line again from its start. Unknown total (totalLinesKnown false): no offset hint and no line count. Order of the checks: unknown total, A, B, else the old text. A normal byte cut at a line end keeps the old text byte for byte. Other tools keep their text. An old core that does not send the new facts keeps the old text for every case. Two new request goldens (read-truncated-long-lines, read-truncated-partial-line); no existing golden changes. The 2 core test pins of the 73/73 case now hold the case A text. The real Read tool always sets the total lines, so unknown total cannot happen with the real Read tool (tested on the provider with facts only). Known issue K1 (not changed, M3e): the units of shown bytes (numbered text) and total bytes (raw file) in the notice differ."
  - id: "2026-11-17-tool-outcome-persisted"
    type: feat
    status: landed
    detail: "Milestone M2. A tool_result session record can carry an optional outcome (SPEC D8): {v: 1, bodyEnd, annotations: [{kind, attrs?, start, end}], data?, schema?}. It holds offsets into the model text and no text of its own. The tool round builds it with attachPersistedOutcome and passes it as the 4th argument of SessionStore.appendToolResult. The converter uses the one join of finalizeOutcome and writes no record when its text differs from the block text. Plugin spans use the same caps at write and at restore (8 spans per outcome, 2048 bytes per text, 8192 bytes per outcome with attrs, 16 attrs, 256 bytes per attr string); a core span text above 4096 bytes drops the record; data above 16000 UTF-8 bytes is dropped with one diagnostic. Restore never throws on bad stored data: it checks the record against the restored text and drops a bad record or span with a diagnostic. A record written before M2 loads as before. The SDK path (runToolCalls) checks the outcome again against the final result content, so a host wrapper that changes the content gets no outcome. The plugin id core is reserved: a plugin package with that id is skipped with a diagnostic, and the registry refuses a plugin sideband kind with a core kind name (rule core-kind). Wire encoders send the model text only: block.outcome and block.sideband never reach a request (plugin-api/src/llm canonical messages, openai-chat, anthropic-request). The record has no owner field (the owner follows from the kind). Known limits: one over-cap diagnostics span drops the whole record (W3: drop only that span); the persisted outcome is checked 3 times on the CLI path (attach, runToolCalls, persistence), each check capped by the same limits"
  - id: "2026-11-17-tool-outcome-stages"
    type: feat
    status: landed
    detail: "Milestone M1 (core part). BREAKING for tool-result transform stages (EXPERIMENTAL API; no plugin in minimal-agent-plugins declares toolResultTransforms). A stage now gets and returns a ToolOutcome {body, annotations, ...}, not the flat fields. TOOL_OUTCOME_FIELD_TABLE sets the type check, the merge and the read-only fields. A missing key keeps the input value, and the same value is not a change. A wrong type (reason shape) or a change to a read-only field (reason field-readonly) drops the whole stage result. Owner rules (reason owner): a stage cannot remove, change, reorder or forge an annotation of another owner, or add a core kind. The plugin id core is reserved: a stage with the plugin id core, an empty id, or an id that breaks the plugin manifest id rule (ID_RE) never runs (so an id such as beh_one runs, and core\\u200b does not). Plugin annotation limits: join is only \"\\n\\n\", \"\\n\" or \"\"; attrs are strings, finite numbers or booleans (NaN and Infinity give shape), and attr keys follow the sideband name rule; 8 annotations per outcome for all plugins together, 2048 bytes per text, 8192 bytes per outcome with attrs, 16 attrs, 256 bytes per attr string (reason shape or size). An annotation with an unknown or unregistered kind is dropped alone, and the rest of the stage result applies (at most one tool-result-chain.sideband-dropped diagnostic per stage call). New root export CORE_ANNOTATION_KINDS. New pure joinOutcome/finalizeOutcome (one join rule for core and persistence). The truncation clamp now returns typed facts (kept, notice, info, facts) inside core; the exported truncation API and the notice bytes do not change. The tool round builds a ToolOutcome on every path and the block text is finalize(outcome); the temporary glue adapter is removed (M1 part U4). The model-facing bytes do not change (51 request goldens equal; 6004-case fuzz probe of the clamp, 0 differences)"
  - id: "2026-11-17-tool-outcome-round"
    type: feat
    status: landed
    detail: "Milestone M1 (part U4). A second clamp runs after the pre-outcome phase when a stage makes the body text longer than the limit; the output-truncated annotation is replaced in place or added first. The text above the limit is not saved in a blob (follow-up). The mode stamp comes from ModeManager.activeStampFacts() (one clock read for the facts and the text). ToolFeedbackTracker has a new read-only streakThreshold getter. The model-facing bytes do not change (51 request goldens equal; U3 shadow parity 51/51, 0 mismatch)."
  - id: "2026-11-17-target-switch-anytime"
    type: feat
    status: landed
    detail: "BREAKING for hosts that relied on the old contract. Each change of the live target (switchTarget, setModel, setEffort) now ends a retry or quota wait with no turn abort, builds the system prompt again, and discards the thinking from before the change. New session record target_switch. See the Added entry."
  - id: "2026-11-17-tool-result-chain-active"
    type: feat
    status: landed
    detail: "Milestone M0. The tool-result transform chain is now active in production. The loader collects toolResultTransforms from the manifests. It builds the sideband registry from the sideband kinds and sidebandCodec. It validates the chain at load. The tool round runs the 5 phases in this order: clamp, pre-outcome, post-blob, final, stamp. Each stage fails open: it gets a frozen copy, and a throw, a timeout or a bad result keeps the input of the stage. Each stage has a time limit of 2000 ms. A manifest or decl timeoutMs can lower it. The stage gets the turn abort signal in a second ctx argument. The live history keeps block.sideband. Encoders never send it. The model-facing bytes do not change (the request goldens are unchanged). The API is EXPERIMENTAL: the stage shape changes in the next release, when ToolOutcome (body, annotations) replaces the flat fields"
  - id: "2026-11-16-compact-errors-typed"
    type: refactor
    status: landed
    detail: "BREAKING (core-prompts decouple 15e.3, rows c3..c10). Core holds no compaction error or fallback text. New CoreErrors in ./errors (message \"\", facts only): CompactBusyError (a compaction of the same history is in progress; was Error \"compact aborted: compact already in progress\"), CompactRaceError (history changed during the compaction), CompactModeUnsupportedError {mode: fork} (was Error \"compact fork: ...\"), CompactSendPolicyError {errorName} (the message.willSend port threw; was Error \"send policy hook threw <name>\"), CompactSummaryStreamError {retryable, category?, upstreamType?, detail?, status?: 401} with the stream cause (was Error \"local summary stream error (retryable=...)\"). ./host/compact-contract: CompactStats.remoteError and summaryError are now CompactFailure {code: send_denied | remote_unavailable | unknown_model | empty_summary | request_failed, reason?, model?, error? (CoreErrorJson), detail?} (were strings). parseCompactArgs returns error: CompactArgsError {code: duplicate_mode | unknown_argument | unknown_mode | bad_tail, token, value?} (was a string); new exported types CompactFailure, CompactArgsError, ParsedCompactArgs. Session notes from runCompact are key=value log lines built from the facts (for example \"compact: remote fallback=local code=remote_unavailable\", \"compact: summary fallback=stub code=send_denied reason=...\"). The fallback, retry (retryable flag), 401 recovery and throw paths take the same decisions as before. CompactSummaryStreamError.status is 401 when the stream cause is a 401 by is401 (status/opts.status 401 or AuthError) or its message names HTTP 401 (the old message test, now a superset). Two visible changes: (a) the CLI /compact footer (\"remote unavailable: ...\" / \"summary failed: ...\") now shows for a CoreError cause; the old code stored err.message, which is \"\" for a CoreError, so the footer was skipped. (b) classifyError tags a connection-level cause (for example socket hang up, ECONNRESET) as network_error in place on the error object, so a request_failed CompactFailure.error can carry fields.streamErrorType \"network_error\", and the session note shows it in its error= JSON. The local-stub stats note nests the failure as remoteError.code=... / summaryError.code=... (for example \"compact: local reason=manual messages 4->2 summaryError.code=unknown_model model=...\"). compact.pending_failed errorKind is now the kind (for example CompactModeUnsupportedError, was Error). Hosts render the kinds and codes (CLI core-text.ts: coreCompactErrorRenderer, compactFailureText, compactArgsErrorText; the /compact argv texts keep their old bytes)"
  - id: "2026-11-16-lifecycle-denied-error"
    type: refactor
    status: landed
    detail: "BREAKING (core-prompts decouple 15e.2, Q6, spec R-ERR-CLS-9). Core holds no default lifecycle deny text. New LifecycleDeniedError (./errors), a CoreError with fields hook (turn.willStart | message.willSend | tool.willInvoke | tool.didBatch | compact.willRun | subagent.willSpawn), reason? (the plugin reason, absent when empty), pluginId?, tool?, failure? ({label?, detail} of a failed failClosed listener) and additionalContext. It replaces LifecycleSendDeniedError (removed from src/sdk/with-lifecycle-send.ts): a message.willSend deny now throws LifecycleDeniedError, a compact.willRun deny throws it (was a plain Error with the reason as message), and a tool.didBatch deny emits an error event with error {kind, fields} and message \"\". ./sdk/ports and ./sdk/lifecycle: the chainResultToDecision default deny reason is now \"\" (was \"Blocked by lifecycle policy hook.\"); PolicyDecision deny/ask get optional pluginId and failure facts (type DenyFailure); ./sdk/lifecycle has the new deniedError(hook, decision). The adapter default texts (Turn/Send/Compact/Sub-agent spawn blocked by lifecycle policy hook., Agentic loop stopped by tool.didBatch hook., The approval hook failed (...)) and the HookBus failClosed reason (Denied: approval hook ... failed (...)) are removed: ChainEmitResult keeps failed and failure, reason is absent. The deny is decided by the decision action, never by reason text. Hosts render the kind (CLI core-text.ts, web chat-stream adapter). Every error event for a CoreError (this deny, CompactNoProviderError, the auth kinds) has message \"\" and carries error {kind, fields}: a consumer of event.message must read event.error (ma-acp-plugin and ma-sub-agents-plugin do). The tool.didBatch turnEnd error is the reason, else \"tool.didBatch\". The api.recovery-failed diagnostic shows a CoreError as its kind and JSON fields (recoveryErrorText in src/llm/transport/retry.ts), not only the class name"
  - id: "2026-11-16-schema-errors-structured"
    type: refactor
    status: landed
    detail: "BREAKING (core-prompts decouple 15e.1b, Q8). ./sdk/output-schema: validateJsonAnswer is removed (no caller; the CLI has its own check in src/oneshot/json-schema-check.ts). validateAgainstSchema now returns structured errors: ValidationResult.errors is SchemaError[] ({path, rule: enum | type | required | additional, key?, expected?, got?}), not message strings. Core holds no validator prose. tool_result.invalid_input facts are now tool, count and flat indexed per-error facts path.i, rule.i, key.i, expected.i (type tokens joined with ,), got.i (was tool, detail). ma-turn-recovery-plugin rebuilds the same text, so request bytes do not change. parseSchemaFile is unchanged"
  - id: "2026-11-15-network-observe-capability"
    type: feat
    status: landed
    detail: "New capability token network:observe. A plugin that declares it gets ctx.host.network.observe(observer), which returns a stop function. The observer (NetworkWireObserver in ./plugin-api/net/types: onRequest, onResponse, onChunk, onEnd, onError) sees the raw traffic of the host network client for every provider, before any adapter parses the response. It cannot change traffic: the request and response are frozen copies and each chunk is a private copy. It cannot break a request: a callback that throws emits one network.wire-observer warn and the request continues. It sees what net-dbg records, no more: redactHeaders and redactBody apply, and a request with capture.responseBody false sends no chunks. New NetworkClient.addObserver(observer) returns a remove function and appends after the built-in observers, so net-dbg records a chunk first. The observer list is a copy-on-write holder shared with withRequestDiagnostics views. New src/network/wire-observer.ts (createWireObserver, createNetworkObserveApi), exported from ./host/network. BuildHostOptions takes networkClient and pluginName. captureRequestBody is exported from src/network/net-dbg-observer.ts"
  - id: "2026-11-12-embedded-plugin-source"
    type: feat
    status: landed
    detail: "New src/plugins/source.ts: PluginPackage (name, dir, root, kind disk|embedded, resolve, readText, importModule, hasFile, execPath) with a disk implementation that keeps the old existsSync/readFileSync/import(abs) behavior, and an embedded implementation over a registered EmbeddedPluginTable ({ buildId, packages: { <dir name>: { texts, modules, files } } }, keys normalized by normalizePackagePath). New public subpath ./host-kit/embedded-plugins: registerEmbeddedPlugins(table, { cacheRoot? }), clearEmbeddedPlugins, hasEmbeddedPlugins, embeddedPluginPackages, pluginPackageFor, materializeEmbedded(pkg, rel, { mode? }) (readFileSync + tmp write + chmod + rename into <agentHome>/cache/embedded/<buildId>/<pkg>/<rel>, mode 0755, reused when size and mode match), pruneEmbeddedCache, findEmbeddedScript(<manifest id>/<name>). The registered table is the lowest-precedence source (after every disk root of the embedded tier), so project and user copies of an id win. Discovery, the catalog, the CLI command loader, provider discovery (registerDiscoveredProviders adds embedded providers after every root, new discoverEmbeddedProviderPlugins) and every loader stage (tools, events, hooks, commands, setup, fragments, host modes, replay renderers, turn attachments, error renderers, promptTemplate) read plugin files through PluginPackage. An embedded package's ctx.packageDir is its real cache dir. Manifest: new optional scripts map (name to relative path, name forms a valid self-spawn id with the manifest id), exposed as ManifestFile.scripts"
  - id: "2026-11-12-self-spawn"
    type: feat
    status: landed
    detail: "New ./plugin-api/utils/self-spawn: selfSpawn() returns { agent(), script(id, devPath), childEnv(env?) }, plus isStandaloneExecutable, childEnv, isValidScriptId, assertScriptId, SCRIPT_ID_RE, BUN_BE_BUN_ENV, AGENT_BIN_ENV, RUN_SCRIPT_ARG and SelfSpawnOptions (argv, execPath, standalone, env seams). From source agent() is [execPath, argv[1]] and script() is [execPath, devPath]. In a compiled binary agent() is [execPath] and script() is [execPath, __run, id]. MINIMAL_AGENT_BIN (split on whitespace) overrides agent() in both modes. A script id is <plugin-id>/<name>, each part [a-z0-9][a-z0-9_-]*. A bad id or a relative devPath throws. childEnv copies env and drops BUN_BE_BUN and undefined values. isStandaloneExecutable moved here, src/plugins/loader/host-core-resolver.ts re-exports it. BUN_BE_BUN no longer reaches a user command: the Bash tool env, buildHandlerEnv (ctx.env of every plugin handler), and the tool, event and prompt-fragment subprocess spawns all pass through childEnv"
  - id: "2026-11-11-retry-boundary-event"
    type: feat
    status: landed
    detail: "S14.4. New AgentEvent retry-boundary { type, id, attempt } (./sdk/events). It marks the start of a retry after streamed text. id is the text block id of the turn (for example 1:text). attempt is the attempt that starts next. It is opt-in with the run option emitDeltas, like text_delta. It is not in the stream-json kinds: the CLI writes a text_delta line for it. Core holds no marker text any more: retryStallMarker is removed from core and from withRetry, and AgentCore.run no longer yields the marker string. A host renders the boundary itself (the CLI prints the same bytes as before in the REPL, the open-responses stream and stream-json). Three accepted behavior changes: (a) a run without emitDeltas (print mode) shows no marker after a retry. (b) finalText and the --output-schema check input hold no marker. (c) the llm.complete result of the plugin host factory holds no marker"
  - id: "2026-11-11-per-run-output-schema-temperature"
    type: feat
    status: landed
    detail: "AgentCore.run takes per-run outputSchema, temperature and outputStrict. New one-shot setters for the next run: setNextRunOutputSchema, setNextRunTemperature, setNextRunOutputStrict. New setOutputStrict sets the session value. A per-run value lives for that run only. The temperature goes on a request only when the model registry entry accepts it. Else the run sends none and emits one agent.temperature-ignored warn. strict goes into outputConfig.format only with a schema. A model with structuredOutputs false gets one llm.strict-unsupported warn per run. The run never fails for either. ./host-kit/build-agent-core: buildAgentCore and openAgentCoreSession take outputStrict and appendSystemPrompt. The append text lands after the instructions and the plugin after-instructions text, and it is folded into systemHash, so a resume with other text shows drift. sendOptionsToCanonical sets outputFormat.name from the schema title (only [a-zA-Z0-9_-], max 64, default output) and passes strict. ./host/host-mode: HostSession.run takes HostRunOptions (outputSchema, temperature, outputStrict). HostRuntime.openSession takes HostOpenSessionOptions with systemPrompt { mode: append | override, text }. New modules src/sdk/run-temperature.ts (resolveMaxOutputTokens moved there) and src/sdk/run-output-strict.ts"
  - id: "2026-11-11-provider-structured-output-format"
    type: fix
    status: landed
    detail: "./plugin-api/llm: CanonicalRequest gets purpose?: title, the explicit marker of the internal title probe. Anthropic classifyRequest returns title only for that marker. Before, every json_schema request with no tools counted as a title probe, so a user schema run lost the default effort. output_config.format is now exactly { type: json_schema, schema } (no name, no strict). A tool with strict: true sends strict: true. OpenAI Chat: json_schema.name keeps only [a-zA-Z0-9_-], max 64 chars, default output (was response). strict: true goes on the wire only when the request asks for it and the model has structuredOutputs. New exports sanitizeSchemaName and wantsStrictSchema"
  - id: "2026-11-11-send-request-view"
    type: feat
    status: landed
    detail: "message.willSend: SendSnapshot (./sdk/lifecycle) gets two optional fields. request is a read-only SendRequestView of requestType, tools, maxTokens, thinking, outputConfig and temperature. compact is true on a compaction send. A listener can read them (for example a dry-run dump). Changes to them are ignored: only messages and system stay rewritable. New export requestView(opts) in src/sdk/with-lifecycle-send.ts. Plugin host: ModelsReadApi gets findForProvider(idOrAlias, providerId), a provider-scoped lookup with no cross-provider fallback (find stays last-write-wins)"
  - id: "2026-11-11-plugin-prompt-suppression"
    type: feat
    status: landed
    detail: "Per-plugin prompt-text suppression. New public subpath ./host/plugin-prompt-resolution (resolvePluginPromptSuppression, isPluginPromptSuppressed, NO_PLUGIN_PROMPT_SUPPRESSION, PluginPromptSuppression, PluginPromptsConfigValue). PluginLoader.load and bootHost (./host-kit/host-boot) take a new pluginPrompts option. A suppressed plugin still loads, advertises its tools and runs its prompt fragments. Only its text (PROMPT.md body, sessionContext and afterInstructions fragments) is dropped. bootHost resolves the config, then MINIMAL_AGENT_PLUGIN_PROMPTS. An explicit pluginPrompts wins. ./host/config: new UserConfig.plugins.prompts (false, true, or { all, keep, suppress }) and loadPluginPromptsConfig(). The plugin id prompts is reserved: parseManifest throws the new ReservedPluginIdError (RESERVED_PLUGIN_IDS), discovery rethrows it, and the load fails. See docs/plugin-prompt-architecture.md"
  - id: "2026-11-11-presentation-subpaths-leave-core"
    type: refactor
    status: landed
    detail: "BREAKING (S29, S41 follow-up). Terminal presentation left core; the CLI owns it with the same API. Removed subpaths: ./host/tool-time (fmtToolTime, ToolTimeTracker; CLI src/ui/tool-transcript/tool-time.ts), ./host/quota-summary (formatQuotaWindows; CLI src/ui/chrome/quota-summary.ts), ./host/queue-restore (formatRestoredMessages; CLI src/editor/queue-restore.ts), ./host/truncate-hint (truncHint; CLI src/ui/style/truncate-hint.ts, clampWithHint stays private in core for the debug dump). ./host/session-artifacts loses formatSessionArtifacts (CLI src/commands/session-artifacts-format.ts), inspectSessionArtifacts stays. ./host/config: UserConfig drops the terminal keys spinner, formatter, formatterArgs, header, autoAsk, skipQuota, nerdGlyphCells, scrollback and the plugin key statusBar. loadUserConfig ignores them like any unknown key, and SubmittedAtStyle and normalizeSubmittedAtStyle are removed. The CLI reads those keys from the same file (src/config/terminal-config.ts); the quota-status plugin already read statusBar itself. ./host-kit/auto-plugins: bootstrapUserPlugins drops the styles, showSpinner, and spinnerFactory options and the BootstrapSpinner types; the result label is plain text. QuotaWindow and QuotaSnapshot stay in ./plugin-api/llm/provider-plugin. ./host/paste-intercept stays (media ingestion, not rendering). New public-api.test.ts guard: no terminal presentation subpath (tool-time, quota-summary, queue-restore, truncate-hint, ansi, palette, unified-diff) may come back"
  - id: "2026-11-02-version-static-import"
    type: feat
    status: landed
    detail: "AGENT_VERSION (./host/build-info) comes from a static JSON import of package.json, not a file read at module load. A bun build --compile binary reports the same version as a run from source. A missing package.json is now a build error, not a 0.0.0 fallback. New export manifestVersion(manifest)"
  - id: "2026-11-02-embedded-core-prompts"
    type: feat
    status: landed
    detail: "Core prompt .md files are imported as text in src/prompts/embedded.ts. loadPromptText serves core prompt paths (the source dir, or /$bunfs/prompts/<key> in a compiled binary) from that map, so a bun build --compile binary needs no src/prompts on disk. Plugin prompt paths still read from disk. A new core prompt file needs an entry in embedded.ts. A test in prompts.test.ts fails when the map and the files differ"
  - id: "2026-11-02-host-core-static-module-map"
    type: feat
    status: landed
    detail: "The host-core resolver serves each public subpath from src/plugins/loader/host-core-modules.ts, a generated map with one static require() per exports entry. It resolves no export by package name at run time, so it works inside a bun build --compile binary, and the bundler embeds every public module for plugins on disk. New script: bun run gen:host-core-modules (--check to verify). A test in host-core-resolver.test.ts fails when the map and the exports map differ"
  - id: "2026-11-02-fetch-account-plan"
    type: feat
    status: landed
    detail: "New optional ProviderPlugin.fetchAccountPlan(auth, ctx?) hook (./plugin-api/llm/provider-plugin). It reads the plan, seat, role, and usage windows of one stored credential from the provider's account endpoints and spends no model quota. It resolves null for an auth kind the provider cannot inspect. New contract types AccountPlanInfo and AccountPlanContext, also re-exported from ./host/provider-plugin"
  - id: "2026-11-01-host-boot-credential-name"
    type: feat
    status: landed
    detail: "./host-kit/host-boot: BootedHost.resolveAuth(modelId, providerId?, credentialName?) takes an optional stored credential name and passes it to resolveStartupAuth. New BootedHost.listCredentials() lists the stored credentials by provider (one entry per credential). CredentialedProvider is re-exported from ./host-kit/host-boot. The no-credentials error and storedProvidersHint name each provider once"
  - id: "2026-11-01-s24-loops-move"
    type: refactor
    status: landed
    detail: "S24 file moves, no behavior change. executeToolRound moved from src/agent/tool-round.ts to src/loops/tool-round.ts. The tool executor adapter (src/adapters/tool-executor-adapter.ts) and the build step (src/adapters/build-agent-core.ts) are now one file, src/loops/assemble.ts. The output-preview tag and hint text moved from src/tools/PROMPTS.ts to src/prompts/runtime/output-preview*.tmpl.md. Public subpath names and their export names do not change (./host-kit/build-agent-core, ./host-kit/tool-executor-adapter). Model and JSON-route bytes do not change"
  - id: "2026-11-01-s24-s29-tool-view-events"
    type: refactor
    status: landed
    detail: "BREAKING (S24, S29): the tool round builds no transcript rows and reads no terminal size. New ToolViewPort (toolView on ToolExecutorAdapterDeps and BuildAgentCoreDeps) gets plain events: refused, input_error, mode, started, plugin_result, output, executed, outcome. Removed: ToolTranscriptFormatter, PLAIN_TOOL_TRANSCRIPT, the CodeHighlighter types, writeTranscript, transcriptFormatter, codeHighlighter, toolTimeTracker, and presentation from the adapter and buildAgentCore deps, ToolRegistryAdapter.presentation(), ToolExecResult.display, plainDiffDisplay, DerivedDisplay. ToolEnvValues is now { env } (the host picks COLUMNS/LINES). New tool_result records carry no display fields. Old records restore unchanged. Model and JSON-route bytes do not change (tool-outcome-golden.test.ts)"
  - id: "2026-11-01-ask-deadline-denies"
    type: fix
    status: landed
    detail: "Decision 34. In askUserFallback \"registry\" mode, an ask with no isDefault option no longer cancels the send on its deadline (before, the turn stopped). PendingAskRegistry now rejects that ask with the new AskDeniedError (src/sdk/preflight-ask.ts). The preflight step then denies the issue exactly as in \"none\" mode: an ask_denied notice, a preflight.ask-denied diag event, the request goes out unchanged, and the turn continues. The issue code is not asked again in that turn. An explicit session.answer(id, null) still cancels that send. Tests: core tests now find the plugins repo through one helper (src/test-utils/sibling-repo.ts): MA_PLUGINS_DIR, then ../plugins, then ../minimal-agent-plugins. Without it, the tests that need it skip and the helper prints one reason line. MA_REQUIRE_PLUGINS=1 makes a missing repo or plugin fail. Core CI clones the plugins repo to ../plugins when the PLUGINS_DEPLOY_KEY secret is set, and then sets MA_REQUIRE_PLUGINS=1"
  - id: "2026-11-01-plan-oauth-leaves-core"
    type: refactor
    status: landed
    detail: "BREAKING (decision 39). Core is provider-neutral: the plan OAuth client left src/auth/auth.ts. ./host/auth now exports only the AuthResult, TokenAuthResult, and ProviderNativeAuthResult types and legacyAuthToProviderAuth. Removed from ./host/auth: ANTHROPIC_PLAN_OAUTH, getAuth, GetAuthDeps, readCredentials, writeCredentials, clearCredentials, refreshAccessToken, getOauthRefreshConfig, OAuthRefreshConfig, TokenRefreshResult, CredentialsData, credentialsToSecrets, secretsToCredentials. The provider plugin owns the endpoints, the client id, the token exchange, and the refresh through the existing ProviderPlugin.oauthLogin contract (serviceId, readAuth, refreshCredential). It uses the same store key, so stored credentials load with no change. Hosts resolve auth with ./host/provider-auth (resolveStartupAuth) or ./host/auth-strategies, and clear it with clearProviderCredentials or clearAllCredentials. The llm:complete host capability now resolves the credential of the model's own provider. Before, it always read the plan OAuth entry and failed when that entry was missing. The provider-token baseline is empty"
  - id: "2026-11-01-canonical-usage-input-excludes-cache"
    type: fix
    status: landed
    detail: "CanonicalUsage.inputTokens now has one documented meaning: uncached input only. cacheReadTokens and cacheCreationTokens are disjoint from it. Context-window used is the sum of the three. The OpenAI Chat translator (plugin-api/llm/openai-chat) copied prompt_tokens, which already includes cached_tokens. So used and cost counted cached tokens twice (prompt 1500 with 200 cached showed 1700). It now sets inputTokens to prompt_tokens minus cached_tokens. Anthropic input_tokens already excludes cache, so its mapping does not change. New docs section: provider-plugin-standards.md, Usage counters"
  - id: "2026-11-01-item-started-label-removed"
    type: refactor
    status: landed
    detail: "BREAKING (decision 38, S37). ItemStartedEvent loses the old label alias. Read toolName. In-process sinks and event-log readers no longer see label. The json and stream-json wire bytes do not change: serializeEvent and serializeStreamJsonLine add label back on a tool_use item_started, just before toolName, with the same value"
  - id: "2026-11-01-ask-user-no-wait"
    type: fix
    status: landed
    detail: "BREAKING (decisions 11, 34). Session askUserFallback now defaults to \"none\". With no ports.askUser and no per-run askUser, a preflight ask resolves at once: an ask_denied notice, a preflight.ask-denied diag event, and the request goes out unchanged. Before, the default \"registry\" waited for session.answer with no deadline, so a run with no person hung forever. \"registry\" now needs the new SessionOptions.askDeadlineMs, or openSession throws. On the deadline the ask resolves with its isDefault option, or null (a decline, which cancels that send) when it has none, plus a session.ask-deadline diag event. PendingAskRegistry takes a required { deadlineMs, onDeadline? } options object. A host that answers asks through session.answer must pass askUserFallback: \"registry\" and askDeadlineMs"
  - id: "2026-11-01-host-boot-loader-diagnostics-relay"
    type: fix
    status: landed
    detail: "S20 (WP-09d): bootHost no longer gives the plugin loader a fixed logger. Before, a plugin hook or event handler that threw during a session run went to host.diagnostics, not to the log of that session. Now the loader default logger reports through the diagnostics relay, as in the CLI: inside a run to the session of that run, outside a run to host.diagnostics (warning or worse, as plugin-warning). Every loader diagnostic also goes to the process bus. Routine loader notices (id shadow, manifest opt-out, platform gate) no longer appear in host.diagnostics"
  - id: "2026-11-01-s44-zero-baselines"
    type: refactor
    status: landed
    detail: "BREAKING (S44, S45, S2, WP-13). Removed exports: ./plugin-api/utils/file-lock, ./plugin-api/utils/bounded-drain, ./plugin-api/utils/platform (no consumer imports them; platform stays in the ./plugin-api root). Removed PluginLoaderOptions.handlerEnv (no host passes it, decision 33). New PluginLoaderOptions.handlerStdio: the host gives plugin handlers its streams. Core no longer hands process.stdin/stdout/stderr to handlers, so ToolHandlerContext.stdin/stdout/stderr, PromptFragmentContext.stderr, EventHandlerContext.stderr, and HookHandlerContext.stderr are optional. Removed the deprecated ModeProvider.promptPrefix. Deleted src/cache/cache.ts (CacheAnomalyDetector, terminal style codes, only tests used it, decision 14). New zero-baselines.test.ts (S44) and core-boundary-guard.test.ts (S2). The public-closure baseline keeps only term-width (ansi 1, the SGR reset) and the S2429 tool-executor-adapter row. The provider-token baseline keeps only auth/auth.ts and its test"
  - id: "2026-11-01-s41-terminal-helpers-leave-core"
    type: refactor
    status: landed
    detail: "BREAKING (S41): ./plugin-api/utils/ansi, ./plugin-api/utils/palette, and ./plugin-api/utils/unified-diff are removed (also from the ./plugin-api root). They live in minimal-agent-cli src/terminal-kit; plugin ui code gets them through ctx.tui.kit, headless code reads ./plugin-api/utils/style-slots. src/plugins/manifest-legacy.ts is deleted: parseManifest rejects a flat manifest (top-level tuis, hooks, liveAreaSlots, and so on) and a tool entry with icon, color, or headerKey, with a clear error. ManifestHandler loses icon, color, headerKey. Edit/Write display is the plain patch (plainDiffDisplay); new optional ToolTranscriptFormatter.renderUnifiedDiff colors it. formatQuotaWindows and bootstrapUserPlugins take an optional styles option (default plain). The public-closure scan counts ANSI_CODES references as ANSI (decision 27); the ansi.ts and palette.ts baseline entries are gone"
  - id: "2026-11-01-synthetic-tool-result-persisted"
    type: fix
    status: landed
    detail: "Decision 31 (WP-17c). A tool result that core makes itself, with no tool run (the note for a tool call a kill cut off, and the result of a call an abort skipped), is now written to the session log by hosts whose appendToolResult does nothing (the CLI). Before, the pair lived in memory only, so a second --resume dropped the cut-off tool_use. New optional port method SessionPersistence.appendSyntheticToolResult. SessionPersistenceAdapter implements it. Without it, core calls appendToolResult"
  - id: "2026-11-01-style-slots"
    type: feat
    status: landed
    detail: "S41 step 1: new ./plugin-api/utils/style-slots (createStyleSlots, TerminalKit, TerminalCodes, TerminalStyles, TerminalPalette, TextStyle, TERMINAL_*_NAMES). Headless plugin code reads display styles from plain style slots. New TerminalUiCapability.kit (required), ManifestUiBlock.setup, UiSetupContext, UiSetupHandler. The terminal host runs ui.setup and installs its kit"
  - id: "2026-11-01-loader-diagnostics-per-run"
    type: fix
    status: landed
    detail: "S20: with two sessions on one plugin loader, loader diagnostics of a run reach the log of that run's session. Before, the last attached session got all of them. Session.run sets a run scope (AsyncLocalStorage, src/diagnostics/run-scope.ts). Outside a run, the loader reports to the one attached session, or to its runtime-level handle when two or more are attached"
  - id: "2026-11-01-resume-stop-cases"
    type: fix
    status: landed
    detail: "Decision 31 (S50, WP-17b). A user abort (AbortError or an aborted signal) now clears the round checkpoint, so --resume never continues a cancelled turn. A crash or a kill keeps it. On resume, a tool call that a kill cut off keeps its tool_use and gets a synthetic error tool_result that says the call may have run fully, partly, or not at all. The tool never runs again by itself. loadSession keeps that last cut-off tool round only when the turn has a mid-turn checkpoint. New: repairMessages opts.keepCutOffToolCalls, closeInterruptedToolCalls, toolCallInterruptedByStopResult"
  - id: "2026-11-01-resume-event-log-null"
    type: feat
    status: landed
    detail: "runtime.resumeSession takes eventLogPath: null to keep the event log in memory only (no <id>.events.jsonl sidecar). The CLI --resume uses it (S50, WP-17)"
  - id: "2026-11-01-manifest-split-headless"
    type: refactor
    status: landed
    detail: "BREAKING (S31): manifests get a headless block (tools, modes, events, hooks, promptFragments, commands, hostModes, setup, replayRenderers, turnAttachments) and a ui block. Core loads headless only and ignores ui. Legacy flat manifests load through src/plugins/manifest-legacy.ts with one notice for flat UI fields (deleted in S41). ManifestFile.tuis is now tools; ManifestFile.liveAreaSlots, LoadedPlugin.liveAreaSlots, and PluginLoader.getLiveAreaSlots are removed (the terminal host loads ui blocks); new PluginLoader.loadedPackages(). Core no longer sets TUI_PLUGIN_PROTOCOL or MINIMAL_AGENT_PALETTE; hosts pass PluginLoaderOptions.handlerEnv. New plugin-api names: ToolTrigger, ToolHandlerContext, ToolHandlerResult, ToolHandler, TerminalUiCapability, ManifestUiBlock, LiveAreaHandlerContext.tui"
  - id: "2026-11-01-plugin-diagnostics-injected"
    type: refactor
    status: landed
    detail: "S20: the 13 plugin-host diag sites use injected handles; the global diag inventory is empty. PluginLoaderOptions.diagnostics, PluginLoader.attachSessionDiagnostics(scope) and diagnostics(); openAgentCoreSession attaches the session scope, so loader diagnostics during a run reach the session log as ch:diag entries. New Session.diagnostics. parseManifest takes { warn }"
  - id: "2026-11-01-plugin-roots-from-host"
    type: refactor
    status: landed
    detail: "BREAKING (S40): core takes plugin roots as data. PluginLoaderOptions gets roots ({ embedded, user, home, project }, each dir holds package dirs) and loses projectDir and siblingDirs. resolveSiblingPluginRoots and resolveProviderPluginRoots are removed. bootProviderDiscovery takes { roots }. scanPluginCatalog/buildPluginCatalog take PluginRoots. bootHost takes pluginRoots, providerRoots, and pluginSync ({ targetDir, repoUrl }) and loses embeddedDir, projectDir, homeDir, siblingDirs, and skipPluginSync. bootstrapUserPlugins needs repoUrl; DEFAULT_PLUGINS_REPO is removed. New exports: PluginRoots, PluginRootTier, PLUGIN_ROOT_TIERS, providerRootsOf (./host-kit/plugin-loader)"
  - id: "2026-11-01-ui-callbacks-removed"
    type: refactor
    status: landed
    detail: "BREAKING (S36, S37): AgentCore.run and Session.run drop the UI callbacks onThinkingStart, onThinkingChunk, onThinkingStop, onTextStop, onNotice, drainQueuedUserText, onQueueInject, and beforeReflectionCheckpoint. TranscriptSink and AgentCoreConfig.transcriptSink are removed. New opt-in event kinds block_started and block_stopped. SendOptions onThinkingStart/onThinkingStop/onTextStop become onBlockEdge"
  - id: "2026-11-01-print-mode-moved-to-cli"
    type: refactor
    status: landed
    detail: "BREAKING: the ./sdk/print-mode export is removed. The module picks an output mode from CLI flags, so it moved to minimal-agent-cli (src/print-mode.ts). The unused formatCacheLine helper is removed from src/cache/cache.ts"
  - id: "2026-11-01-host-boot"
    type: feat
    status: landed
    detail: "New public subpath ./host-kit/host-boot: bootHost() boots providers, plugins, tools, and auth in the CLI boot order, with no terminal I/O; listBootedModels() returns ModelRow[]; missing plugin node_modules is a diagnostic, not an install (docs/host-boot.md)"
  - id: "2026-11-01-cli-moved-core-is-a-library"
    type: refactor
    status: landed
    detail: "The CLI moved to minimal-agent-cli; core is a library. Core has no bin, no entry point, and no terminal host code"
  - id: "2026-10-31-host-mode-review-fixes"
    type: fix
    status: landed
    detail: "Host mode: getEffort reads the live core, HostSession.run applies turn.willStart, a second signal or the grace period ends the process, --host-mode <id> is not a prompt; setModel accepts [1m] ids; preflight adoption of an unknown id keeps the model and emits a new public TurnNotice variant, model_adopt_failed (./sdk/turn-notice), severity warn"
  - id: "2026-10-31-model-effort-switching"
    type: feat
    status: landed
    detail: "AgentCore.setModel/setEffort/getEffort validate against the model registry (same-provider only); the preflight adoptModelId auto-adoption shares the same checked path and emits a new public TurnNotice variant, model_adopted (./sdk/turn-notice), severity info, on every automatic model change"
  - id: "2026-10-31-engine-writes-closure"
    type: feat
    status: landed
    detail: "No direct writes in engine code (S25), config imports no CLI or UI code (S26), public closure ratchet (S32)"
  - id: "2026-10-31-one-loop-unbounded-run"
    type: feat
    status: landed
    detail: "decideNext stop table, unbounded retry with smart recovery, error classes as data; no round or retry caps"
  - id: "2026-10-31-migration-manifest-timer-inventory"
    type: feat
    status: landed
    detail: "Migration manifest (S7) and core timer inventory (S43) ratchets; dead UI seams removed; docs match the tree"
  - id: "2026-10-31-bun-test-whole-suite"
    type: fix
    status: landed
    detail: "bun test runs the whole suite; a preload makes process.exit throw in tests"
  - id: "2026-10-31-agentcore-one-loop"
    type: refactor
    status: landed
    detail: "Legacy Agent class and bridge loop deleted; AgentCore is the one loop"
  - id: "2026-10-31-core-public-package"
    type: feat
    status: landed
    detail: "Package renamed to @minimal-agent/core with an exports map; plugin-api folded in, no workspace dependency"
  - id: "2026-10-14-prompt-writing-style-audit"
    type: chore
    status: landed
    detail: "Writing-style cleanup of model-facing prose plus prompt-audit rules"
  - id: "2026-10-04-builtin-tool-input-aliases"
    type: fix
    status: landed
    detail: "Read/Write/Edit accept path alias, validate required fields before IO"
  - id: "2026-10-01-compact-provider-preamble-retry-cap"
    type: fix
    status: landed
  - id: "2026-09-15-curl-pipe-installer"
    type: feat
    status: landed
  - id: "2026-09-10-compact-multi-mode"
    type: feat
    status: landed
  - id: "2026-09-02-write-contents-alias"
    type: fix
    status: landed
  - id: "2026-08-31-auth-credential-details"
    type: feat
    status: landed
  - id: "2026-08-21-paste-stacked-ghost-frames"
    type: fix
    status: landed
    commits: ["ff34290"]
  - id: "2026-08-18-http2-stream-aborted-retry"
    type: fix
    status: landed
  - id: "2026-08-18-glob-pattern-alias"
    type: fix
    status: landed
  - id: "2026-08-17-effort-flag-does-not-swallow-fast"
    type: fix
    status: landed
  - id: "2026-08-09-raw-mode-mdstream-fence-paint"
    type: fix
    status: landed
    commits: ["7cf4357"]
  - id: "2026-08-05-husky-commitlint-ci"
    type: chore
    status: landed
    detail: "Husky + Commitlint + CI commitlint job; Actions checkout/upload-artifact v7"
  - id: "2026-08-05-tool-output-mega-line-caps"
    type: fix
    status: landed
  - id: "2026-08-01-resume-credential-pin-provider-scope"
    type: fix
    status: landed
  - id: "2026-07-30-openai-chat-thinking-stop-before-text"
    type: fix
    status: landed
  - id: "2026-07-12-never-give-up-terminal-less-thinking-idle"
    type: fix
    status: shipped
    commits: ["15c295c", "cbcf119", "dc020a2"]
    research: "private/retry-fix/PROGRESS.md"
related:
  - "docs/changes/"
  - "private/retry-fix/PROGRESS.md"
---

# Changelog

All notable changes to this project are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project follows a pragmatic, date-stamped release rhythm. Longer
write-ups live under [`docs/changes/`](changes/); research handoffs under
`private/*/PROGRESS.md` when present.

## [Unreleased]

BREAKING: remove the home plugin root tier (PluginRoots.home, homeDir). Precedence is project > user > embedded.

### Added

- 2026-11-18: **Prompt-cache fix: an anchor marker, a cap of 4 markers, and
  append-only thinking, all behind flags that are OFF by default.** With the
  defaults, request bodies are byte-identical to before (`48721c3`, Matthew).
  - Anchor (`MINIMAL_AGENT_CACHE_ANCHOR`, `--cache-anchor`, config
    `cacheAnchor`): a second rolling `cache_control` marker on the message
    before the latest assistant turn.
  - Cap: at most 4 `cache_control` markers in the final Anthropic body. The
    anchor is dropped first and the tail marker never. No effect today (the
    most is 3 + 1).
  - Append-only thinking for keep-all Anthropic models
    (`MINIMAL_AGENT_THINKING_HISTORY=keep`, `--thinking-history keep`, config
    `thinkingHistory`). The default stays `strip`.
  - Recovery: a 400 about modified thinking or its signature retries the same
    turn once with strip, and latches strip for the session.
  - Why: `stripStaleThinking()` removed thinking from older assistant messages
    on every request, so the previous request's prefix never matched. After
    about 18 to 22 messages in one tool loop, every request read 0 cached
    tokens (about 2.1M tokens written in 11 requests in one session). A live
    A/B on Haiku 5.5 (`research/2026-11-18-session-ffcf4115-cache-anomalies`,
    evidence 24): keep + anchor costs 40 to 44 percent of today, with 0 cache
    misses and 0 400s.
  - Not done: sub-agent flag inheritance, the strip-mode gap, keep with
    compaction, and a large-body live gate before keep can be the default.

- 2026-11-17: the `model_adopted` notice has two optional fields,
  `fromTarget` and `toTarget` (type `NoticeTarget`: `credentialName`,
  `providerId`, `model`, `effort`). `AgentCore.switchTarget` sets them, so a
  host can name each value that a target switch changed: with only `from`
  and `to` (the models), a credential-only switch was "model m, was m". An
  automatic model adoption does not set them. Additive: a host that does not
  read them prints the same text as before. Not tested: an older host (CLI
  or ACP plugin) against this core. By reading, it ignores the two fields.
- 2026-11-17: `./plugin-api/utils/target-control`, the shared part of the
  control channel that moves a RUNNING sub-agent to the new target of its
  lead: the signed line format (`signSwitchLine`, `readSwitchLines`,
  HMAC-SHA256 with a key for each worker, with known-answer test vectors).
  Pure, no file I/O and no state. Experimental. The file I/O is in the
  sub-agents plugin and in the CLI. `docs/hooks.md` now has the
  `target.didSwitch` plugin event.
- 2026-11-17: the live target can change at any time, and the change
  applies at once. A target is the credential, provider, model and effort.
  `AgentCore.switchTarget`, `setModel` and `setEffort` now run one path
  (`src/sdk/target-change.ts`):
  - A retry or quota wait in progress ends, and the next attempt goes to
    the new target. The turn is not aborted. Before, a session that hit a
    full quota slept until the reset, and a switch applied only after it.
  - BREAKING: the system prompt is built again for the new target before
    that attempt. Before, `switchTarget` kept the system prompt of the run.
  - BREAKING: thinking from before the change is discarded from the live
    history (`thinking` and `redacted_thinking` blocks). A thinking block
    belongs to the target that made it. This also applies to a change of
    only the model or only the effort. A request in flight keeps its
    target and its history. An automatic model adoption (provider
    preflight) does not discard.
  - New session record kind `target_switch` with the new target.
    `foldRecordsForModel` drops the thinking of each earlier assistant
    record, so a resume gets the history of the live session. The display
    fold keeps it. `lastTargetSwitch(records)` gives the newest one. Limit:
    a build older than this one ignores the record, so it keeps that
    thinking on a resume.
  - `AgentCore.onTargetChange(listener)` gives each change with the full
    `from` and `to`. `switchTarget(sel, { quiet: true })` sends no
    `model_adopted` notice.
  - `switchTarget` and `setModel` refuse a model with
    `structuredOutputs: false` while an output schema is set.
  - `ToolHandlerContext.queryTarget()` gives the live target to a plugin
    (`TargetSnapshot`). Only a host with one session for each process sets
    `PluginLoader.targetSource`. `wireModelInfoSource` does it, and the
    ModelInfo source now uses the live provider, not the boot provider.
  - `MediaResolveContext.modelId`: the media resolver gets the live model
    on each turn.
  - `SessionPersistence.appendTargetSwitch` (optional).
- 2026-11-15: hook seams for context and stop control. Chain results
  carry `additionalContext`. New channels `turn.willStop` and
  `session.willStart`, with `LifecyclePort.beforeTurnStop` and
  `LifecyclePort.sessionWillStart`. `AgentCore.addSessionContext` and
  `run`/`Session.run` `opts.additionalContext` add hook context to the
  first user message. `AgentCoreConfig` gets `maxStopHookHalts` and
  `sessionFacts`. New `TurnNotice` kind `stop_hook_capped`. Hook payloads
  get `isError`, `sid?` and `agentMode?`. `ChainEmitResult` gets `failed`.
  `ToolExecutor.execute` takes an optional context. `peekSessionId` reads
  the session id without minting one. See `docs/hooks.md`.
- 2026-11-12: `./host-kit/embedded-plugins`, plugins from a compiled
  binary. A compiled host calls `registerEmbeddedPlugins(table)` once at
  startup with its build-time table (text imports for `manifest.json`,
  `provider.json` and `PROMPT.md`, literal `() => import()` thunks for
  every entry module, `$bunfs` paths of run files). The table is the
  lowest-precedence plugin source: a project or user copy of the same id
  wins. Every loader stage, the catalog, the CLI command loader and
  provider discovery read plugin files through a new `PluginPackage`
  (`src/plugins/source.ts`). The disk implementation keeps the old
  behavior. `materializeEmbedded` extracts a file a plugin runs
  (`gather.sh`) to `<agentHome>/cache/embedded/<buildId>/<pkg>/` with
  mode 0755. The manifest gets an optional `scripts` map
  (`ManifestFile.scripts`), name to relative entry path, and
  `findEmbeddedScript("<manifest id>/<name>")` finds the module for a
  `__run` dispatcher.
- 2026-11-12: `./plugin-api/utils/self-spawn`, one way to start another
  minimal-agent from source and from a compiled binary. `selfSpawn()` gives
  `agent()` (`[execPath, <cli entry>]` from source, `[execPath]` compiled,
  `MINIMAL_AGENT_BIN` wins in both), `script(id, devPath)` (`[execPath,
  devPath]` from source, `[execPath, "__run", id]` compiled; the id is
  `<plugin-id>/<name>` and a bad one throws), and `childEnv(env?)`, a copy
  without `BUN_BE_BUN`. `isStandaloneExecutable` moved here, the host-core
  resolver re-exports it. The Bash tool, `buildHandlerEnv` (`ctx.env`), and
  the plugin tool, event and fragment subprocess spawns strip `BUN_BE_BUN`,
  so a user command never runs a compiled binary as plain `bun`.

- 2026-11-11: per-run output schema, strict, temperature and append prompt.
  `AgentCore.run` takes `outputSchema`, `temperature` and `outputStrict` for
  that run only. New one-shot setters `setNextRunOutputSchema`,
  `setNextRunTemperature` and `setNextRunOutputStrict`, and `setOutputStrict`
  for the session. A model that does not accept a temperature gets none, and
  the run emits one `agent.temperature-ignored` warn. Strict without a schema
  has no effect. A model with `structuredOutputs: false` gets one
  `llm.strict-unsupported` warn per run. `buildAgentCore` and
  `openAgentCoreSession` take `outputStrict` and `appendSystemPrompt`. The
  append text follows the instructions and is folded into `systemHash`.
  `./host/host-mode` adds `HostRunOptions` and `HostOpenSessionOptions`
  (`systemPrompt` with mode `append` or `override`).

- 2026-11-11: read-only request view on `message.willSend`. `SendSnapshot`
  gets `request` (a `SendRequestView` of `requestType`, `tools`, `maxTokens`,
  `thinking`, `outputConfig` and `temperature`) and `compact` (true on a
  compaction send). Changes to them are ignored. New export `requestView`.
  The plugin host `ModelsReadApi` gets `findForProvider(idOrAlias,
  providerId)`, with no cross-provider fallback.

- 2026-11-11: per-plugin prompt-text suppression. New public subpath
  `./host/plugin-prompt-resolution`. `PluginLoader.load` and `bootHost` take
  a `pluginPrompts` option. A suppressed plugin still loads and keeps its
  tools. Only its prompt text is dropped. New config key `plugins.prompts`
  (`false`, `true`, or `{ all, keep, suppress }`) and
  `loadPluginPromptsConfig()`. The plugin id `prompts` is reserved: a
  manifest with that id throws `ReservedPluginIdError` and the load fails.
  See `docs/plugin-prompt-architecture.md`.

- 2026-11-02: `AGENT_VERSION` (`./host/build-info`) comes from a static
  JSON import of `package.json`. Before, core read the file at module load.
  Bun inlines the import at build time, so a `bun build --compile` binary
  reports the same version as a run from source. A missing `package.json`
  is now a build error, not a `"0.0.0"` fallback. New export
  `manifestVersion(manifest)` returns the `version` field of a parsed
  manifest, or `"0.0.0"` when it is missing.

- 2026-11-02: core prompt files are embedded for compiled binaries.
  `src/prompts/embedded.ts` imports each core prompt `.md` file as text.
  `loadPromptText` serves core prompt paths from that map: a path in the
  source dir `src/prompts/`, or `/$bunfs/prompts/<key>` inside a
  `bun build --compile` binary. So a binary needs no `src/prompts/` on disk.
  Plugin prompt paths still read from disk. A new core prompt file needs an
  import and a map entry in `embedded.ts`. A test in `prompts.test.ts` fails
  when the map and the files differ.

- 2026-11-02: the host-core resolver serves each public subpath from
  `src/plugins/loader/host-core-modules.ts`. That file is a generated map
  with one static `require()` per `exports` entry. The resolver resolves no
  export by package name at run time. From source it resolves only the
  package root. So it also works inside a `bun build --compile` binary,
  where there is no `node_modules` and `import.meta.dir` is `/$bunfs/root`.
  The static requires make the bundler embed every public module for
  plugins on disk. New script `bun run gen:host-core-modules` writes the map
  (`--check` fails when it is stale). A test in `host-core-resolver.test.ts`
  fails when the map and the `exports` map differ. A change to `exports`
  regenerates the map in the same commit.

- 2026-11-02: new optional provider hook `ProviderPlugin.fetchAccountPlan(auth,
  ctx?)` (`./plugin-api/llm/provider-plugin`). It reads the plan, seat,
  role, and usage windows of one stored credential from the provider's
  account endpoints. It must not spend model quota, and it must honor
  `ctx.signal`. It resolves `null` when the provider cannot inspect that
  auth kind (for example an API key with no account endpoint). It can
  reject on a network or HTTP failure. Hosts use it for an account plan
  view, never on the request path. New contract types `AccountPlanInfo`
  (all fields optional, no secrets) and `AccountPlanContext`. Both are also
  re-exported from `./host/provider-plugin`.

- 2026-11-01: `./host-kit/host-boot`: one stored credential per session.
  `BootedHost.resolveAuth(modelId, providerId?, credentialName?)` takes an
  optional credential name and passes it to `resolveStartupAuth`. New
  `BootedHost.listCredentials()` lists the stored credentials by provider.
  A provider with two logins gives two entries. `CredentialedProvider` is
  re-exported from `./host-kit/host-boot`. The "no credentials" error and
  `storedProvidersHint` now name each provider once, with all its labels.

- 2026-11-01: `./host-kit/host-boot` (WP-09c). `BootedHost.toolExecutorFor(modelId,
  options?)` makes one tool executor for each session and its model. The model
  id sets the media (vision) context of the tools, and each executor has its
  own feedback tracker. `host.toolExecutor` stays: it is the executor for
  `defaultModelId`. New `HostBootOptions.statusPort` sends the `running_tool`
  status of each tool call to the host. `ToolExecutorForOptions.statusPort`
  replaces it for one executor. `resolveAuth(modelId, providerId?)` takes an
  optional provider id. With it, the boot uses the entry of that provider
  (`findModelForProvider`), not the last provider that registered the id.

- 2026-11-01: `runtime.resumeSession` takes `eventLogPath: null`
  (`ResumeSessionOptions`, S50). With `null`, the resumed session keeps
  its event log in memory only and writes no `<id>.events.jsonl` sidecar.
  The default does not change. The CLI `--resume` uses this, because the
  CLI writes no event sidecar for a new session either.
- 2026-11-01: new event kinds `block_started` and `block_stopped`
  (`./sdk/events`, S36). Each one has `itemType` (`text` or `thinking`)
  and `id`, the per-turn streaming id of the block's deltas. They are
  opt-in like the deltas: a run that sets `emitDeltas` emits them, and
  `Session.run` sets it by default. The json and stream-json routes do not
  pass them, so their output does not change. Hosts with an exhaustive
  `switch` over `AgentEvent` must add the two cases.
- 2026-10-31: plugin imports of `@minimal-agent/core` get the host copy.
  `PluginLoader.load` and provider discovery install a Bun runtime plugin
  (`src/plugins/loader/host-core-resolver.ts`) once per process. Each
  `exports` subpath is a virtual module served from the host's own module,
  even when a plugin has its own `node_modules/@minimal-agent/core`. A file
  in any other core copy refuses to load, so a subpath that core does not
  export stays unresolvable.
- 2026-10-31: hook subscriptions take a new `failClosed` flag
  (`ManifestHookSubscription.failClosed`, `ListenOpts.failClosed`). It
  marks a `chain` hook as an approval gate. When that hook throws,
  rejects, or times out, the chain halts and the action is denied (for
  `tool.willInvoke`: a tool error, the turn continues). Unflagged hooks
  keep the fail-open behavior. `LifecyclePortAdapter` also denies when the
  emit itself fails and a `failClosed` listener is on the channel.
- 2026-10-31: new public `TurnNotice` variant `model_adopt_failed`
  (`./sdk/turn-notice`), severity `warn`. A provider preflight can name a
  model id (`adoptModelId`) that the registry does not know. The core now
  first asks the provider plugin to register the id
  (`registerAdHocModel`). When the id is still unknown, the core keeps the
  current model and effort, emits this notice, and the turn goes on.
  Before, the turn failed. Hosts with an exhaustive `switch` over
  `TurnNotice` must add the new case.
- 2026-10-31: with `--output-format stream-json`, a failure after argv
  parse still ends stdout with machine-readable lines: an `error` line,
  then a `run_finished` line with outcome `failed`. This covers a failed
  session open, a failed `--resume`, a `turn.willStart` halt (code
  `turn.blocked`), and any other fatal error. When the model is known and
  no `session_started` line is on stdout yet, that line comes first. An
  abort gives only `run_finished` with outcome `aborted`. Argv and flag
  errors still go to stderr only. The stderr text, the exit codes, and the
  json and text routes do not change.

- 2026-10-31: `--output-format stream-json` has a new first line,
  `session_started`. Its keys, in order: `type`, `streamVersion` (1),
  `sessionId`, `resumedFrom`, `model`, `provider`, `effort`, `cwd`,
  `version`, `outputFormat`, then the `seq` (0) and `ts` envelope keys.
  Every key is always present: `resumedFrom`, `provider`, `effort`, and
  `version` are `null` when unknown. `resumedFrom` is the source session id
  of a forked `--resume`. Then `sessionId` is the new forked id. It is
  `null` for a fresh run and for `--resume-same-sid`. The CLI writes
  it before it opens the session, so it is on stdout even when the open
  fails. Event lines then start at `seq` 1. It is not an `AgentEvent` kind.
  `src/sdk/events.ts` exports its type as `SessionStartedLine`. Breaking
  for stream-json readers: a reader that expects line 1 to be
  `turn_started` must skip it. `--output-format json` does not change.

- 2026-10-31: `--output-format stream-json` lines gain `sessionId`, `seq`,
  and `ts` keys, after the event keys. `sessionId` is the CLI session id.
  `seq` counts stdout lines from 0, with no gaps. `ts` is epoch
  milliseconds (UTC). `src/sdk/events.ts` exports `serializeStreamJsonLine`,
  `StreamJsonEnvelope`, and `StreamJsonLine`. `--output-format json` does
  not change.

- 2026-10-31: `item_started` carries `input` on a `tool_use` item. It is
  the exact input the model sent. It is a copy, so a sink that changes it
  does not change the history. It has no size cap: a large Write or Edit
  payload appears in full. A persisted runtime session writes every event
  kind to `<sid>.events.jsonl`, so that file now stores each tool input
  three times per call: in the assistant record, in `tool_call`, and in
  `item_started`. Follow-up idea, not done: the core copies the input even
  when no sink takes `item_started` (`agent-core.ts` builds item events
  before the emit filter). A lazy build like `wantsToolOutput`
  (`event-filter.ts`) would skip that copy.

- 2026-10-31: `--output-format stream-json` ends with a `run_finished` line.
  `src/sdk/events.ts` exports `STREAM_JSON_EVENT_KINDS`: the legacy nine
  kinds plus `run_finished`. The line has the run outcome (`completed`,
  `failed`, `aborted`, `waiting`). It is on stdout before the process exits.
  Breaking for stream-json readers: the output has one more line at the end.
  A script that reads the last line as `turn_completed` or `error` must now
  skip `run_finished`. `--output-format json` does not change. It stays on
  `LEGACY_EVENT_KINDS`.

- 2026-10-31: No direct process writes in engine code (S25).
  `src/architecture/no-direct-writes.test.ts` fails on `console.*`,
  `process.stdout.write`, `process.stderr.write`, or `Bun.stdout` /
  `Bun.stderr` in any engine file. The 18 writes in 9 files became
  diagnostics: the `--debug` request dump (`transport.request-dump`), the
  DEBUG login trace (`auth.login`), the config parse error, and the
  preflight adapter failure are Debug severity; the net-dbg logger
  failure, the unknown `MINIMAL_AGENT_HTTP3` value, the unknown rewind
  target, and the deprecated `systemPromptAppend` mode field are warnings.
  The scan reuses the SDK boundary scanner's AST pass.
  Correction (2026-11-17): this entry also listed the cache anomaly
  (`cache.anomaly`) as a warning. Core never emitted it: the last caller of
  `CacheAnomalyDetector` went with the legacy Anthropic client (W2,
  2026-06-26), and S44 deleted `src/cache/cache.ts`. The warning now comes
  from the `cache` plugin (`ma-cache-plugin` in minimal-agent-plugins), not
  from core.

- 2026-10-31: Public closure ratchet (S32).
  `src/architecture/public-closure.test.ts` walks every edge from each
  `exports` entry and checks that no reached file is CLI-side, uses stdio,
  or holds an ANSI escape literal beyond a shrink-only baseline. Today the
  closure has 133 files and 5 baseline entries: four exported plugin-api
  TUI helpers (S33) and `src/input/input-capture-stack.ts` through the
  reflection Esc skip (S30).

- 2026-10-31: One loop with the v2 stop table (S15). `AgentCore.run` asks
  the pure `decideNext` (`src/sdk/stop-policy.ts`) what to do after each
  attempt: 13 rows in a fixed order, outcomes `completed`, `truncated`,
  `failed`, `aborted`, `waiting`. The turn result carries the `outcome`.
  `src/architecture/loop-inventory.test.ts` allows exactly one module that
  sends, runs tools, and repeats.

- 2026-10-31: Unbounded run with smart recovery (S16). Transient errors
  retry forever with exponential backoff, full jitter, and a 60 s ceiling;
  `Retry-After` wins. Each wait emits a `status` event (`retrying`,
  `waiting_for_quota`) and one `api.retry` diagnostic. Recoverable errors
  run one action first (refresh the credential, compact, or wait for the
  quota reset). A permanent error pauses the run: `error` with
  `recoverable: false`, then `status` `waiting_for_host`, and outcome
  `waiting`; the next run resumes the same session. The loop owns the
  retry: the default transport is now `canonicalAttemptFn` (one attempt),
  and `canonicalSendFn` keeps a retry for side calls. The clock is
  injectable (`AgentCoreConfig.retry`).

- 2026-10-31: Error classes as data (S49). `plugin-api/llm/errors` exports
  `ErrorClass` (`transient`, `recoverable`, `permanent`), `RecoveryAction`,
  `parseRetryAfterMs`, and `tagUpstreamError`. `classifyUpstreamError`
  returns the class, and `ProviderError` carries it. The loop decides from
  the class, never from provider strings.

- 2026-10-31: `src/architecture/migration-manifest.json` lists every file in
  the areas that leave or change in the core/CLI split (`src/host`, `src/ui`,
  `src/input`, `src/terminal`, `src/cli`, `src/modes`, `src/plugins/host`,
  `src/e2e`, the entry point, the abort bus, the stderr log sink, and
  safe-stdout). Each row says `core-engine`, `cli`, or `delete` and gives a
  target path. CLI rows list the core files they import.
  `migration-manifest.test.ts` fails on a file with no row, a row for a
  missing file, or stale imports.

- 2026-10-31: Core timer inventory. `src/architecture/timer-inventory.ts`
  lists every non-test core file that calls `setTimeout` or `setInterval`,
  with its call count, owner (`core` or `cli`), and reason. 26 files today:
  the HTTP/2 transport and the stream watchdog, plus 24 others.
  `timer-inventory.test.ts` is a ratchet: counts only go down.

- 2026-10-31: The package is `@minimal-agent/core` and has an `exports` map,
  the public contract for hosts and plugins. It exports `./sdk/events`,
  `./sdk/lifecycle`, `./sdk/ports`, `./sdk/agent-core`, and every former
  plugin-api subpath as `./plugin-api/*`. `plugin-api/` is now a folder inside
  the core package, not a `workspace:*` package, so `dependencies` is empty
  and a git install of core resolves. Core imports plugin-api through the
  same self-reference consumers use. `src/architecture/public-api.test.ts`
  freezes the export list. The plugin-api leaf scan now also flags a
  self-import of any core subpath outside plugin-api.

- 2026-09-15 (this session): `scripts/install.sh` one-liner installer. Clones
  (or reuses) source, links `minimal-agent` and `ma` onto
  `~/.minimal-agent/bin` plus `~/.local/bin`, never runs `bun install`.
  `bunx github:...` is documented as a dead end (`workspace:*` plus
  toolchain). Coverage in `src/e2e/install-sh.test.ts`. The `minimal-agent`
  wrapper now resolves PATH symlinks to the checkout.

- 2026-09-10 (this session): feat: multi-mode compact. `/compact` takes
  `[mode] [tail=N] [focus="..."]`. Modes are `remote|tail|local|fork`.
  Defaults are mode `local` and tail `6`. Manual compact blocks. Auto compact
  on context exceed tries remote first, else local. Local summaries use a
  fixed 7-heading template. README documents the syntax under Sessions.

- 2026-08-31 (this session): `AuthCredentialInfo` gains optional provider-owned
  `details` rows (`AuthCredentialDetail`: key/label/value). Host `auth-status`
  renders them verbatim after the built-in metadata lines so providers can
  surface display-safe identity/quota diagnostics without the host interpreting
  secret bags. Coverage in `auth-status.test.ts`.

### Changed

- 2026-11-01: S24 file moves (no behavior change). `executeToolRound` is now
  in `src/loops/tool-round.ts`. The tool executor adapter and the build step
  (`buildAgentCore`, `openAgentCoreSession`) are now one file,
  `src/loops/assemble.ts`. The output-preview tag and hint text are now
  markdown prompts in `src/prompts/runtime/output-preview*.tmpl.md`, loaded
  through `src/tools/PROMPTS.ts`. The subpaths `./host-kit/build-agent-core`
  and `./host-kit/tool-executor-adapter` keep their names and export names.

- 2026-11-01: the tool round is UI-free (S24, S29). Core emits plain tool
  view events to an optional `toolView` port (`ToolViewPort` from
  `./host-kit/tool-executor-adapter`) and builds no transcript rows. A host
  builds its own rows from the events. The CLI does this in its tool view.
  Core never reads the terminal size: the `ToolExecutorAdapter` has no
  `process.stdout` default any more. `ToolEnvValues` is now `{ env }`, so
  the host picks the env names (for example `COLUMNS` and `LINES`) and core
  keeps `TERM=dumb`. New `tool_result` session records carry no `display`,
  `displayHeader`, or `displayFooter`. Old records with them still restore,
  and core ignores the fields (`restore-legacy.test.ts`). The replay
  renderer result type is `unknown` to core. The model-facing bytes and the
  JSON-route bytes do not change (`tool-outcome-golden.test.ts`).

- 2026-11-01: breaking change on `./host-kit/modes`. `ModeManager`
  returns host-neutral style data, not SGR strings (rule 14).
  `resolved()`, `resolvedForId()`, and `statusStyle()` return the new
  `ModeStyle` / `ModeSurfaceStyle` types. A surface holds `fg` and `bg`
  as a `ModeColor` (`token`, `hex`, `ansi256`) or `null`, plus `bold` and
  `dim`. A token is a palette name (`blue`, `pink`, ...) or a semantic
  token (`accent`, `accent-soft`, `brand`, `danger`, `muted`). The host
  maps tokens to its output. The CLI maps them to SGR in its
  `terminal-kit/mode-style.ts`. The third constructor argument is now
  `theme?: ThemeKey` (it was `env?: StyleEnv`). `promptPrefix()` and
  `promptPrefixForId()` are removed from `ModeManager`, and
  `ModeProviderAdapter.promptPrefix()` is removed. The host builds the
  prompt prefix. `ModeProvider.promptPrefix` is deprecated. New exports:
  `resolveModeStyleTokens`, `styleFromLegacyColor`, `detectModeTheme`,
  `MODE_COLOR_NAMES`, `MODE_SEMANTIC_TOKENS`. The manifest `style` and
  `color` fields do not change. The internal bridge
  `src/internal/terminal-render/mode-style.ts` is deleted.
- 2026-10-31: Config and logging import no CLI or UI code (S26). The env
  and config key names for system-prompt overrides are core config data
  (`src/config/system-prompt-override-keys.ts`); the CLI flag names stay in
  `src/cli/system-prompt-override-flags.ts`. `SubmittedAtStyle` and
  `normalizeSubmittedAtStyle` moved from `src/ui/` into `src/config/config.ts`.
  The net-dbg logger reads neither env nor config: the network client
  resolves the level once and passes it to `createNetDebugObserver({ enabled })`.

- 2026-10-31: `--debug` (`DEBUG=1`) output is Debug-severity diagnostics, not
  stderr text. It lands in the session log file, and on stderr with
  `MINIMAL_AGENT_LOG_STDERR=1`. `MINIMAL_AGENT_PREFLIGHT_DEBUG` is gone: a
  preflight adapter failure is always a Debug diagnostic.

- 2026-10-31: `AgentCore` is the one agent loop. The legacy `Agent` class
  (`src/agent/agent.ts`), its re-exports, and the unused legacy-to-canonical
  bridge loop in `adapter-legacy.ts` are deleted. Engine tests build
  `AgentCore` through the production factory with `buildTestCore`
  (`src/test-utils/test-core.ts`).

- 2026-10-31: Docs and metadata match the tree. The package description
  says "agent engine", not "terminal agent harness". The provider standards
  use `ma-llm-<name>-plugin` paths in the plugins repo. The provider
  decoupling doc reports current ratchet counts (I2 and I3 baselines empty)
  and records the plugin move (Wave G) as done. README and AGENTS.md drop the
  removed legacy transport env var and the old in-core provider plugin layout.

### Removed

- 2026-11-01: (S24, S29) `ToolTranscriptFormatter`, `PLAIN_TOOL_TRANSCRIPT`,
  `CodeHighlighter`, `CodeHighlightRequest`, `UnifiedDiffColors`,
  `UnifiedDiffHighlightRequest`, `ToolPresentation`, `ToolHeaderRowsOptions`,
  `ToolPreviewOptions`, and `StreamedTailOptions` from
  `./host-kit/tool-executor-adapter`. The `presentation`, `writeTranscript`,
  `transcriptFormatter`, `codeHighlighter`, and `toolTimeTracker` deps of
  `ToolExecutorAdapter` and `buildAgentCore`. `ToolRegistryAdapter.presentation()`.
  `ToolExecResult.display`. `plainDiffDisplay` from `./host/diff`.
  `DerivedDisplay` from `./host/session-replay-sidecar`. The `presentation`
  argument of `SessionStore.appendToolResult` and of the session
  persistence adapters.
- 2026-11-01: **BREAKING** (decision 39). The plan OAuth client left core.
  `./host/auth` keeps only the `AuthResult`, `TokenAuthResult`, and
  `ProviderNativeAuthResult` types and `legacyAuthToProviderAuth`. Removed:
  `ANTHROPIC_PLAN_OAUTH`, `getAuth`, `GetAuthDeps`, `readCredentials`,
  `writeCredentials`, `clearCredentials`, `refreshAccessToken`,
  `getOauthRefreshConfig`, `OAuthRefreshConfig`, `TokenRefreshResult`,
  `CredentialsData`, `credentialsToSecrets`, `secretsToCredentials`. The
  provider plugin owns login and refresh through `ProviderPlugin.oauthLogin`.
  It uses the same store key, so stored credentials load with no change. Use
  `resolveStartupAuth` (`./host/provider-auth`) to resolve auth, and
  `clearProviderCredentials` or `clearAllCredentials`
  (`./host/auth-strategies`) to log out. The `llm:complete` host capability
  now resolves the credential of the model's own provider. Before, it always
  read the plan OAuth entry. The provider-token baseline is empty.

- 2026-11-01: BREAKING (decision 38, S37). `ItemStartedEvent.label` is
  removed from the `AgentEvent` type. Read `toolName`. An in-process sink
  no longer gets `label`. The json and stream-json output keeps `label`
  byte-for-byte: `serializeEvent` and `serializeStreamJsonLine` add it back
  on a `tool_use` `item_started`, just before `toolName`.

- 2026-11-01: BREAKING (S37). The UI callbacks are removed from
  `AgentCore.run` and `Session.run`. Use events and ports instead:
  - `onThinkingChunk`: the `thinking_delta` event.
  - `onThinkingStart`, `onThinkingStop`, `onTextStop`: the new
    `block_started` and `block_stopped` events.
  - `onNotice`: the `notice` event. The core no longer writes a plain
    notice line to a transcript. A text host prints
    `formatTurnNoticePlain(event.notice)` itself.
  - `drainQueuedUserText`, `onQueueInject`: the `inputQueue` host port
    (`take`, `injected`), given when the session or core is built. The
    loop also emits a `user_message` event with `queued: true`.
  - `beforeReflectionCheckpoint`: the `reflectionGate` host port.
  `TranscriptSink`, `TranscriptLine`, and `AgentCoreConfig.transcriptSink`
  are removed. `RuntimeCoreDeps.transcriptSink` is removed. The per-run
  `askUser` option stays. On `SendOptions`, `onThinkingStart`,
  `onThinkingStop`, and `onTextStop` are replaced by one
  `onBlockEdge(edge)` hook that `AgentCore` sets itself. A host value for
  it is dropped. The internal `truncationNotice` prompt helper is renamed
  `truncatedOutputNotice`.
- 2026-11-01: The CLI moved to minimal-agent-cli. Core is a library. S34
  Phase 4 deleted the terminal host from core: `src/index.ts`, the
  `minimal-agent` wrapper, `package.json#bin`, the `start` script, and the
  `src/host`, `src/cli`, `src/ui`, `src/input`, `src/terminal`, and
  `src/e2e` folders. It also deleted the abort bus, the stderr log sink,
  safe-stdout, three of the four `src/internal/terminal-render` bridge
  files, `src/test-utils/fake-terminal.ts`, and `src/session/draft-store.ts`
  (no importer in core or the CLI). The migration manifest and its scan and
  test are gone too: nothing leaves core now. The core-to-host import
  ratchet is now 0 with no exception. The direct-write ratchet has no allow
  list, and the timer inventory has no `cli` entries.

- 2026-10-31: Round and retry caps. `maxToolRounds`, the tools-disabled
  wrap-up turn, the `tool_rounds_capped` notice, and the emergency-cap
  prompts are gone. The compact summary no longer stops after 3 transport
  retries. The deprecated terminal-less retry sentinels are deleted. The
  two D20 continuation guards stay; they end a turn `truncated`, not the
  run. `simple-send.ts` is gone (`AgentCore.send` sends one attempt itself),
  and the dead `terminalMetrics` port is removed.

- 2026-10-31: Dead UI seams and helpers: `src/sdk/ansi.ts` (no importers),
  the `TranscriptFormatter` and `ToolTranscriptParts` port types (no
  implementer), and `markErrorAsDiagEmitted` / `isErrorDiagEmitted` (never
  set, so the two REPL checks that read them were always false). Output does
  not change.

- 2026-10-14: Model-facing prose follows the writing-style rules. Prompts,
  tool descriptions, truncation notices, compact notes, and loader/error
  strings drop semicolons, em/en dashes, unicode arrows and ellipses, and
  filler words. The compact prompt drops shout-case. `truncationNotice` now
  reads `..., N/M lines, cut at byte ...` (comma, not semicolon). No behavior
  change. `src/prompts/prompt-audit.test.ts` now enforces no semicolons, no
  emoji, no sycophancy or signposting phrases, and no `---` before a heading.
  It masks code fences, inline code, and URLs first. Work by Edward
  (`dc78a09d`).

### Fixed

- 2026-11-11: provider-correct structured output format. `CanonicalRequest`
  gets `purpose?: "title"`. The Anthropic builder treats a request as a title
  probe only by that marker. Before, every `json_schema` request with no
  tools counted as a title probe, so a user schema run lost the default
  effort. `output_config.format` is now exactly `{ type, schema }`, and a
  `strict` tool sends `strict: true`. OpenAI Chat sanitizes
  `json_schema.name` (default `"output"`) and sends `strict: true` only when
  the request asks for it and the model has `structuredOutputs`.

- 2026-11-01: BREAKING (decisions 11, 34). A session with no person never
  waits for an ask. `SessionOptions.askUserFallback` now defaults to
  `"none"`. With no `ports.askUser` and no per-run `askUser`, a preflight ask
  resolves at once. Core emits an `ask_denied` notice and a
  `preflight.ask-denied` diag event, and sends the request unchanged. Before,
  the default `"registry"` waited for `session.answer` with no deadline. A
  host that answers asks through `session.answer` must now pass
  `askUserFallback: "registry"` and the new `askDeadlineMs`. Without
  `askDeadlineMs`, `openSession` throws. On the deadline, the ask resolves
  with its `isDefault` option. With no default option it resolves `null` (a
  decline, which cancels that send). A `session.ask-deadline` diag event
  records it. `PendingAskRegistry` now takes a required
  `{ deadlineMs, onDeadline? }` options object.

- 2026-11-01: synthetic tool results are persisted (decision 31, WP-17c). A
  tool result that core makes itself, with no tool run (the note for a tool
  call a kill cut off, and the result of a call an abort skipped), now reaches
  the session log in hosts whose `appendToolResult` does nothing (the CLI).
  Before, the pair lived in memory only, so a second `--resume` dropped the
  cut-off `tool_use`. New optional port method
  `SessionPersistence.appendSyntheticToolResult`. `SessionPersistenceAdapter`
  implements it. Without it, core calls `appendToolResult`.
- 2026-11-01: loader diagnostics with many sessions (S20). With two sessions on
  one plugin loader (web does this), the diagnostics of a run reach the log of
  that run's session. Before, the last attached session got all of them.
  `Session.run` sets a run scope (`src/diagnostics/run-scope.ts`, with
  `AsyncLocalStorage`). Outside a run, the loader reports to the one attached
  session, or to its runtime-level handle when two or more are attached.

- 2026-11-01: net-dbg `warnLoggerErrorOnce` latched once for each process. So
  only the first session that had a logger failure got the warning. The latch
  is now per diagnostics handle. Each session handle gets one warning (WP-09c).

- 2026-10-31: host mode (`--host-mode <id>`) review fixes.
  `HostRuntime.getEffort` reads the live session after `setModel` resets
  the effort (before, it showed the stale boot value).
  `HostSession.run` applies the `turn.willStart` chain like the one-shot
  run. A halting hook stops the turn with the `turn.blocked` error.
  A second `SIGINT`/`SIGTERM`, or no end 5 s after the first, now ends
  the process, so a stuck entry cannot block shutdown. The `<id>` after
  `--host-mode`, and every later arg, is no longer read as a prompt.
- 2026-10-31: `AgentCore.setModel` accepts an id with a `[1m]` / `[2m]`
  suffix. It looks up the base id and stores the raw id. Before, it threw
  "unknown model", also on a re-select of the current `[1m]` model.
- 2026-10-31: stream-json exits through `process.exitCode`, so a slow pipe
  reader keeps the last lines. On a paused or failed run, the event-stream
  route called `process.exit(1)` right after the last line. With a slow
  reader, Bun dropped the queued tail, including `run_finished`: measured
  5 of 5 runs at 1 MB and at 4 MB, 0 of 5 at 70 KB. The route now sets the
  exit code and returns, and the process ends by itself with code 1. The
  json route uses the same path. The text route does not change.
  `main().catch` in `src/index.ts` still calls `process.exit(1)` after
  writing the failure lines. Those lines are small, but large output
  written before such a failure keeps the same risk. A follow-up covers it.

- 2026-10-31: a non-interactive `--resume` no longer prints the human
  resume header and history replay to stdout. The old check matched only
  the literal `--prompt` flag, so a positional prompt or `-` (stdin) still
  printed them before the first JSON line of a stream-json run. The check
  now reads the parsed prompt source, the same value that picks the REPL
  path. The interactive resume does not change.

- 2026-10-31: `bun test` runs the whole suite. `EditorController` quit paths
  called `process.exit(0)`, which ended `bun test` early with exit 0, so CI
  reported green on a partial run. Quit paths now call an injectable
  `exitFn`, and `bunfig.toml` preloads `src/test-utils/guard-process-exit.ts`,
  which makes a direct `process.exit` throw inside tests.

- 2026-10-04: Built-in tools accept Cursor-shaped `path` (Read/Write/Edit) and
  still reject missing or mistyped required fields before filesystem, locks,
  mode, or hooks run. Canonical `file_path` / `content` win over aliases.
  Invalid canonical values do not fall through. Write still keeps the
  `contents` alias and Glob still keeps `glob_pattern` / `target_directory`.
  Plugin and custom tools are not remapped. File-lock wiring moved to
  `src/tools/file-lock.ts` so `tools.ts` stays under the line cap. Coverage in
  `src/tools/tool-input.test.ts`. Work by George (`cb1ff578`).

- 2026-10-01: `/compact` no longer hangs on Anthropic OAuth (plan) auth.
  Found by Janice (`4dce3e26`), fixed by Debra (`ececd7f8`).
  - Root cause: local and remote compaction sent a bare summary system prompt.
    Plan auth needs the provider's billing and Claude Code identity preamble,
    so Anthropic answered a fake `rate_limit_error` 429. Compact retried tagged
    transport errors forever, so `/compact` hung on the slow backoff curve.
  - Fix: build the compact `system` through the active provider plugin's
    `resolveSystemPrompt`, the same path live turns use. Cap tagged transport
    retries in the local summary at 3, then fall back to the stub checkpoint.
  - Coverage in `src/agent/run-compact.test.ts`.

- 2026-09-15 (this session): system-prompt resolution is scoped to the
  selected provider. Bare model ids claimed by several providers (e.g.
  `claude-opus-5` by anthropic and opencode-zen) used the global
  last-write-wins entry, so the wrong plugin hook ran and the Anthropic
  billing preamble never shipped. OAuth then got a bare 429. Fix threads
  `providerId` through `resolveSystemPromptForModel` (agent, agent-core,
  startup hashes) with global fallback. Coverage in `system-prompt.test.ts`.

- 2026-09-02 (this session): Write accepts Cursor-shaped alias `contents` for
  `content` and rejects a missing or non-string body with a field error instead
  of `Bun.write(...): expects a Blob-y thing to write`. Empty `content` still
  creates an empty file. Replay diffs (`deriveWriteDisplay`) resolve through
  the same seam. Coverage in `write-input.test.ts`.

- 2026-08-21 (this session): Large multi-line pastes no longer stack ghost
  editor frames (`ASK ❯ ─── ^ N more lines` rows) into scrollback. Two
  defects compounded: the renderer wrapped content at `output.columns`
  while the compositor's erase walk-up re-measured at its own
  `effectiveColumns()` (which falls back to `$COLUMNS`), so PTY wrappers
  with broken WINSZ propagation (asciinema, script(1)) desynced erase
  geometry and each repaint committed the previous frame; and every stdin
  chunk of a paste burst painted a full frame synchronously. Fix: the
  controller pins its resolved cols on the compositor (`setDrawColumns`)
  as the single source of truth, and paste bursts coalesce to one trailing
  repaint. Regression coverage at unit level (FakeTerminal scrollback,
  env-fallback + cols-disagreement seams) and integration level (real
  `Bun.Terminal` PTY with disagreeing COLUMNS). Commit `ff34290`.

- 2026-08-18 (this session): Peer HTTP/2 `RST_STREAM` (`HTTP/2 stream aborted`)
  is tagged `network_error` and retried instead of stopping the turn. Cursor
  bidi keep-open streams hit Node's `aborted` event; that throw was untagged,
  so `withRetry` treated it as a bug. User `AbortError` still propagates.

- 2026-08-18 (this session): Glob accepts Cursor-shaped aliases (`glob_pattern`,
  `target_directory`) and rejects a missing or non-string pattern with a
  field error instead of `Glob.constructor: first argument is not a string`.

- 2026-08-17 (this session): `--effort --fast` no longer treats `"--fast"` as
  the effort level (`effort "--fast" is not supported`). `--effort` now
  requires `low|medium|high|xhigh`; a following flag errors with
  `Got "--fast"` and hints `--effort <level> --fast`. `--fast` stays an
  independent speed flag.

- 2026-08-13 (this session): Host-owned editor picker regression coverage now
  matches the Picker primitive's violet `▌` selection marker, keeping the new
  prompt/history overlay tests aligned with the shared queue-style rendering.

### Fix: Human-paced Escape gestures and queue-style pickers

---
id: "2026-08-10-escape-picker-interactions"
type: fix
status: landed
created-at: "2026-08-10T08:31:42-0400"
updated-at: "2026-08-10T08:31:42-0400"
---

Double Escape now permits a human-paced 500ms interval while preserving the
single-Escape abort route. Generic picker selections reuse the queue's dark
violet full-width bar, violet marker, and high-contrast text.

### Fix: mdstream fence bodies invisible on raw-mode TTYs

---
id: "2026-08-09-raw-mode-mdstream-fence-paint"
type: fix
status: landed
commits: ["7cf4357"]
created-at: "2026-08-09T17:01:24-0400"
updated-at: "2026-08-09T17:03:59-0400"
---

Raw-mode stdin clears `ONLCR`, so mdstream's bare `\n` left the cursor mid-row
after styled fence lines and painted the next border (or the next line) at the
wrong column: empty `── bash ──` boxes with the body seemingly missing.
`Compositor.writeStream` / `flushStream` now normalize LF → CRLF on TTY writes,
treat mdstream's `\r\x1b[K` erase as a redraw clear for `streamCol`, and the
REPL formatter sink keeps one structural trailing newline with the chunk body
(only extra blank separators stay held). Regression coverage in
`compositor-mdstream.test.ts` / `compositor.test.ts`. Observed on Judy
`64a910f8` (net-dbg and transcript still had the filled fence).

### Feat: Session dump artifact paths

---
id: "2026-08-09-session-dump-artifact-paths"
type: feat
status: landed
created-at: "2026-08-09T20:34:40-0400"
updated-at: "2026-08-09T20:34:40-0400"
---

`--dump-paths` reports the computed transcript, session sidecar, blob, index, and
network-debug paths for a saved session without changing the default transcript
format. Path resolution follows `MINIMAL_AGENT_HOME` and reports artifact status.

### Feat: MA-394837 agent loop SDK refactor enabling wave

---
id: "2026-08-07-ma-394837-sdk-refactor-enabling-wave"
type: feat
status: landed
commits: ["9596da8", "0bf68cc"]
created-at: "2026-08-07T13:45:26-0400"
updated-at: "2026-08-07T13:45:26-0400"
---

Repointed production imports off the legacy `agent.ts` barrel onto SDK owners
(`runRepl`, ANSI `c`, tool-lifecycle payloads), extracted
`src/sdk/conversation-history.ts` and `src/sdk/tool-lifecycle.ts`, added the
TypeScript-7 AST `sdk-port-boundaries` scanner (genuine-Node child with
NODE=bun rejection; exported-but-explicitly-unstable `typescript/unstable/*`
exact-pinned to 7.0.2), and characterized `InteractiveSession` reflection /
transcript seams. Core README reframed as presentation-free SDK; the terminal
client is being moved to `minimal-agent-cli` (transitional entrypoint until
Program 3B cutover). Follow-ups before merge (file-tracking lane): recordedAt-vs-file-order
replay, same-ms mtimeNs detection.

### Chore: Husky, Commitlint, and CI Action bumps

---
id: "2026-08-05-husky-commitlint-ci"
type: chore
status: landed
created-at: "2026-08-05T11:30:00-0400"
updated-at: "2026-08-05T11:30:00-0400"
---

Conventional Commits enforced locally via Husky `commit-msg` → Commitlint
(`commitlint.config.js`, `prepare` → `husky`) and in GitHub Actions via a
`commitlint` job (`bun run commitlint:last` on push; PR range lint). The same
hook runs agent-gated `scripts/check-agent-coauthor.sh` when
`MINIMAL_AGENT_SESSION_ID` is set (humans unaffected). Workflows use
`actions/checkout@v7` and `actions/upload-artifact@v7`; install steps set
`HUSKY=0`.

### Fix: Tool output mega-line / TUI flood caps

---
id: "2026-08-05-tool-output-mega-line-caps"
type: fix
status: landed
created-at: "2026-08-05T11:00:00-0400"
updated-at: "2026-08-05T11:00:00-0400"
---

Hardens buffer, model, blob, and TUI layers against single mega-lines
(minified bundles). Bash/Grep drain 512 KiB, universal per-line clamp
8,192 chars, `_raw` blob 256 KB, TUI preview width 200, streamed tail
never word-wraps raw mega-lines. Read image/`blocks` paths untouched.

### Fix: Resume credential pin scoped to session provider

---
id: "2026-08-01-resume-credential-pin-provider-scope"
type: fix
status: landed
created-at: "2026-08-01T15:25:00-0400"
updated-at: "2026-08-01T15:35:00-0400"
---

`--resume` no longer applies `meta.credentialName` when the effective
provider differs from the session's `meta.provider`. Credential names are
per-provider store keys; a grok pin on a cursor override previously fataled
with "no credentials for provider cursor" even when cursor was logged in.
Mismatch skips the pin via `diag.warn("auth.resume-pin", …)` (buffered
through the scrollback sink so the startup tree does not tear) and uses
the new provider default. Legacy sessions without `meta.provider` still
reuse the pin. Covered by `resolve-credential-name.test.ts` (pin gate) and
`provider-boot.test.ts` (diag emit, no mid-banner `console.error`).


### Feat: Lifecycle policy seams + InteractiveSession on AgentCore

---
id: "2026-08-01-lifecycle-policy-seams"
type: feat
status: landed
created-at: "2026-08-01T12:00:00-0400"
updated-at: "2026-08-01T12:00:00-0400"
detail: "docs/hooks.md"
---

Typed `PolicyDecision` / `LifecyclePort` (DIP); host `LifecyclePortAdapter`
maps HookBus chain/async channels. Wired emits: `tool.willInvoke` (after mode
gate), `message.willSend`, `tool.didBatch`, compact, session/cwd/instructions,
`subagent.willSpawn`. Production REPL/`--prompt` uses Tier-2
`InteractiveSession` over `AgentCore`. Headless `turn.willStart` parity.
Docs: `docs/hooks.md`. Reference plugin: `ma-policy-ref-plugin` (disabled).

### Fix: OpenAI Chat thinking_stop before first text (orphaned response prefixes)

---
id: "2026-07-30-openai-chat-thinking-stop-before-text"
type: fix
status: landed
created-at: "2026-07-30T18:11:00-0400"
updated-at: "2026-07-30T18:11:00-0400"
---

DeepSeek Chat Completions transition chunks carry both the first visible token
and `reasoning_content: null` (e.g. `content:"Pre"`). The translator emitted
`text_delta` before `thinking_stop`, so the REPL's `onThinkingStop` blank-line
separator landed mid-word — orphaned bright prefixes (`Pre` / `Plug` / `All`)
in scrollback while JSONL stayed correct (session `19b57514`).

Fix: handle reasoning before text; close any open thinking block before
`text_start` / tool-call deltas (same order as Ollama). Canonical
`plugin-api/src/llm/openai-chat.ts`; plugins vendored copies synced.
Regression tests in `openai-chat.test.ts` + fixture order assert.


### Fix: Grok false mid-stream `stream_idle` from billing / shared request ids

---
id: "2026-07-24-stream-idle-billing-isolation"
type: fix
status: shipped
created-at: "2026-07-24T02:50:00-0400"
updated-at: "2026-07-24T02:55:00-0400"
commits: ["ff4a1ab", "7c91bc7", "bf35061"]
---

Grok OAuth turns often logged mid-stream `stream_idle` ~30s after headers when a
concurrent `GET /v1/billing` shared the LLM stream's request id and lifecycle
hooks — billing JSON ended pre-stream and armed the wrong idle clock. Separate
from real upstream silence (e.g. mid tool-arg pauses), which still trips at 30s.

Fix: request-local lifecycle at the NetworkClient body tap; `bindPrimaryStreamRequest`
gives unique wire ids and attaches activity/watchdog only to the primary stream
(SSE/NDJSON/connect+ at headers, or `llm-stream` policy tag); denylist billing /
OAuth / quota labels; single-fire stall diagnostics; Notice-level retry recovery
so TUI warn slots clear. Mid-stream idle stays 30s (thinking-open 5 min).


### Fix: explicit `protocol: "h2"` NetworkClient routing (Cursor Connect)

---
id: "2026-07-24-explicit-h2-network-routing"
type: fix
status: shipped
created-at: "2026-07-24T02:30:00-0400"
updated-at: "2026-07-24T02:35:00-0400"
---

`NetworkClient.request({ protocol: "h2" })` always selects a registered
`Http2Transport`, even when `MINIMAL_AGENT_TRANSPORT=fetch` makes fetch the
process-wide primary. Without an always-registered h2 map entry, explicit pins
silently fell through to fetch — unusable for Cursor AgentService/Run
Connect/protobuf streaming (Bun fetch is malformed on that stream; host
Http2Transport is node:http2).

Also: `close()` tears down every distinct configured transport (including the
always-on h2 pool); protocol pins and `allowFetchFallback: false` never
fallback to fetch; request `transportHint` reflects the transport that will
actually serve the call (net-dbg accuracy). Focused tests cover pin-under-fetch
and exactly-once multi-transport close.


### Fix: scrub embedded `data:*;base64` URIs in tool text (token waste)

---
id: "2026-07-23-embedded-payload-scrub"
type: fix
status: shipped
created-at: "2026-07-23T16:41:00-0400"
updated-at: "2026-07-23T16:55:00-0400"
---

Whole-body binary-guard does not catch base64 **inside** otherwise-valid UTF-8
(e.g. Fetch markdown with inlined `data:image/png;base64,…`). New pure scrub:

- `src/tools/embedded-payload-scrub.ts` — continuous data-URI base64 above 256
  chars → `<ma::agent::redacted-asset …/>` + `<ma::agent::context-sanitizer …/>`.
- `tool-round` runs scrub **before** transcript paint; pre-scrub body kept for
  blob recovery (`rawForBlob`). Skips `binary: true` and multimodal blocks.
- `session-dump` re-scrubs so `ma sessions dump` no longer prints megabase64.
- Loader max-lines: `pluginToolDefinitionFromTrigger` moved into
  `loader/helpers.ts` (binary opt-in inject stays).

### Fix: withhold binary tool results from model context (opt-in `binary`)

Tools that return PDF/image/zip-like bodies (Fetch `format: original`,
`cat foo.pdf` via Bash, …) no longer dump UTF-8 mojibake into the model.
Core adds a defense-in-depth guard in `tool-round` plus a schema injection
path for tools that declare `mayReturnBinary`:

- `src/tools/binary-guard.ts` — classify bytes/text, format
  `<ma::agent::binary-result …/>`, inject `binary?: boolean` into
  input schemas, base64 opt-in under a 48 KiB raw cap.
- Plugin-api `ManifestTrigger.tool.mayReturnBinary`; loader injects the
  opt-in arg via `getExtraTools()`.
- `tool-round` rewrites binary string content **before** transcript paint
  and **after** blob capture so the annotation carries a real path; media
  `blocks` (Read images) and user-message document uploads are untouched.

### Feat: editor buffer style spans + `turn.willStart` model rewrite seam

---
id: "2026-07-15-editor-buffer-styles-turn-will-start"
type: feat
status: in-progress
created-at: "2026-07-15T01:45:31-0400"
updated-at: "2026-07-15T01:45:31-0400"
---

Host support for live input highlights and dual-representation user text
(e.g. intercom `@`-mentions):

- **`editor.buffer.styles` channel** (`broadcast-sync`): plugins emit
  `{spans: [{start, end, style}]}` with code-point offsets into
  `buf.toString()` (`\n` counts as 1). Host calls
  `EditorController.setBufferStyles`. Empty spans clear.
- **`EditorRenderer`**: optional `styles` / `setStyles` paint SGR around
  matching ranges without shifting cursor or wrap math. Styles bake into
  submit `commitLines` so scrollback keeps the highlight.
- **`turn.willStart` chain** (payload `{text}`): REPL queue-drain emits
  before `agent.run(text)`. Listeners may rewrite model-facing text or
  `{halt: true}` veto. Scrollback still uses original `commitLines`.

First consumer: `ma-intercom-plugin` peer `@`-mentions.

### Fix: never-give-up terminal-less recovery + thinking-aware stream idle (Grok / OpenAI Responses)

---
id: "2026-07-12-never-give-up-terminal-less-thinking-idle"
type: fix
status: shipped
created-at: "2026-07-12T13:34:39-0400"
updated-at: "2026-07-12T16:40:00-0400"
incidents: ["1a142f42", "37b74c04"]
commits: ["15c295c", "cbcf119", "dc020a2"]
research: "private/retry-fix/PROGRESS.md"
agents: ["a13e2942", "6faa19ac", "8f604191", "1ede4282", "8ea18cae", "4b74ea60"]
---

Grok high-effort reasoning streams that paused more than ~30s mid-think were
idle-aborted by the provider-neutral watchdog, then mis-tagged as
`stream_closed_without_terminal` when the aborted body drained without a
terminal SSE event. The post-`15c295c` / `cbcf119` policy then took **one**
near-zero pre-effect transport retry and **`failTurn`**, hard-stopping the
agent with `OpenAI Responses stream closed without a terminal event
(truncated)` (session `37b74c04`, ~33s elapsed, `saw-reasoning: true`,
`completedToolCalls: 0`). That violated the harness principle that multi-day
agentic runs must outlive transient transport EOF without a human re-prompt.

**Watchdog** (`src/llm/transport/watchdog.ts`):

- While a thinking/reasoning block is open, idle budget is **5 minutes**
  (`DEFAULT_THINKING_IDLE_TIMEOUT_MS`), not the ordinary 30s
  `streamIdleTimeoutMs`. After `thinking_stop`, the ordinary idle applies again.
- If the watchdog has already set an abort reason (`stream_idle` /
  `attempt_too_long`), it **throws that tagged error and does not yield** any
  further events — so a synthetic adapter `stream_closed_without_terminal` on
  quiet drain cannot replace a real idle classification. Idle stalls stay on
  the forever **fast** retry curve.

**Pre-effect terminal-less policy** (`attempt-progress.ts` + `retry.ts`):

- **No completed tools** (empty or mid-reasoning / mid-stream with no closed
  tool_use): retry **forever** with polite capped exponential backoff (max
  5 min). Empty closes use a short base; midstream (saw reasoning or text)
  uses a multi-second base with a **≥1s floor** so the first retry cannot
  collapse to `after 0.0s` thrash. Only the caller's AbortSignal (Esc) stops
  the loop — no `failTurn` budget.
- **≥1 completed tool**: still **never re-POST** the same request body
  (`continueTurn` / bridge salvage). That remains the side-effect safety
  boundary from `15c295c`.
- Partial-text salvage and one local agent continuation from `cbcf119` are
  unchanged (bridge returns `end_turn` with preserved text when `sawText`
  without throwing into `withRetry`).

Diag curves: `terminal-less-empty` and `terminal-less-midstream` (replacing
the old one-shot `terminal-less-bounded` + `api.retry-terminal-less-stop`
fail path for pre-effect closes).

**Commits:** `15c295c` (post-tool salvage), `cbcf119` (mid-text continuation),
`dc020a2` (this never-give-up + thinking-idle fix).
Research handoff: `private/retry-fix/PROGRESS.md`. Restart the running agent
process to pick up the binary.

### Feature: AGENTS.md auto-load (`agents-md` plugin + `--no-agents-md`)

First-party plugin `ma-agents-md-plugin` (extended plugins repo) now loads
[AGENTS.md](https://agents.md) into the system prompt at session start: global
from the resolved agent home (`MINIMAL_AGENT_HOME/AGENTS.md`), then project from
`<cwd>/AGENTS.md`. Injection uses the standard `promptFragments` path, so both
the legacy `Agent` loop and modern `AgentCore` (`PromptContributorAdapter`)
receive it. Core adds a convenience disable flag:

- `--no-agents-md` / `--no-agents` (aliases for `--disable-plugin agents-md`)
- `MINIMAL_AGENT_NO_AGENTS_MD=1`

Also documented in `--help`. Config: `plugins["agents-md"].enabled = false` or
per-source `global` / `project` / `maxBytes`.

### Feature: system-prompt overrides (`--system-*` flags, env, config)

Every model-facing part of the system prompt can now be replaced or omitted at
startup: the whole core prompt (`--system-prompt`), the neutral identity, the
base instructions, the loop-safety paragraph, the tool-output-conventions
paragraph, the session-context block (plugin prompts), and the provider preamble.
Each part has a `--system-<part>` (inline text), `--system-<part>-file` (path),
and `--no-system-<part>` (omit) form; an empty string also means omit. The same
parts are configurable via `systemPrompt.*` in `config.jsonc` (a `false`/`null`
value means omit, a string means replace, a `*File` key names a file) and via
`MINIMAL_AGENT_SYSTEM_*` env vars. Precedence is CLI > env > config > default.

The design is a single shared tri-state override model
(`src/llm/system-prompt-overrides.ts`: `default | replace | omit`) resolved once
at startup and threaded identically into the legacy `Agent`, the modern
`AgentCore`, and the resume-drift `computeStartupHashes` — applied in exactly one
place (`resolveSystemPromptForModel` + `buildInstructionsBlockText`), so both
runtimes and the hash stay byte-consistent. With no overrides, the output is
byte-identical to before (cache-key stable). Safety: the provider preamble is
server-validated on some plans (Anthropic OAuth), so replacing/omitting it is
refused unless `--unsafe-system-prompt-overrides` is passed; conflicting flags
and missing `--system-*-file` paths fail fast at startup with exit 2; and
`--system-prompt` replacing the whole body ignores the individual part overrides
(the provider preamble is unaffected). No model-facing prose is hardcoded in
TypeScript — only flag names, keys, and error strings.

### Feature: `--output-format {text,json,stream-json}` on the modern agent core

Non-interactive runs (`--prompt`, `-`, a bare positional) can now select an
output format explicitly. `text` (the default) is unchanged: human progress to
stderr, the final answer to stdout when piped. `json` and `stream-json` both
drive the port-injected `AgentCore` and emit its structured `AgentEvent` stream
as JSON Lines on stdout (`turn_started` → `item_started` → `item_completed` →
`turn_completed`, with `tool_result` carrying the `tool_result.id ===
item_started.id` join for tool turns). `json` is buffered; `stream-json` flushes
each event live and additionally emits token-level `text_delta` and
`thinking_delta` events as the model streams.

`--json` is now a documented alias for `--output-format json`. This changes its
wire output: it previously emitted a single synthetic final-answer line
(`item_completed` with id `"final"`); it now emits the full event stream, where
the answer is the real `item_completed` (itemType `text`) followed by
`turn_completed`. A consumer that read the last line for the answer should
instead take the `item_completed` text event (or the terminal `turn_completed`
for stop reason + usage). `--output-schema` enforcement is unchanged and stays
on the buffered validate-before-stdout path.

### Architecture: provider-decoupling ratchet + first cleanups

New fitness test (`src/architecture.provider-decoupling.test.ts`) enforces
the layering rule: provider-specific code (names, model ids, wire details)
lives in `plugins/<provider>/`, never `src/` core — comments may reference
providers, code may not. Violations must match a frozen, shrink-only
baseline, so new leaks fail CI immediately and cleanups must ratchet the
baseline down in the same commit. First cleanups shipped behind it:
Anthropic media limits moved behind the `ProviderAdapter.mediaLimits` hook
(core falls back to a neutral conservative floor), `--list-models` went
provider-neutral via the new `ProviderPlugin.listLiveModels` hook, the
beta-flag model gates unified into plugin-owned `beta-gates.ts` (both
transports now share one predicate — the drift class behind the fable-5
context-1m bug), and the tool-output redaction allowlist dropped its
vendor-specific header literal for a neutral session-id pattern.

### Feature: Claude Fable 5 in the model catalog

`claude-fable-5` (the public Mythos-class flagship launched 2026-06-09) is now
registered end-to-end: capabilities (Opus-4.8 twin, 1M context, 128K output,
adaptive thinking, effort up to `max`, no fast tier), flat $10 / $50 pricing,
`[1m]` alias, and the `context-1m-2025-08-07` beta on both transports. The
original symptom was a 429 on every OAuth request because the unregistered id
dropped the Claude Code preamble.

### Fix: fast-mode is capability-gated on the legacy transport

`speed:"fast"` (sticky `--fast` / `MINIMAL_AGENT_FAST=1`) used to reach the
wire for models with no fast tier (Fable 5, Sonnet, Haiku), which the server
rejects with 429 "Usage credits are required for fast mode". The legacy client
now consults the model registry's `speedFast` capability and drops both the
body field and the `fast-mode-2026-02-01` beta header (with a diagnostic
warning) when unsupported, matching the canonical transport. SessionInfo's
`fast` line now reflects the CLI flag too (the host mirrors the resolved state
into `MINIMAL_AGENT_FAST`) and cross-checks the capability so it never claims
a fast tier the model lacks.

### Build: scope the test gate to first-party source

`bun test` scanned from the repo root, so it descended into the gitignored,
vendored research clones under `private/` (a copy of `gemini-cli` and others)
that ship their own vitest suites and unresolvable dependencies. The gate
counted ~1300 of those as failures even though every first-party test passed.
New `bunfig.toml` sets `test.pathIgnorePatterns` to exclude `private/`,
`research/`, `work/`, `docs/internal/`, `.swarm/`, and `tmp/`, so the gate now
sees only `src/` and `plugins/` (4588 pass, 10 skip). `private/` is also added
explicitly to oxlint's `ignorePatterns`. No first-party code changed.

Also fixed a flaky assertion in `plugins/memory/cli.test.ts`: the `--limit`
test checked the raw list output with `not.toContain("e1")`, but bullet ids are
base36+hex, so `e1` could land inside a randomly generated id and fail the run
only under full-suite timing. The test now asserts on the body column.

### Feature: oversize images auto-fit instead of being rejected

A 4K screenshot used to bounce with a 400 (`image exceeds 5 MB`). Oversize
images are now downscaled and re-encoded to fit the wire budget before sending:
the long edge is capped at 1568px and a quality/scale ladder brings the encoded
bytes under the cap. New `src/media/transform.ts` (`fitImageToBudget`,
`canTransformImages`, `VISION_LONG_EDGE_PX`). `src/media/limits.ts` now measures
the base64-encoded size (`base64EncodedSize`), the real wire weight, for both
the per-item and per-request caps, and `src/media/resolve.ts` runs the fit pass
(`maybeFit`) and reports what it shrank.

### Feature: native clipboard paste (text and image) on Ctrl+V

`src/media/clipboard.ts` was rebuilt on Bun's native clipboard pipeline
(`Bun.Image.fromClipboard`, plus `clipboardText` / `clipboardImageSync` /
`hasClipboardImage`). The editor (`src/editor-controller.ts`) gained a Ctrl+V
handler that pulls system clipboard text, or a clipboard image routed through
the media interceptor into an `[Image #id]` token, even in terminals where
Cmd+V never reaches the process. When no handler is wired, Ctrl+V inserts no raw
control byte.

### Fix: macOS screenshot paths with Unicode spaces no longer shatter

Dropped or pasted screenshot paths like `Screenshot 2026-05-49.35␏PM.png` carry
a narrow no-break space (U+202F) or no-break space (U+00A0). The media
tokenizer and path detection (`src/media/detect.ts`, `ingest.ts`) now preserve
those code points instead of splitting on them. As a backstop, `src/tools.ts`
self-heals a path whose Unicode space was normalized to a plain space
(`resolveWhitespaceConfusablePath`): Read and Edit resolve the real file instead
of returning ENOENT, and Read notes that it resolved the path.

### Fix: connect-phase network failures retry instead of killing the turn

A failure before the first response byte (TCP connect timeout, ECONNRESET, DNS
EAI_AGAIN, HTTP/2 GOAWAY, "socket hang up") used to stop the agent. New
`src/network/transient-error.ts` classifies these as `network_error` and
`withRetry` (`src/llm/transport/retry.ts`) retries them on the fast curve. User
aborts (Ctrl-C) still propagate untouched. `src/client.ts` also now honors
`x-should-retry: false`, so a deterministic 400 (bad request, oversize image)
propagates at once instead of retry-storming.

### Feature: planning guidance in the system prompt

The `tasks` plugin injects a planning fragment (`prompts/planning.md`) that
tells the model to plan and work in phases with tasks and subtasks. It is
self-gated on `tools.userDefined`, so a model without tool support does not get
the guidance. New `plugins/tasks/handlers/planning_fragment.ts`, wired through a
`promptFragments` entry in the manifest.

### Feature: sub-agent result protocol via a tool, plus context-gated tools

A worker now finishes by calling `ReportResult({summary, artifacts?,
incomplete?})` as its final action. The handler (running in the worker process)
writes the result sentinel deterministically with an atomic temp-then-rename, so
the model never hand-rolls a path or JSON. The completion transport is layered,
best to worst: the `ReportResult` tool call, a manual sentinel write, a
distilled final message, then the `incomplete` floor, so a provider without tool
calling still works. When a worker reports findings but a contracted
`expectArtifacts` file is missing, the supervisor keeps the `incomplete` verdict
but salvages the summary onto the status, so `AgentResult` shows the findings
instead of forcing a transcript dive.

This rides a new general loader feature: a tool handler may export
`available(ctx)` to hide itself from the model's tool list for a turn (and drop
its system-prompt section when its whole tool surface is hidden). Dispatch is
not gated, a hidden tool's handler still runs if invoked, so availability
controls advertisement, not execution. `ReportResult` uses it to stay invisible
to the lead (which has no result path) while workers carry it. New
`plugins/sub-agents/lib/report.ts` + `handlers/report_result.ts`,
`available` plumbing in `src/plugins/loader.ts` and `types.ts`.

## 2026-06-04

### Fix: sub-agent workers inherit the lead's model (no silent downgrade)

Delegating to a built-in specialist silently ran the worker on a cheaper model:
`explorer` dropped to Haiku, `worker`/`planner`/`integrator` dropped to Sonnet,
even while the lead was on Opus. The model-precedence order in
`plugins/sub-agents/lib/service.ts` put the provider's per-role recommendation
(scout→Haiku, balanced→Sonnet, deep→Opus) AHEAD of the lead's own model, so the
"inherit the lead's model" path was dead for the specialists, which is most
spawns. The downgrade also made `incomplete · no deliverable` outcomes more
likely, since a weaker worker drowns on deep work.

Fix makes the role-recommendation rung opt-in. New `resolveAutoTier` reads
`MINIMAL_AGENT_SUBAGENT_AUTO_TIER`; `makeRecommendForRole` returns undefined
unless it is `1`, so workers now inherit the lead's model by default. Precedence
(default): per-spawn `model` → `MINIMAL_AGENT_SUBAGENT_MODEL` → lead's live model
→ omit `--model`. With `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1` the provider role
recommendation slots back in just below the env override. An explicit per-spawn
model and the env override always win.

Also corrected the model-facing docs that described the cheap default as
intended (`manifest.json` `model` param description, `PROMPT.md`, library/service
comments) and unwrapped the hard-wrapped worker result-protocol template to save
wire tokens. New tests in `runtime.test.ts` and `handler-deps.test.ts`.

## 2026-05-31

### Chore: clear the `bun run check` gate (lint, biome, refactor)

Drove the full gate back to green with zero warnings on the uncommitted feature
drop (sub-agents, schedule, config/usage/model-info plugins, prompt
markdownization, first-run onboarding, usage tracking).

- **oxlint** (1 error + 3 warnings → 0/0): removed an unnecessary template
  expression in `plugins/schedule/lib/box.ts`; replaced a spread-in-`map` with a
  conditional property assign in `PluginLoader.listCommandInfo`
  (`no-map-spread`); classified `src/plugins/loader.ts` into the existing
  `max-lines` override alongside the other large coordinator files.
- **agent.ts back under the line budget by extraction, not exemption.** The
  per-turn attachment / abort-marker / media-ingest / usage-persistence work
  pushed `src/agent.ts` from passing to 820 counted lines. Following the
  documented split pattern, moved `rollbackPendingTurn` and
  `repairOrphanedToolUse` into a new `src/agent/history-repair.ts` (pure
  functions; the `Agent` methods now delegate), with a focused
  `history-repair.test.ts`.
- **biome import-sort**: fixed the `import { abortBus, type AbortReason }`
  ordering in `src/agent/repl-live-area.ts`.
- Gate result: typecheck, lint (0/0), `format:check`, `biome:check`,
  `docs:check`, and `bun test` (4443 pass / 0 fail) all green.

### Fix: opus-4-8 tool-batch hallucination (gate interleaved-thinking off)

opus-4-8 under the `interleaved-thinking-2025-05-14` beta emitted huge parallel
tool batches whose interleaved thinking reasoned about same-turn tool results
that cannot exist yet (every tool in a turn runs after the turn ends), producing
a self-inflicted "results are stalling / batching" spiral and many duplicate
tool calls. Wire-proven against `.net-dbg` captures; absent on opus-4.7 under the
same beta, so it is a model-behavior change (4.7 -> 4.8), NOT the provider
refactor (the harness delivers every tool result correctly). Fix omits the
interleaved-thinking beta for opus-4-8 only (4.6/4.7 + sonnet keep it); escape
hatch `MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1` (see TODOS.md `T-7c3f02`).

### First-run onboarding: `bunx`-runnable, plugin auto-clone, welcome card

Makes the agent usable on a clean device with no manual install.

- **`bin` field** so it runs through `bunx github:gastonmorixe/minimal-agent`
  (public repos) or `bun add -g "git+https://x-access-token:<TOKEN>@github.com/…"`
  (private). Bun runs the TypeScript source directly: no build step.
- **First-run plugin bootstrap** clones the extended first-party plugins
  (`Fetch`, `Skill`, slash-menu, …) into `~/.minimal-agent/plugins` once. The
  loader gained a fourth root, `user`, with precedence
  `project > home > user > embedded`.
- **Token-aware + safe:** resolves `MINIMAL_AGENT_GITHUB_TOKEN` →
  `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`, injected via an inline git
  credential helper so the token never reaches argv, the clone URL, or the
  cloned `.git/config`. Best-effort: no git / offline / no token degrades to
  the embedded plugins, never crashes.
- **Welcome card** on a cold interactive start frames the one-time setup
  (sign in, fetch mdstream, fetch plugins).
- Controls: `MINIMAL_AGENT_NO_PLUGIN_SYNC=1`, `MINIMAL_AGENT_PLUGINS_REPO`,
  config `pluginSync` / `pluginsRepo`. Verified end-to-end in a clean
  `oven/bun:1.3-debian` container.


### Schedule plugin: TUI redesign + sub-minute intervals

- **New icons.** Replaced the `⏰` color-emoji (which ignored color) and the
  faint `◷` with monochrome, SGR-colorable glyphs: `⧗` (a point in time /
  one-shot) and `⟳` (a recurring loop). Tool-header icons now render bold so
  thin glyphs read at terminal size.
- **Colored boxed output.** `/loop` and `/schedule` confirmations, and the
  `Cron*` tool results, render in the same rounded `╭─ │ ╰─` box the host draws
  around tool calls (header glyph + cadence + timestamp, prompt in the body,
  id + expiry + cancel hint in the footer).
- **Width-aware live-bar footer.** Leads with the soonest task (`⧗` + short id +
  countdown), then lists the other task ids with a `+K` overflow marker;
  degrades to `⧗ next in 26s · N tasks`, then `⧗ N tasks`, then bare `⧗` as the
  terminal narrows. Glyph is gold normally, lime when the soonest task is due
  within a minute.
- **Sub-minute intervals fixed.** `/loop 10s` (and `CronCreate every:"10s"`) no
  longer round up to 1 minute. Cron is minute-granular, so sub-minute cadences
  now run on the dynamic pace with a new `CronEntry.intervalMs` that re-arms
  after each fire (floored at 1s). With the 1-second heartbeat a `10s` loop
  fires about every 10 seconds (a fire still waits for any in-flight turn).
- Model-facing tool-result `content` stays plain text; all color lives in the
  TUI-only surfaces.

## 2026-05-30

### Schedule plugin (`/loop`, `/schedule`, `Cron*` tools)

Run prompts on a schedule, ported from Claude Code's scheduled tasks.

- **Three tools** (`CronCreate`, `CronList`, `CronDelete`) the model drives from
  natural language ("remind me at 3pm", "every 5 minutes check the deploy").
- **Two commands** (`/loop`, `/schedule`) for direct user control.
- **1-second heartbeat** that injects due prompts between turns.
- Tasks persist at `~/.minimal-agent/sessions/<sid>.cron.json` and restore on
  `--resume` (unexpired tasks only).
- Disable with `MINIMAL_AGENT_DISABLE_CRON=1`.

See `docs/changes/2026-05-30-schedule-plugin.md`.

### Sub-agents plugin

Delegate work to background `minimal-agent` workers (`SpawnAgent` and friends),
watch them in a live fleet widget, and fold their distilled results back. Built
on generic seams; the core agent loop never learns the word "sub-agent". Disable
with `MINIMAL_AGENT_DISABLE_SUBAGENTS=1`.

See `docs/changes/2026-05-30-sub-agents.md`.

### Prompts as markdown

Plugin system-prompt fragments and tool descriptions move to markdown, composed
under role-typed `<ma::sys::*>` wrappers.

See `docs/changes/2026-05-30-prompts-as-markdown.md`.

### Tool routing + search directives

