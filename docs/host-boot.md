# Host boot (`@minimal-agent/core/host-kit/host-boot`)

`bootHost()` boots a host that has no terminal, for example the web server.
It composes the public boot pieces in one call. It uses the same order as the
CLI entry point (minimal-agent-cli `src/main.ts`). Use it when you need
providers, plugins, tools, and auth without the CLI.

Decision record: WEB-PLUGINS-001, decision 19 (Q-1 one aggregate subpath,
Q-3 the operator installs plugin dependencies).

## API

```ts
import { bootHost, listBootedModels } from "@minimal-agent/core/host-kit/host-boot"

const host = await bootHost({ skipPluginSync: true })
host.providers      // registered provider ids
host.models         // ModelRow[]
host.toolRegistry   // core tools first, then plugin tools
host.toolExecutor   // runs core and plugin tools
host.diagnostics    // problems the boot found (see below)
const auth = await host.resolveAuth(host.defaultModelId)
```

`ModelRow` holds `id`, `providerId`, `displayName`, `contextWindow`, `rates`
(default per-million-token rates), and `capabilities`. It holds data only, so
you can send it as JSON. `listBootedModels()` returns the same rows from the
live registry at any time.

### Options

All options are optional.

| Option | Default | Use |
|---|---|---|
| `home` | `MINIMAL_AGENT_HOME`, else `~/.minimal-agent` | Agent home. The boot writes it into `MINIMAL_AGENT_HOME`. |
| `embeddedDir` | `projectDir` | Host install dir. The boot scans `<embeddedDir>/plugins`. |
| `projectDir` | `process.cwd()` | Project root for `<projectDir>/.agents/plugins`. |
| `homeDir` | `$HOME/.agents` | Shared plugins root. `null` skips it. |
| `siblingDirs` | `resolveSiblingPluginRoots(embeddedDir)` | Dev-time plugin checkouts. `[]` scans none. |
| `skipPluginSync` | `false` | Skip the first-run plugin clone. |
| `disablePlugins` / `enablePlugins` | none | Plugin ids, on top of config and env. |
| `model` | registry default | Model id for the plugin agent context and the executor. |
| `version` | `"0.0.0"` | Host version for the plugin agent context. |

## Boot order

1. Write the agent home into `MINIMAL_AGENT_HOME`. The config reader and the
   auth store read it.
2. Clone the first-party plugins into `<home>/plugins`, unless
   `skipPluginSync` is set, `MINIMAL_AGENT_NO_PLUGIN_SYNC=1` is set, or config
   has `pluginSync: false`. A clone that is already present does nothing.
3. Discover and activate provider plugins (`provider.json`) from
   `<embeddedDir>/plugins`, then `siblingDirs`, then `<home>/plugins`. The
   first root wins on an id collision.
4. Resolve the plugin enable overrides: `plugins.<id>.enabled` in config,
   then `MINIMAL_AGENT_DISABLE_PLUGINS` / `MINIMAL_AGENT_ENABLE_PLUGINS`,
   then the options.
5. Load the manifest plugins with `PluginLoader.load`. Wait for the async
   prompt fragments, because they can add dynamic tools.
6. Build `ToolRegistryAdapter` and `ToolExecutorAdapter`. The interactive
   collaborators are null: no mode manager, no session store, no blob store,
   no file tracking store, no time tracker, no code highlighter. The host
   that opens a session supplies its own stores.
7. Return the aggregate.

The boot has no terminal I/O and no ANSI output. It does not call
`process.exit`.

## Diagnostics

The boot does not throw for a bad plugin. It adds a `HostBootDiagnostic` to
`host.diagnostics` and continues. A host shows each one to its operator.

| `kind` | Cause |
|---|---|
| `plugin-deps-missing` | A provider plugin declares dependencies in `package.json` but has no `node_modules`. |
| `provider-discovery-failed` | Provider discovery threw, for example because a plugin imports a package that is not installed. |
| `plugin-sync-failed` | The first-run plugin clone failed (offline, private repo). |
| `plugin-warning` | The plugin loader logged a warning (bad manifest, failed handler). |

## Plugin dependencies (Q-3)

The boot does not install plugin dependencies. The operator installs them:

```sh
cd ~/.minimal-agent/plugins/<plugin-dir>
bun install
```

`@minimal-agent/core` does not count as a dependency. The host-core
resolver serves every `@minimal-agent/core/*` import from the host's own
copy. A plugin that needs only core loads with no `node_modules`.

## Auth

`resolveAuth(modelId)` finds the model in the registry and resolves the
stored credentials for that model's own provider. It rejects with a clear
message when the model is unknown or when no credentials exist. A missing
auth file does not stop the boot. Only the `resolveAuth` call rejects.

## Limits

- The model and provider registries are process-wide. A second boot in the
  same process adds to the same registries.
- The CLI does not call `bootHost()` yet. A later change moves the CLI to it.
- No public gate exception was needed. The barrel lives in
  `src/host-public/`. The new files under `src/adapters/` have no stdio and
  no ANSI, so the public closure gate needs no baseline entry.
