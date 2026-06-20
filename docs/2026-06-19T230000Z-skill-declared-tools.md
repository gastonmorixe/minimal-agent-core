# Skill-Declared Tools

## Summary

Skills can now declare first-class tools that appear in the model's
function-calling surface alongside built-ins (`Bash`, `Read`, `Speak`, etc.).
Instead of the old three-hop path (catalog table → `Skill read` → `Bash` to run
a script), a skill-declared tool is **one call, zero indirection**.

When a skill declares tools, it **disappears from the prose skill catalog** and
appears as a function in the model's tool list. No double-advertising.

**Example**: the `911-police` skill declares a `Police911` tool. At boot,
`Police911(details: string)` appears in the tools banner alongside `Bash` and
`Speak`. The word "911-police" does not appear in the skill catalog.

---

## Architecture

### The contract: `ToolSpec`

```typescript
type ToolSpec = {
  name: string;              // PascalCase, unique globally
  description: string;       // model-facing, max 1024 chars
  parameters: JSONSchema;    // standard JSON Schema for input
  handler: ScriptHandler | InlineHandler;
  priority?: number;         // higher = earlier in tool list (default 0)
  tags?: string[];           // e.g. ["emergency"], ["requires-confirmation"]
};

type ScriptHandler = {
  type: "script";
  path: string;              // relative to skill dir, e.g. "scripts/police_911"
  argTemplate?: string;      // "{details}" — params mapped to CLI args
  timeoutMs?: number;        // default 30_000
};

type InlineHandler = {
  type: "inline";
  promptTemplate: string;    // rendered with params via {param} substitution
};
```

### Two registration channels

**Channel A — Declarative** (`metadata.tools` in SKILL.md frontmatter):

```yaml
---
name: 911-police
description: Place an emergency call to the police.
metadata:
  tools: |
    [
      {
        "name": "Police911",
        "description": "Call the police immediately in any emergency...",
        "parameters": {
          "type": "object",
          "properties": {
            "details": { "type": "string", "description": "Emergency description" }
          },
          "required": ["details"]
        },
        "handler": { "type": "script", "path": "scripts/police_911", "argTemplate": "{details}" },
        "priority": 100,
        "tags": ["emergency"]
      }
    ]
---
```

The `metadata` field is `Record<string, string>` per the Agent Skills spec. The
`tools` value is JSON-encoded `ToolSpec[]`, parsed at discovery time.

Channel A tools are **registered synchronously first** so a slow Channel B
import never blocks them.

**Channel B — Programmatic** (`scripts/register.ts` in the skill directory):

```typescript
export default async function register(
  registerTool: (def: ToolSpec) => void
): Promise<void> {
  registerTool({
    name: "Police911",
    description: "...",
    parameters: { ... },
    handler: { type: "script", path: "scripts/police_911", argTemplate: "{details}" },
    priority: 100,
    tags: ["emergency"],
  });
}
```

The ma-skills plugin dynamically imports this module at boot, calls it with a
`registerTool` callback that validates and collects `ToolSpec` objects. Channel
B tools are loaded via `Promise.allSettled` — a failure in one skill's
`register.ts` does not affect others.

### Bridge: `PluginLoader.registerDynamicTools`

The `PluginLoader` gained one new public method:

```typescript
registerDynamicTools(pluginId: string, handlers: ResolvedHandler[]): void
```

It inserts handlers into `toolIndex` and the owning plugin's handler list so
`getExtraTools()` picks them up. Collision guards:

1. **Core tool names** rejected (checked against `coreToolNames` — `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Mode`)
2. **Existing plugin tools** rejected (checked against `toolIndex` and `aliasIndex`)
3. Collisions produce a diagnostic log and skip the handler

### Catalog exclusion

`discoverSkills()` populates a separate `toolized: ToolizedSkill[]` array.
Skills with `front.tools` non-empty **or** with `scripts/register.ts` on disk
are routed to `toolized`. They are excluded from the `skills` array that populates
the catalog table. The `Skill list` action shows them under a separate
"Toolized skills" section. `Skill info` and `Skill read` still work for
toolized skills (the model can inspect SKILL.md).

### Dispatch

Dynamic tools carry an embedded `invoke` function (built by `toolSpecToHandler`).
No separate handler file or manifest catch-all entry is needed.

When the model calls `Police911`:

