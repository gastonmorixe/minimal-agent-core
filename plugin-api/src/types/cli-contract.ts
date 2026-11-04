/**
 * CLI help contract types.
 *
 * The data contract for CLI commands, flags, args, env names, examples, and
 * help sections. Built-in commands and plugin `manifest.json` `cli` blocks
 * use the same shapes. The CLI owns rendering. A plugin never renders help.
 *
 * Contract values are JSON data only: no functions, no class instances, no
 * `undefined` in arrays. The two exceptions are {@link CliCommandContext} and
 * {@link CliCommandHandler}, the run contract of a plugin CLI command.
 *
 * Contract strings are plain text. Only the renderer adds style.
 *
 * This module has one runtime value: {@link CLI_CONTRACT_VERSION}. All else is
 * types only.
 *
 * @module types/cli-contract
 */

import type { ManifestHandlerEntry } from "./plugin.ts"

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Contract shape version. Bump only for a breaking change: a removal or a
 * meaning change. Additive optional fields do not bump it.
 */
export const CLI_CONTRACT_VERSION = 1 as const

/** The type of {@link CLI_CONTRACT_VERSION}. */
export type CliContractVersion = typeof CLI_CONTRACT_VERSION

// ---------------------------------------------------------------------------
// Manifest `cli` block
// ---------------------------------------------------------------------------

/** Top-level `cli` block in `manifest.json`. */
export interface ManifestCli {
  /** Contract version of this block. The host skips a block with an unknown version. */
  contractVersion: CliContractVersion
  /** Top-level CLI commands this plugin adds. */
  commands?: CommandSpec[]
  /** Free-form help sections. They render in the PLUGIN NOTES area only. */
  helpSections?: HelpSectionSpec[]
}

/** One CLI command. A command can hold nested commands. */
export interface CommandSpec {
  /** One path segment. Matches `/^[a-z0-9][a-z0-9-]*$/`. */
  name: string
  /** One line, plain text, max 80 chars. */
  summary: string
  /** Paragraphs, plain text. */
  description?: string[]
  /** Other names for this path segment. */
  aliases?: string[]
  /** Root group id. Built-ins only. */
  group?: string
  /** When true, help shows the command only with `--help --all`. */
  hidden?: boolean
  /** Usage lines that replace the lines generated from `args`. */
  usage?: string[]
  /** Positional arguments, in order. */
  args?: ArgSpec[]
  /** Flags that apply to this command path. */
  flags?: FlagSpec[]
  /** Environment variables this command reads. */
  env?: EnvSpec[]
  /** Example invocations. */
  examples?: ExampleSpec[]
  /** Related command paths. Each item is one path, for example `["sessions", "dump"]`. */
  seeAlso?: string[][]
  /** Nested commands. */
  commands?: CommandSpec[]
  /** When true, the parser rejects unknown flags. */
  strict?: boolean
  /** Handler module. Plugins only. The host imports it only when the command runs. */
  handler?: ManifestHandlerEntry
}

/** One flag. One FlagSpec drives both parse and help for that flag. */
export interface FlagSpec {
  /** Long name with no dashes, for example `"model"`. */
  name: string
  /** One character with no dash, for example `"m"`. */
  short?: string
  /** Other long names with no dashes, for example `"list-model"`. */
  aliases?: string[]
  /** Value type. */
  type: "boolean" | "string" | "number"
  /** Value mode. Default: `"none"` for boolean, else `"required"`. */
  value?: "none" | "required" | "optional"
  /** Value placeholder. `"id"` renders as `<id>`, or `[<id>]` when optional. */
  valueName?: string
  /** The set of accepted values. */
  choices?: string[]
  /** Value when the flag is absent. */
  default?: string | number | boolean
  /** When true, the flag can repeat. A comma list is also accepted. */
  multiple?: boolean
  /** When true, the parser also accepts `--no-<name>`. */
  negatable?: boolean
  /** Environment variable that sets the same value. */
  env?: string
  /** One line, plain text. */
  summary: string
  /** Paragraphs, plain text. */
  description?: string[]
  /** Help heading inside FLAGS. */
  group?: string
  /** When true, help shows the flag only with `--help --all`. */
  hidden?: boolean
  /** Deprecation message. The flag still parses. */
  deprecated?: string
  /** When true, the flag applies to all paths. Built-ins only. */
  global?: boolean
}

/** One positional argument. */
export interface ArgSpec {
  /** Argument name, for example `"sid"`. */
  name: string
  /** One line, plain text. */
  summary: string
  /** When true, the argument must be present. Default `false`. */
  required?: boolean
  /** When true, the argument takes all remaining positionals. Must be the last arg. */
  variadic?: boolean
  /** The set of accepted values. */
  choices?: string[]
}

/** One environment variable. */
export interface EnvSpec {
  /** Variable name, for example `"MINIMAL_AGENT_MODEL"`. */
  name: string
  /** One line, plain text. */
  summary: string
  /** Value when the variable is not set. */
  default?: string
  /** The {@link FlagSpec.name} this variable backs. */
  flag?: string
  /** When true, help shows the variable only with `--help --all`. */
  hidden?: boolean
}

/** One example invocation. */
export interface ExampleSpec {
  /** Arguments after the program name, for example `"sessions dump last"`. */
  argv: string
  /** One line, plain text. */
  summary: string
}

