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

const host = await bootHost({
  pluginRoots: {
    embedded: ["/srv/app/plugins"],
    user: ["/home/me/.minimal-agent/plugins"],
    project: ["/work/repo/.agents/plugins"],
  },
})
host.providers      // registered provider ids
host.models         // ModelRow[]
host.toolRegistry   // core tools first, then plugin tools
host.toolExecutor   // runs core and plugin tools for the default model
host.diagnostics    // problems the boot found (see below)

// One executor and one auth for each session, with the model of that session.
const row = host.models[0]
const executor = host.toolExecutorFor(row.id, { statusPort })
const auth = await host.resolveAuth(row.id, row.providerId)
```

`ModelRow` holds `id`, `providerId`, `displayName`, `contextWindow`, `rates`
(default per-million-token rates), and `capabilities`. It holds data only, so
you can send it as JSON. `listBootedModels()` returns the same rows from the
live registry at any time.

### Options

All options are optional.

The host computes every plugin root (spec S40). Core knows no default plugin
location: no install dir, no dev checkout, no `.agents` folder. Each root
directory holds plugin package directories directly.

| Option | Default | Use |
|---|---|---|
| `home` | `MINIMAL_AGENT_HOME`, else `~/.minimal-agent` | Agent home. The boot writes it into `MINIMAL_AGENT_HOME`. |
| `pluginRoots` | `{}` (no roots) | Manifest plugin roots by tier: `embedded`, `user`, `home`, `project`. On an id collision, project wins, then home, then user, then embedded. |
| `providerRoots` | `providerRootsOf(pluginRoots)` | Provider plugin roots (`provider.json`). The first root wins on an id collision. The default is the embedded roots, then the user roots. |
| `pluginSync` | none (no clone) | `{ targetDir, repoUrl }`. Clone `repoUrl` into `targetDir` on first run. Also pass `targetDir` as a `user` root. |
| `disablePlugins` / `enablePlugins` | none | Plugin ids, on top of config and env. |
| `model` | registry default | Model id for the plugin agent context and for `host.toolExecutor`. |
| `version` | `"0.0.0"` | Host version for the plugin agent context. |
| `statusPort` | none (no tool status row) | Live status port. Each tool call opens a `running_tool` status on it. `toolExecutorFor(id, { statusPort })` replaces it for one executor. |

`PluginRoots` and `providerRootsOf` are exported from
`@minimal-agent/core/host-kit/host-boot` and
`@minimal-agent/core/host-kit/plugin-loader`.

## Boot order

1. Write the agent home into `MINIMAL_AGENT_HOME`. The config reader and the
   auth store read it.
2. Clone the first-party plugins into `pluginSync.targetDir`, only when the
   host passes `pluginSync`. `MINIMAL_AGENT_NO_PLUGIN_SYNC=1` or config
   `pluginSync: false` turns the clone off. `MINIMAL_AGENT_PLUGINS_REPO` or
   config `pluginsRepo` replaces `pluginSync.repoUrl`. A clone that is
   already present does nothing.
3. Discover and activate provider plugins (`provider.json`) from
   `providerRoots`, in order. The first root wins on an id collision.
4. Resolve the plugin enable overrides: `plugins.<id>.enabled` in config,
   then `MINIMAL_AGENT_DISABLE_PLUGINS` / `MINIMAL_AGENT_ENABLE_PLUGINS`,
   then the options.
5. Load the manifest plugins from `pluginRoots` with `PluginLoader.load`.
   Core loads only the `headless` part of each manifest (S31). Wait for the async
   prompt fragments, because they can add dynamic tools.
6. Build `ToolRegistryAdapter` and the `ToolExecutorAdapter` for the default
   model (`host.toolExecutor`). The interactive
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

Plugin errors after the boot (a hook or an event handler that throws) use
the loader diagnostics relay, the same as in the CLI:

- Inside a session run, the error goes to the log of that session as a
  `ch: "diag"` entry. It does not go to `host.diagnostics`.
- Outside a run, the error goes to `host.diagnostics` as a
  `plugin-warning`. With exactly one session attached
  (`loader.attachSessionDiagnostics`), it goes to that session.

Every loader diagnostic also goes to the process diagnostic bus. Routine
notices (a shadowed plugin id, a plugin that its manifest disables, a
platform gate) go to the bus only.

## Plugin dependencies (Q-3)

The boot does not install plugin dependencies. The operator installs them:

```sh
cd ~/.minimal-agent/plugins/<plugin-dir>
bun install
```

`@minimal-agent/core` does not count as a dependency. The host-core
resolver serves every `@minimal-agent/core/*` import from the host's own
copy. A plugin that needs only core loads with no `node_modules`.

## Tool executors

`host.toolExecutorFor(modelId, options?)` makes a new executor for one
session. The model id sets the media (vision) context of the tools. For
example, `Read` gives an image block only to a model that accepts images.
Each executor has its own feedback tracker. All executors share the boot's
plugin loader and tool presentation. `options.statusPort` replaces the boot
`statusPort` for that executor.

`host.toolExecutor` is the executor for `host.defaultModelId`, made once at
boot. Use it only for a host with one model and one session. The media
context resolves the model by id only, the same as in the CLI.

## Auth

`resolveAuth(modelId, providerId?)` finds the model in the registry and
resolves the stored credentials for that model's own provider. Without
`providerId`, the last provider that registered `modelId` wins. Two providers
can register the same model id. Pass `providerId` (for example
`ModelRow.providerId`) to use the entry of that provider only. The call
rejects when that provider did not register `modelId`. It rejects with a clear
message when the model is unknown or when no credentials exist. A missing
auth file does not stop the boot. Only the `resolveAuth` call rejects.

## Limits

- The model and provider registries are process-wide. A second boot in the
  same process adds to the same registries.
- The CLI does not call `bootHost()` yet. A later change moves the CLI to it.
- No public gate exception was needed. The barrel lives in
  `src/host-public/`. The new files under `src/adapters/` have no stdio and
  no ANSI, so the public closure gate needs no baseline entry.