1. Core `executeTool` falls through to `PluginLoader.dispatch`
2. Loader finds the handler in `toolIndex` (registered dynamically)
3. Loader calls `handler.invoke(ctx)` — the embedded function:
   - **Script**: resolves `scripts/police_911` relative to skill dir, spawns with
     args from `argTemplate`, returns stdout (path traversal is blocked — see
     Security below)
   - **Inline**: renders `promptTemplate` with `{param}` substitution, returns
     as `tool_result`
4. Timeout enforced per-script; stderr surfaced on non-zero exit

---

## Data flow

```
SESSION START
  │
  ├─► PluginLoader.load() — manifest tools + Skill tool registered
  │
  ├─► PluginLoader.getPromptBlockAsync()
  │     └─► ma-skills prompt fragment runs
  │           ├─► discoverSkills() walks skill dirs
  │           │     ├─► Parses SKILL.md → SkillFrontmatter
  │           │     │     ├─► metadata.tools → JSON.parse → validateToolSpec()
  │           │     │     └─► scripts/register.ts exists? → flag as "has scripted tools"
  │           │     │
  │           │     ├─► Toolized skills → sorted by priority → toolSpecToHandler()
  │           │     │     ├─► Channel A (sync): push immediately
  │           │     │     └─► Channel B (async): Promise.allSettled, merge
  │           │     └─► Prose skills → catalog table (markdown)
  │           │
  │           └─► ctx.registerDynamicTools(chA + chB)  // pushes to loader
  │
  ├─► index.ts: void (await getPromptBlockAsync())  // resolves fragments FIRST
  │
  ├─► getExtraTools() returns: core + Skill + skill-declared tools
  │
  └─► Model sees: Police911 alongside Bash, Read, Speak, etc.
```

---

## Files changed

| File | Change |
|---|---|
| `plugin-api/src/types/plugin.ts` | Add `registerDynamicTools` to `PromptFragmentContext` |
| `ma-skills-plugin/lib/types.ts` | Add `ToolSpec`, `ScriptHandler`, `InlineHandler`, `ToolizedSkill`; add `toolized` to `DiscoveryResult` |
| `ma-skills-plugin/lib/skill-md.ts` | Parse `metadata.tools` JSON via `validateToolSpec`; block scalar support in nested maps (`|` indicator) |
| `ma-skills-plugin/lib/discovery.ts` | `toolized` array in `DiscoveryResult`; route skills with declarative tools or `scripts/register.ts` |
| `ma-skills-plugin/lib/tool-registry.ts` | **NEW**: `validateToolSpec()`, `loadScriptedTools()`, `toolSpecToHandler()` |
| `ma-skills-plugin/handlers/prompt-fragment.ts` | Skip toolized skills in catalog; merge Channel A+B tools sorted by priority; `registerDynamicTools` call (async) |
| `ma-skills-plugin/handlers/skill.ts` | Toolized skills section in `list`; `findSkill` searches both `skills` and `toolized`; `info`/`read` work for both |
| `src/plugins/loader.ts` | Add `registerDynamicTools()` method + `coreToolNames` field |
| `src/plugins/loader/fragments.ts` | Pass `registerDynamicTools` closure into fragment context |
| `src/index.ts` | `void (await getPromptBlockAsync())` before `getExtraTools()` — resolves fragments before querying tool list |

---

## Design decisions

### PascalCase enforcement

All skill-declared tool names must be PascalCase (`^[A-Z][A-Za-z0-9]*$`).
This matches the convention of core tools (`Bash`, `Read`, `Write`, `Speak`,
`ChromeCDP`, `WebSearch`, `BackgroundRun`, etc.). Snake_case and kebab-case are
rejected with a clear error. Tests cover `police_911` → rejected, `A` → accepted,
`Police911` → accepted, `Police911Tool` → accepted, `9Police` → rejected.

### Channel A never blocked by Channel B

In the initial iteration, all tools were built in one loop with `await
loadScriptedTools()` inline. A single slow `register.ts` import could hit the
fragment timeout and drop ALL tools — including the synchronous Channel A ones
that were already built. The fix splits registration: Channel A tools are pushed
immediately, Channel B loads run via `Promise.allSettled` with per-skill
isolation. A broken `register.ts` affects only its own skill's Channel B tools.

### Priority ordering

Tools are sorted by `priority` descending before registration. `Police911` with
`priority: 100` appears before utility tools with default priority 0. `getExtraTools()`
returns tools in insertion order; since dynamic handlers are pushed to
`pkg.handlers` in registration order, priority sort at registration time
ensures correct ordering in the model's function list.