/** One term and summary row of a {@link HelpSectionSpec}. */
export interface HelpSectionRowSpec {
  /** Left column text. */
  term: string
  /** Right column text. */
  summary: string
}

/** One free-form help section a plugin adds. */
export interface HelpSectionSpec {
  /** Section id, unique in the plugin. */
  id: string
  /** Section heading. */
  title: string
  /** Paragraphs, plain text. */
  text?: string[]
  /** Term and summary rows. */
  rows?: HelpSectionRowSpec[]
}

// ---------------------------------------------------------------------------
// Help model (CLI output)
// ---------------------------------------------------------------------------

/** Section ids of root help, owned by the CLI. */
export type RootSectionId =
  | "header"
  | "usage"
  | "examples"
  | "commands"
  | "plugin-commands"
  | "host-modes"
  | "flags"
  | "environment"
  | "plugin-notes"
  | "learn-more"

/** Section ids of command help, owned by the CLI. */
export type CommandSectionId =
  | "header"
  | "usage"
  | "arguments"
  | "commands"
  | "flags"
  | "global-flags"
  | "environment"
  | "examples"
  | "see-also"

/** The help output as data, before rendering. */
export interface HelpModel {
  /** Contract version, so JSON readers can check it. */
  contractVersion: CliContractVersion
  /** Root help or command help. */
  kind: "root" | "command"
  /** Program name and version. */
  program: HelpModelProgram
  /** Command path. Empty for root help. */
  path: string[]
  /** Sections, already in render order. */
  sections: HelpModelSection[]
}

/** Program identity in a {@link HelpModel}. */
export interface HelpModelProgram {
  /** Program name. */
  name: string
  /** Program version. */
  version: string
}

/** One section of a {@link HelpModel}. */
export interface HelpModelSection {
  /** Section id. */
  id: RootSectionId | CommandSectionId
  /** Section heading. */
  title: string
  /** Paragraphs, plain text. */
  text?: string[]
  /** Rows with no group heading. */
  rows?: HelpModelRow[]
  /** Rows under group headings. */
  groups?: HelpModelGroup[]
}

/** A titled group of rows in a {@link HelpModelSection}. */
export interface HelpModelGroup {
  /** Group heading. */
  title: string
  /** Rows in the group. */
  rows: HelpModelRow[]
}

/** One row of a {@link HelpModelSection}. */
export interface HelpModelRow {
  /** Left column text, for example `"-m, --model <id>"`. */
  term: string
  /** Right column text. */
  summary: string
  /** Where the row comes from. */
  source: "builtin" | "core" | `plugin:${string}`
  /** Row state, when the row is not a plain active entry. */
  state?: "disabled" | "shadowed" | "hidden" | "deprecated"
  /** Reason text for `state`. */
  note?: string
}

// ---------------------------------------------------------------------------
// Catalog entry (core output, no handler import)
// ---------------------------------------------------------------------------

/**
 * Plugin root tier, in the same set as the core plugin catalog
 * (`PluginRootTier` in src/plugins/loader/roots.ts). plugin-api cannot
 * import src, so cli-contract.test.ts compares the two sets.
 */
export type CatalogCliRoot = "project" | "home" | "user" | "embedded"

/** Host-mode metadata in a {@link CatalogCliEntry}. */
export interface CatalogCliHostMode {
  /** Matched against `--host-mode <id>`. */
  id: string
  /** One-line description. */
  description: string
  /** Declared positional arguments. */
  args?: ArgSpec[]
  /** Example invocations. */
  examples?: ExampleSpec[]
}

/** One plugin as help and dispatch see it. Read with no handler import. */
export interface CatalogCliEntry {
  /** Plugin id. */
  pluginId: string
  /** Root tier the plugin comes from. */
  root: CatalogCliRoot
  /** Final on or off state, after overrides and gates. */
  effectiveOn: boolean
  /** Reason when off: an override note, `"platform"`, or `"permission"`. */
  note: string
  /** Validated `cli` block. Absent when the block is missing or invalid. */
  cli?: ManifestCli
  /** Host-mode metadata. */
  hostModes: CatalogCliHostMode[]
}

// ---------------------------------------------------------------------------
// Plugin command run contract
// ---------------------------------------------------------------------------

/** A text output stream for a plugin CLI command. */
export interface CliOutputStream {
  /** Write text to the stream. */
  write(s: string): unknown
}

/**
 * Input to a plugin CLI command handler. The CLI builds it from the
 * {@link CommandSpec}. The handler never sees raw argv.
 */
export interface CliCommandContext {
  /** Command path, for example `["schedule", "list"]`. */
  path: string[]
  /** Parsed positional arguments, by {@link ArgSpec.name}. */
  args: Record<string, string | string[]>
  /** Parsed flags, by {@link FlagSpec.name}. */
  flags: Record<string, string | number | boolean | string[]>
  /** Process environment. */
  env: Readonly<Record<string, string | undefined>>
  /** Standard output. */
  stdout: CliOutputStream
  /** Standard error. */
  stderr: CliOutputStream
}

/** A plugin CLI command handler. Returns the process exit code. */
export type CliCommandHandler = (ctx: CliCommandContext) => Promise<number>
