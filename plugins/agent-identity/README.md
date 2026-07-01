# agent-identity plugin

Gives the agent a per-session **display name**, injected as a
single line in the system prompt:

```
You are working as Laura. It is the name people use to refer to you in
this session; answer to it naturally when addressed.
```

On by default. When nothing is configured the agent behaves as if
`agentName: "auto"` were set and gets a stable name derived from its
session id. Opt out with an `off` sentinel.

## Configuring it

Pick a source (env wins over config):

| Source | Value | Effect |
|---|---|---|
| env `MINIMAL_AGENT_AGENT_NAME` | `Laura` | names the agent `Laura` this run |
| env `MINIMAL_AGENT_AGENT_NAME` | `auto` | a stable name derived from the session id (the default) |
| env `MINIMAL_AGENT_AGENT_NAME` | `off` | force-disable (vetoes a configured name) |
| config `agentName` | `"Laura"` / `"auto"` / `"off"` | same, lower priority than the env var |
| (nothing set) | | defaults to `auto` |

`~/.minimal-agent/config.jsonc`:

```jsonc
{
  // a literal name, "auto" for a per-session derived name (the default),
  // or "off" to disable naming entirely
  "agentName": "auto"
}
```

`"auto"` derives the name deterministically from the session id, so:

- it is **stable across resumes** (same session, same name), and
- every **sub-agent** (its own session id) gets its own distinct name with
  no shared counter or coordination.

The corpus is ~200 common first names baked into the agent
(`src/agent-name.ts`); minimal-agent ships no runtime dependencies, so the
list is a plain `const`, not an npm package.

## Why the name is frozen at boot (and why that matters for cache)

The name is resolved **once**, at startup, in `src/index.ts`
(`resolveAgentName`), and published as `MINIMAL_AGENT_AGENT_NAME` for this
plugin to read. It never changes mid-session, on purpose.

Prompt caching is **prefix-based** on every provider: a cached request is
reused only up to the first byte that differs, and everything after that is
recomputed. The system prompt sits *before* every message on the wire, so
changing one byte of it mid-session would invalidate the entire
conversation's cache, not just the system block. A "rename me" tool would be
the single most cache-hostile thing this codebase could add. Hence: resolve
at boot, freeze.

## Why placement here is cache-free

The agent's system prompt is, on the wire:

```
[ identity, instructions (cache_control: scope "global"), sessionContext ]
```

This plugin's line is folded into the composed plugin block, which IS the
per-session `sessionContext` block, the **last** system block, sitting
**after** the `scope:"global"` cache breakpoint on the instructions block.

That global breakpoint is the cross-session / cross-agent shared cache. The
`sessionContext` block is already per-session (it carries the env snapshot:
session id, pid, date), so prefix-sharing across sessions already stops
where it begins. Adding a name there rides in already-variable content and
costs **zero** marginal shared-prefix cache, on every provider. Putting the
name up top next to the role identity would be the one wasteful choice (it
would break the shared prefix for every differently-named session), which is
exactly why it goes at the bottom instead.

## What it contributes

| Surface | Value |
|---|---|
| `manifest.promptFragments` | one entry, `id: "name"`, a module handler |

The handler (`handlers/identity.ts`) reads the resolved
`MINIMAL_AGENT_AGENT_NAME` from its fragment env and returns the one-line
string, or `""` when no name is set. An empty return means the plugin
contributes **no** system-prompt section at all, so an unnamed session's
prompt is byte-identical to one built without this plugin. There is
deliberately no `PROMPT.md`: a static prompt body would render even when the
feature is off, defeating the zero-impact-when-off guarantee.

## Disabling

`plugins["agent-identity"].enabled = false` in
`~/.minimal-agent/config.jsonc`, or set `agentName` (or
`MINIMAL_AGENT_AGENT_NAME`) to an off sentinel (`"off"`, `"none"`, …):
with no name resolved, the plugin emits nothing and the system prompt is
byte-identical to a build without it. Note that leaving `agentName` unset
no longer disables naming, it defaults to `auto`.
