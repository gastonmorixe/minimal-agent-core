# Skill-Declared Tools

## Summary

A skill should be able to declare first-class tools that appear in the model's
function-calling surface at the same level as built-ins (`Bash`, `Read`, `Speak`,
etc.). Today a skill is prose-only: the model discovers it in a catalog table,
reads `SKILL.md` as a second hop, then runs a script as a third hop. Three
indirections. With skill-declared tools, `Police911` is one call, zero
indirection.

When a skill declares tools, it **disappears from the skill catalog** and
appears instead as a tool in the function list. No double-advertising.

---

## Architecture

### The contract: `ToolSpec`

```typescript
type ToolSpec = {
  name: string;              // unique, e.g. "Police911"
  description: string;       // model-facing: what + when
  parameters: JSONSchema;    // standard JSON Schema for input
  handler: ScriptHandler | InlineHandler;
  priority?: number;         // ordering hint (higher = earlier in list)
  tags?: string[];           // e.g. ["emergency"], ["requires-confirmation"]
};

type ScriptHandler = {
  type: "script";
  path: string;              // relative to skill dir, e.g. "scripts/Police911"
  argTemplate?: string;      // "{details}" — positional params from input
  timeoutMs?: number;        // default 30_000
};

type InlineHandler = {
  type: "inline";
  promptTemplate: string;    // rendered with params, injected as model context
};
```

### Channel A: Declarative (SKILL.md `metadata.tools`)

The skill author bakes a `tools` key into the `metadata` frontmatter field:

```yaml
---
name: 911-police
description: Place an emergency call to the police.
metadata:
  tools: |
    [
      {
        "name": "Police911",
        "description": "Call the police immediately...",
        "parameters": { ... },
        "handler": { "type": "script", "path": "scripts/Police911", "argTemplate": "{details}" },
        "priority": 100,
        "tags": ["emergency"]
      }
    ]
---
```

The `metadata` field is `Record<string, string>` per the Agent Skills spec. The
`tools` JSON string is parsed at discovery time.

### Channel B: Programmatic (`scripts/register.ts`)

For skills that need runtime environment inspection:

```typescript
// scripts/register.ts — exported as default
export default async function register(
  registerTool: (def: ToolSpec) => void
): Promise<void> {
  registerTool({
    name: "Police911",
    description: "...",
    parameters: { ... },
    handler: { type: "script", path: "scripts/Police911", argTemplate: "{details}" },
    priority: 100,
    tags: ["emergency"],
  });
}
```

The skill plugin dynamically imports this module and calls it with a
`registerTool` callback. No stdout parsing, no XML markers, no protocol strings.

### Bridge: `PluginLoader.registerDynamicTools`

The `PluginLoader` gets one new method:

```typescript
registerDynamicTools(pluginId: string, handlers: ResolvedHandler[]): void
```

It adds the handlers to `toolIndex` and to the contributing plugin's handler
list so `getExtraTools()` picks them up.

The prompt fragment handler receives a new context field
`registerDynamicTools?: (handlers: ResolvedHandler[]) => void` through which it
pushes skill-declared tools after validation.

### Catalog exclusion

Skills with `front.tools` non-empty OR with `scripts/register.ts` present are
routed into a separate `toolized` bucket instead of the `skills` array. The
prompt fragment skips them entirely. `Skill list` can optionally show them under
"Toolized skills" with a note.

### Dispatch

Dynamic tools registered via `registerDynamicTools` carry an embedded `invoke`
function inside each `ResolvedHandler` (built by `toolSpecToHandler`).  No
separate handler file or manifest catch-all entry is needed.

When the model calls `Police911`:

1. Core `executeTool` falls through to `PluginLoader.dispatch`
2. Loader finds the handler in `toolIndex` (registered dynamically)
3. Loader calls `handler.invoke(ctx)` — the embedded function dispatches:
   - If script: spawn process in skill dir, apply params via `argTemplate`, return stdout
   - If inline: render `promptTemplate` with params, return as `tool_result`
4. Timeout enforced; stderr logged; non-zero exit surfaces as error

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
  │           │     │     └─► metadata.tools → JSON.parse → validate ToolSpec[]
  │           │     │     └─► scripts/register.ts → dynamic import → call default
  │           │     │
  │           │     ├─► Toolized skills → convert ToolSpec[] → ResolvedHandler[]
  │           │     └─► Prose skills → catalog table (prompt fragment)
  │           │
  │           └─► ctx.registerDynamicTools(handlers)  // pushes to loader
  │
  ├─► getExtraTools() returns: core + "Skill" + skill-declared tools
  │
  └─► Model sees Police911 alongside Bash, Read, etc.
```

---

## Files changed

| File | Change |
|---|---|
| `plugin-api/src/types/plugin.ts` | Add `registerDynamicTools` to `PromptFragmentContext` |
| `ma-skills-plugin/lib/types.ts` | Add `ToolSpec`, `ScriptHandler`, `InlineHandler`, `ToolizedSkill`; add `toolized` to `DiscoveryResult` |
| `ma-skills-plugin/lib/skill-md.ts` | Parse `metadata.tools` JSON string via `validateToolSpec` from `tool-registry.ts` |
| `ma-skills-plugin/lib/discovery.ts` | Add `toolized` array to `DiscoveryResult`; route skills with declarative tools or `scripts/register.ts` |
| `ma-skills-plugin/lib/tool-registry.ts` | **NEW**: `validateToolSpec()`, `loadScriptedTools()`, `toolSpecToHandler()` (embedded invoke dispatch) |
| `ma-skills-plugin/handlers/prompt-fragment.ts` | Skip toolized skills in catalog; merge Channel A+B tools; call `registerDynamicTools` (async) |
| `ma-skills-plugin/handlers/skill.ts` | Show toolized skills in `list`; `findSkill` searches both `skills` and `toolized` |
| `src/plugins/loader.ts` | Add `registerDynamicTools()` public method |
| `src/plugins/loader/fragments.ts` | Wire `registerDynamicTools` closure into fragment context |

---

## Security

- ToolSpec validation at registration time; invalid specs dropped with diagnostic
- Script handlers: CWD = skill directory; env: `AGENT_SKILL_DIR`, `AGENT_SESSION_ID`
- Timeout enforced per-script; stderr logged, surfaced on non-zero exit
- `tags: ["requires-confirmation"]` reserved for future user-approval gate
- Existing `allowed-tools` field gates host tool access; unchanged
- No network access beyond what the session sandbox allows

---

## Backward compatibility

Skills without `metadata.tools` and without `scripts/register.ts` are unchanged:
catalog entry + two-hop `Skill read` → `Bash` flow. Toolized skills are purely
additive.

---

## 911-police example (post-implementation)

**Skill directory:**
```
911-police/
├── SKILL.md                    (metadata.tools declares Police911)
├── scripts/
│   └── Police911              (executable)
└── calls.log                   (runtime)
```

**Model's function list:**
```
Police911(details: string) → Call the police immediately...
Bash(command: string) → ...
Read(file_path: string) → ...
Speak(text: string) → ...
```

"911-police" does not appear in the skill catalog. One call, zero indirection.