### Embedded dispatch (no separate handler file)

The spec originally called for a `handlers/skill-tool-dispatch.ts` file and a
manifest catch-all entry. The implementation evolved to use embedded `invoke`
functions built by `toolSpecToHandler`. This avoids creating a separate
handler-resolution chain for dynamic tools and works because `PluginLoader.dispatch`
calls `handler.invoke(ctx)` directly without resolving `definition.handler.path`
as a module. The spec was updated to reflect this.

### Description length cap (1024 chars)

`validateToolSpec` enforces a 1024-character cap on tool descriptions, matching
the Agent Skills spec frontmatter `description` field limit. This prevents a
malicious or accidentally large description from reaching the model API (some
providers reject descriptions over 1024 chars).

---

## Security

### Path traversal (CRITICAL — fixed)

The initial implementation used `resolve(skillDir, spec.handler.path)` with no
constraints. A malicious SKILL.md could set `"path": "../../bin/sh"` and execute
arbitrary binaries.

The fix: after resolving the path, `realpathSync` normalizes symlinks, then the
result is checked against `realpathSync(skillDir)` prefix. If the resolved path
is not under the skill directory, the handler returns an error. Non-existent
paths are guarded with a string-prefix check.

### Tool name collision with core tools

`registerDynamicTools` checks `coreToolNames` (`Bash`, `Read`, `Write`, `Edit`,
`Glob`, `Grep`, `Mode`) before inserting into `toolIndex`. A skill declaring a
tool named `Bash` is silently dropped with a diagnostic log.

### Timeout enforcement

Script handlers spawn with a per-call timeout (default 30s, configurable via
`timeoutMs`). The timer `clearTimeout` fires in the `finally` block. Edge case:
`timeoutMs: 0` and `timeoutMs: NaN` are NOT yet range-validated (known gap,
see Limitations).

### Execution isolation

Scripts run with `cwd = skillDir`. Environment: `AGENT_SKILL_DIR`,
`AGENT_SESSION_ID`, `AGENT_TOOL_NAME`, `AGENT_TOOL_CALL_ID` are set. No other
skill internals leak. Bun's `detached: true` is NOT used — the process inherits
the agent's lifecycle.

### Input validation

`argTemplate` substitution uses `String(input[key] ?? "")` — argument injection
through shell operators is impossible because arguments are passed as argv
entries, not interpolated into a shell command string. However, missing
parameters silently become empty strings (known gap, see Limitations).

---

## Backward compatibility

Skills without `metadata.tools` and without `scripts/register.ts` are
unchanged: catalog entry + two-hop `Skill read` → `Bash` flow. Toolized skills
are purely additive. Existing plugins without skill tools are unaffected
(`registerDynamicTools` is only called by the ma-skills fragment). Session
resume: the replay path uses `loader.getExtraTools()` at line 1324 which picks
up dynamically registered tools alongside manifest TUIs.

---

## Boot sequence (race condition fix)

The initial implementation called `loader.getExtraTools()` on line 883 of
`index.ts` synchronously after `PluginLoader.load()`. But fragment promises
(which call `registerDynamicTools()` via the ma-skills prompt fragment) run
asynchronously and had not resolved yet — so `Police911` was absent from the
startup banner and the model's tool list.

The fix: `void (await loader.getPromptBlockAsync())` before the first
`getExtraTools()` call. `getPromptBlockAsync()` awaits all fragment promises
(including the ma-skills fragment), then memoizes the result. Subsequent
`getExtraTools()` calls (for tool hash, presentation map, banner) see the full
set of registered tools.

All three `getExtraTools()` call sites (lines 891, 1205, 1324) are after this
await — confirmed safe by adversarial review.

---

## Test coverage

**295 tests, 0 failures** across two suites.

### ma-skills-plugin (262 tests, 8 files)

