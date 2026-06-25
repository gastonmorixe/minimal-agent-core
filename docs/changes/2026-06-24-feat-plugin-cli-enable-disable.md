# Plugin enable/disable CLI + `plugins list`

**Date:** 2026-06-24

## Summary

Session-scoped plugin toggles without editing `~/.minimal-agent/config.jsonc`:

- `--disable-plugin <id>` (repeatable; comma-separated ids ok)
- `--enable-plugin <id>` (overrides config and manifest opt-out)
- `MINIMAL_AGENT_DISABLE_PLUGINS` / `MINIMAL_AGENT_ENABLE_PLUGINS` env mirrors
- `plugins list` / `--list-plugins` / `--plugins` — filesystem catalog with effective on/off

Precedence per id: **CLI > env > config > manifest**; disable beats enable within each layer.

## Files

- `src/plugin-enable-resolution.ts` — pure merge logic + `collectFlagValues`
- `src/plugins/catalog.ts` — lightweight scan for `plugins list`
- `src/commands/list-plugins.ts` — table renderer
- `src/index.ts` — wire overrides into `PluginLoader.load`; dispatch `list-plugins`
- `src/cli-args.ts`, `src/cli/command-plan.ts`, `src/extract-prompt.ts`
- `src/startup/help.ts` — Options / Info / Plugins / Env sections
- `src/plugins/loader/discovery.ts` — source-neutral skip log

## Tests

New suites: `plugin-enable-resolution.test.ts`, `plugins/catalog.test.ts`,
`commands/list-plugins.test.ts`, `startup/help.test.ts`; extended cli-args,
command-plan, extract-prompt, loader.test.