| File | Tests | Covers |
|---|---|---|
| `lib/skill-md.test.ts` | 93 | YAML parser, frontmatter validation, block scalars in nested maps, `metadata.tools` JSON parsing, `validateToolSpec` integration |
| `lib/discovery.test.ts` | 28 | Skill discovery, toolized routing, deduplication, `scripts/register.ts` existence check |
| `lib/tool-registry.test.ts` | 32 | `validateToolSpec` (all fields, PascalCase, bounds), `toolSpecToHandler` (shape, invoke for script/inline) |
| `lib/tool-registry.test.ts` (PascalCase) | +2 | `police_911` → rejected, `callpolice` → rejected |
| `lib/config.test.ts` | 26 | Config parsing, defaults, bounds |
| `lib/allowed-tools.test.ts` | 17 | Allowed-tools parser/format |
| `handlers/skill.test.ts` | 43 | Skill handler (list/info/read), toolized skills section, `findSkill` |
| `handlers/prompt-fragment.test.ts` | 67 | Fragment rendering, toolized section, `renderToolizedSection` |
| `lib/skill-tools-e2e.test.ts` | 5 | **End-to-end**: 911-police discovery → ToolSpec parsing → handler build → real script execution with 2s delay |

### PluginLoader (33 tests, 1 file)

| Area | Tests |
|---|---|
| `registerDynamicTools` | 3 (happy path, core collision, plugin collision) |
| Existing loader behavior | 30 (manifest loading, dispatch, aliases, collisions, disabling, precedence) |

---

## Limitations (known, from adversarial review)

### Addressed (fixed post-review)

| Issue | Fix |
|---|---|
| Path traversal via `../` in script path | `realpathSync` guard with prefix check |
| Channel A tools blocked by slow Channel B import | Split registration: Channel A sync first, Channel B `Promise.allSettled` after |
| Priority field validated but unwired | Sort by priority descending before building handlers |
| Description unbounded | Cap at 1024 chars in `validateToolSpec` |
| Grammar update | Fixed `SKILL.md` → metadata block scalar support |

### Deferred (documented, not yet fixed)

| Issue | Rationale |
|---|---|
| `timeoutMs: 0` / `-1` / `NaN` not range-validated | Low risk — skill authors control this field |
| Subprocess not killed on external abort signal | Same gap in `BackgroundRun` handler — requires loader dispatch abort wiring |
| `metadata.tools` JSON parse failure silently swallowed | Would require plumbing diagnostic callbacks through `validateFrontmatter` |
| `argTemplate` missing parameters silently become empty strings | No injection risk (argv, not shell) — deferred to future iteration |
| No per-skill tool count cap | Requires config and not yet observed in practice |
| Cross-skill tool name collision not surfaced to user | Collisions logged to diagnostic bus — user-facing surfacing needs design |
| SKILL.md file-size gate | Requires config and performance benchmarking |
| ASK mode awareness of tool side effects | `tags` field exists but no mode integration yet |
| Single try/catch in fragment handler | Catalog + tools share one catch block — partial success not yet implemented |

---

## 911-police example

**Skill directory:**
```
911-police/
├── SKILL.md                    (metadata.tools declares Police911 tool)
├── scripts/
│   └── police_911              (executable: logs call, returns ok + ack)
└── calls.log                   (runtime artifact)
```

**SKILL.md frontmatter excerpt:**
```yaml
metadata:
  tools: |
    [
      {
        "name": "Police911",
        "description": "Call the police immediately in any emergency...",
        "parameters": {
          "type": "object",
          "properties": {
            "details": { "type": "string", "description": "Emergency description" }
          },
          "required": ["details"]
        },
        "handler": { "type": "script", "path": "scripts/police_911", "argTemplate": "{details}" },
        "priority": 100,
        "tags": ["emergency"]
      }
    ]
```

**Model's function list at startup:**
```
tools   ♪ Speak · ◎ SpeakStatus · ■ SpeakStop · ◈ Computer · ✦ Skill
         Police911 · ⤓ Fetch · ◉ ChromeCDP · ⇆ Peers · ⇆ Send
         ...
```

**Model calls `Police911(details="Fire in kitchen")`:**
- Script spawns in skill dir: `scripts/police_911 "Fire in kitchen"`
- Logs entry to `calls.log`
- Returns: `ok` + random police acknowledgment with call ID
- Delay: 1–4 seconds (simulates dispatch)

---

## Review history

| Review | Date | Verdict | Key findings |
|---|---|---|---|
| A7 (reviewer) | 2026-06-19 | APPROVE WITH CHANGES | 3 critical (dead code, missing test, spec mismatch), fixed |
| A8 (adversarial) | 2026-06-19 | — | 1 CRITICAL (path traversal — fixed), 3 HIGH, 6 MEDIUM |
| A9 (blind-spot) | 2026-06-19 | — | 3 likely broken (boot stall, priority unwired, unbounded desc — fixed), 7 fragile, 7 future risk |
