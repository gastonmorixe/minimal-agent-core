/**
 * Validation of the top-level `cli` block of `manifest.json` (SPEC-HELP
 * R-20, R-21, M-4), split out of `manifest.ts` like `manifest-host-mode.ts`.
 *
 * `parseCli` reads JSON data only. It never imports a handler module: a
 * command `handler` is checked as a {@link ManifestHandlerEntry} shape and
 * nothing more. The help path and the plugin catalog can call it with no
 * import cost.
 *
 * Failure policy: `parseCli` never throws. On the first bad value it drops
 * the WHOLE `cli` block, sends one diagnostic to `warn`, and returns
 * `undefined`. The plugin still loads (R-6, R-21, V-15).
 *
 * Unknown keys: ignored and not copied to the output. This follows the
 * `parseManifest` top-level and `headless` style (no unknown-key check), and
 * it keeps the contract rule that an additive optional field does not bump
 * {@link CLI_CONTRACT_VERSION}: an older core must not drop a newer block
 * only because it has a new optional field.
 *
 * @module plugins/manifest-cli
 */

import {
  type ArgSpec,
  CLI_CONTRACT_VERSION,
  type CommandSpec,
  type EnvSpec,
  type ExampleSpec,
  type FlagSpec,
  type HelpSectionRowSpec,
  type HelpSectionSpec,
  type ManifestCli,
} from "../../plugin-api/src/types/cli-contract.ts"
import type { TypedAttrs } from "../diagnostics/typed.ts"

import { isObject, parseHandlerEntry } from "./manifest-helpers.ts"
import { plainTextError } from "./manifest-text.ts"

/** Command, arg, alias, and section id rule. Same rule as slash command names. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
/** Long flag name rule, with no leading dashes. */
const FLAG_RE = /^[a-z0-9][a-z0-9-]*$/
/** Short flag rule: one character, with no dash. */
const SHORT_RE = /^[A-Za-z0-9]$/
/** Environment variable name rule. */
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Max length of a term: a name, an alias, a value name, a title (R-3). */
export const CLI_MAX_TERM = 64
/** Max length of a one-line summary (R-3). */
export const CLI_MAX_SUMMARY = 80
/** Max length of one paragraph, usage line, or example argv (R-3). */
export const CLI_MAX_PARAGRAPH = 2000
/** Max number of commands in one plugin, nested commands included (R-3). */
export const CLI_MAX_COMMANDS = 200

/**
 * Root command names a plugin cannot use. Plugin CLI commands are reached
 * through the reserved root verb `plugin` (SPEC-HELP Q-9:
 * `minimal-agent plugin <cmd>`). A plugin command named `plugin` would make
 * `minimal-agent plugin plugin ...` and future routing rules unclear, so it
 * is rejected here. parseCli does not route, it only blocks the name.
 */
const RESERVED_ROOT_NAMES: readonly string[] = ["plugin"]

/**
 * Flag names and shorts a plugin cannot use. R-16 routes `--help` and `-h`
 * anywhere after the command path to help, so such a flag never reaches
 * the handler.
 */
const RESERVED_FLAG_NAMES: readonly string[] = ["help"]
const RESERVED_FLAG_SHORTS: readonly string[] = ["h"]

const FLAG_TYPES: readonly string[] = ["boolean", "string", "number"]
const FLAG_VALUES: readonly string[] = ["none", "required", "optional"]

/** Internal signal: the first bad value. Caught in the public entry points. */
class CliSpecError extends Error {
  constructor(at: string, msg: string) {
    super(`${at}: ${msg}`)
    this.name = "CliSpecError"
  }
}

function fail(at: string, msg: string): never {
  throw new CliSpecError(at, msg)
}

/**
 * Sink for one diagnostic line. `parseManifest` passes its `warn`. The second
 * argument carries the typed attrs (S11.1c dual-write). Old callbacks that
 * take only `msg` still fit.
 */
export type CliWarn = (msg: string, attrs?: TypedAttrs) => void

/**
 * The free validator text of a dropped manifest part, as a typed attr.
 *
 * @param reason - Text built by a validator in core.
 * @returns The `reason` attr. Known text leak, owned by S11.3 (manifest area).
 */
export function reasonAttr(reason: string): { reason: string } {
  return { reason }
}

/**
 * Validate a raw top-level `cli` block.
 *
 * @param raw - The raw `cli` value from the parsed JSON. `undefined` or
 *   `null` means "no block" and gives no diagnostic.
 * @param manifestPath - Path used in the diagnostic text.
 * @param warn - Gets one line when the block is dropped.
 * @returns A clean {@link ManifestCli} with only known keys, or `undefined`
 *   when the block is absent or invalid. Never throws.
 */
export function parseCli(
  raw: unknown,
  manifestPath: string,
  warn: CliWarn,
): ManifestCli | undefined {
  if (raw == null) return undefined
  try {
    return readCli(raw)
  } catch (e) {
    const reason = errText(e)
    warn(`${manifestPath}: cli block dropped (plugin still loads): ${reason}`, {
      code: "cli_block_dropped",
      manifestPath,
      ...reasonAttr(reason),
    })
    return undefined
  }
}

/**
 * Validate the help fields of one `headless.hostModes[i]` entry: `args`
 * and `examples` (R-20). A bad field is dropped with a diagnostic. The host
 * mode itself stays valid. Never throws.
 *
 * @param obj - The raw host-mode object.
 * @param at - Location prefix, for example `hostModes[0]`.
 * @param manifestPath - Path used in the diagnostic text.
 * @param warn - Gets one line per dropped field.
 * @param index - Position of the host mode, for the typed attrs.
 * @returns The valid fields only.
 */
export function parseHostModeHelp(
  obj: Record<string, unknown>,
  at: string,
  manifestPath: string,
  warn: CliWarn,
  index: number,
): { args?: ArgSpec[]; examples?: ExampleSpec[] } {
  const out: { args?: ArgSpec[]; examples?: ExampleSpec[] } = {}
  const drop = (field: string, e: unknown) => {
    const reason = errText(e)
    warn(`${manifestPath}: ${at}.${field} dropped (host mode still loads): ${reason}`, {
      code: "host_mode_field_dropped",
      manifestPath,
      index,
      field,
      ...reasonAttr(reason),
    })
  }
  if (obj.args != null) {
    try {
      out.args = readArgs(obj.args, `${at}.args`)
    } catch (e) {
      drop("args", e)
    }
  }
  if (obj.examples != null) {
    try {
      out.examples = readList(obj.examples, `${at}.examples`, readExample)
    } catch (e) {
      drop("examples", e)
    }
  }
  return out
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// Block and commands
// ---------------------------------------------------------------------------

function readCli(raw: unknown): ManifestCli {
  const at = "cli"
  if (!isObject(raw)) fail(at, "must be an object")
  if (raw.contractVersion !== CLI_CONTRACT_VERSION) {
    fail(
      `${at}.contractVersion`,
      `unknown contract version ${JSON.stringify(raw.contractVersion)} ` +
        `(this core knows ${CLI_CONTRACT_VERSION})`,
    )
  }
  const out: ManifestCli = { contractVersion: CLI_CONTRACT_VERSION }
  if (raw.commands != null) {
    const counter = { n: 0 }
    out.commands = readCommands(raw.commands, `${at}.commands`, true, counter)
  }
  if (raw.helpSections != null) {
    const sections = readList(raw.helpSections, `${at}.helpSections`, readHelpSection)
    uniqueBy(sections, (s) => [s.id], `${at}.helpSections`, "section id")
    out.helpSections = sections
  }
  return out
}

function readCommands(
  raw: unknown,
  at: string,
  root: boolean,
  counter: { n: number },
): CommandSpec[] {
  if (!Array.isArray(raw)) fail(at, "must be an array")
  const out = raw.map((c, i) => readCommand(c, `${at}[${i}]`, root, counter))
  // `my_cmd` and `my-cmd` at one level would be too close to tell apart in
  // help, so names and aliases must stay unique after `_` maps to `-`.
  uniqueBy(
    out,
    (c) => [c.name, ...(c.aliases ?? [])],
    at,
    "command name or alias",
    (k) => k.replaceAll("_", "-"),
  )
  return out
}

function readCommand(raw: unknown, at: string, root: boolean, counter: { n: number }): CommandSpec {
  if (!isObject(raw)) fail(at, "command must be an object")
  counter.n++
  if (counter.n > CLI_MAX_COMMANDS) fail(at, `more than ${CLI_MAX_COMMANDS} commands`)
  const name = readName(raw.name, `${at}.name`, NAME_RE)
  const aliases = raw.aliases != null ? readNames(raw.aliases, `${at}.aliases`, NAME_RE) : undefined
  if (root) {
    for (const n of [name, ...(aliases ?? [])]) {
      if (RESERVED_ROOT_NAMES.includes(n)) {
        fail(at, `${JSON.stringify(n)} is reserved (it is the root verb for plugin commands)`)
      }
    }
  }
  if (aliases?.includes(name)) fail(`${at}.aliases`, `alias ${JSON.stringify(name)} equals name`)
  // `group` is a built-in root group id. A plugin cannot set it (R-26).
  // Strict on purpose: any present key, `null` included, drops the block.
  if (raw.group !== undefined) fail(`${at}.group`, "group is for built-in commands only")

  const out: CommandSpec = {
    name,
    summary: readText(raw.summary, `${at}.summary`, CLI_MAX_SUMMARY),
  }
  if (raw.description != null)
    out.description = readParagraphs(raw.description, `${at}.description`)
  if (aliases) out.aliases = aliases
  if (raw.hidden != null) out.hidden = readBool(raw.hidden, `${at}.hidden`)
  if (raw.usage != null) out.usage = readParagraphs(raw.usage, `${at}.usage`)
  if (raw.args != null) out.args = readArgs(raw.args, `${at}.args`)
  if (raw.flags != null) out.flags = readFlags(raw.flags, `${at}.flags`)
  if (raw.env != null) {
    const env = readList(raw.env, `${at}.env`, readEnv)
    uniqueBy(env, (e) => [e.name], `${at}.env`, "env name")
    out.env = env
  }
  if (raw.examples != null) out.examples = readList(raw.examples, `${at}.examples`, readExample)
  if (raw.seeAlso != null) {
    out.seeAlso = readList(raw.seeAlso, `${at}.seeAlso`, (p, pat) => {
      const path = readNames(p, pat, NAME_RE)
      if (path.length === 0) fail(pat, "path must not be empty")
      return path
    })
  }
  if (raw.commands != null) {
    out.commands = readCommands(raw.commands, `${at}.commands`, false, counter)
  }
  if (raw.strict != null) out.strict = readBool(raw.strict, `${at}.strict`)
  if (raw.handler != null) out.handler = readHandler(raw.handler, at)
  return out
}

/**
 * Same shape check as a slash command handler (`parseCommand` in
 * `manifest.ts`): a valid entry of type `module` (R-23). No import here.
 */
function readHandler(raw: unknown, at: string): CommandSpec["handler"] {
  // A bad shape throws a ManifestError whose text starts with `<at>.handler:`.
  // The public entry points catch it like a CliSpecError.
  const entry = parseHandlerEntry(raw, at, "")
  if (entry.type !== "module") fail(`${at}.handler`, 'command handler must be type "module"')
  return entry
}

// ---------------------------------------------------------------------------
// Leaf specs
// ---------------------------------------------------------------------------

function readArgs(raw: unknown, at: string): ArgSpec[] {
  const args = readList(raw, at, readArg)
  uniqueBy(args, (a) => [a.name], at, "arg name")
  args.forEach((a, i) => {
    if (a.variadic && i !== args.length - 1) fail(`${at}[${i}]`, "a variadic arg must be the last")
  })
  return args
}

function readArg(raw: unknown, at: string): ArgSpec {
  if (!isObject(raw)) fail(at, "arg must be an object")
  const out: ArgSpec = {
    name: readName(raw.name, `${at}.name`, NAME_RE),
    summary: readText(raw.summary, `${at}.summary`, CLI_MAX_SUMMARY),
  }
  if (raw.required != null) out.required = readBool(raw.required, `${at}.required`)
  if (raw.variadic != null) out.variadic = readBool(raw.variadic, `${at}.variadic`)
  if (raw.choices != null) out.choices = readTerms(raw.choices, `${at}.choices`)
  return out
}

function readFlags(raw: unknown, at: string): FlagSpec[] {
  const flags = readList(raw, at, readFlag)
  uniqueBy(flags, (f) => [f.name, ...(f.aliases ?? [])], at, "flag name or alias")
  uniqueBy(flags, (f) => (f.short ? [f.short] : []), at, "short flag")
  return flags
}

function readFlag(raw: unknown, at: string): FlagSpec {
  if (!isObject(raw)) fail(at, "flag must be an object")
  const name = readName(raw.name, `${at}.name`, FLAG_RE)
  if (typeof raw.type !== "string" || !FLAG_TYPES.includes(raw.type)) {
    fail(`${at}.type`, `must be one of ${FLAG_TYPES.join(", ")} (got: ${JSON.stringify(raw.type)})`)
  }
  if (RESERVED_FLAG_NAMES.includes(name)) {
    fail(`${at}.name`, `${JSON.stringify(name)} is reserved for help (R-16)`)
  }
  // Plugins cannot add global flags in v1 (R-26, Q-1). Strict on purpose:
  // any present key, `false` and `null` included, drops the block.
  if (raw.global !== undefined) fail(`${at}.global`, "global is for built-in flags only")
  const out: FlagSpec = {
    name,
    type: raw.type as FlagSpec["type"],
    summary: readText(raw.summary, `${at}.summary`, CLI_MAX_SUMMARY),
  }
  if (raw.short != null) {
    out.short = readName(raw.short, `${at}.short`, SHORT_RE)
    if (RESERVED_FLAG_SHORTS.includes(out.short)) {
      fail(`${at}.short`, `${JSON.stringify(out.short)} is reserved for help (R-16)`)
    }
  }
  if (raw.aliases != null) {
    out.aliases = readNames(raw.aliases, `${at}.aliases`, FLAG_RE)
    if (out.aliases.includes(name))
      fail(`${at}.aliases`, `alias ${JSON.stringify(name)} equals name`)
    for (const a of out.aliases) {
      if (RESERVED_FLAG_NAMES.includes(a)) {
        fail(`${at}.aliases`, `${JSON.stringify(a)} is reserved for help (R-16)`)
      }
    }
  }
  if (raw.value != null) {
    if (typeof raw.value !== "string" || !FLAG_VALUES.includes(raw.value)) {
      fail(
        `${at}.value`,
        `must be one of ${FLAG_VALUES.join(", ")} (got: ${JSON.stringify(raw.value)})`,
      )
    }
    out.value = raw.value as FlagSpec["value"]
  }
  if (raw.valueName != null)
    out.valueName = readText(raw.valueName, `${at}.valueName`, CLI_MAX_TERM)
  if (raw.choices != null) out.choices = readTerms(raw.choices, `${at}.choices`)
  if (raw.default != null) out.default = readDefault(raw.default, `${at}.default`)
  if (raw.multiple != null) out.multiple = readBool(raw.multiple, `${at}.multiple`)
  if (raw.negatable != null) out.negatable = readBool(raw.negatable, `${at}.negatable`)
  if (raw.env != null) out.env = readName(raw.env, `${at}.env`, ENV_RE)
  if (raw.description != null)
    out.description = readParagraphs(raw.description, `${at}.description`)
  if (raw.group != null) out.group = readText(raw.group, `${at}.group`, CLI_MAX_TERM)
  if (raw.hidden != null) out.hidden = readBool(raw.hidden, `${at}.hidden`)
  if (raw.deprecated != null) {
    out.deprecated = readText(raw.deprecated, `${at}.deprecated`, CLI_MAX_PARAGRAPH)
  }
  return out
}

function readDefault(raw: unknown, at: string): string | number | boolean {
  if (typeof raw === "boolean") return raw
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) fail(at, "number must be finite")
    return raw
  }
  return readText(raw, at, CLI_MAX_PARAGRAPH, false)
}

function readEnv(raw: unknown, at: string): EnvSpec {
  if (!isObject(raw)) fail(at, "env entry must be an object")
  const out: EnvSpec = {
    name: readName(raw.name, `${at}.name`, ENV_RE),
    summary: readText(raw.summary, `${at}.summary`, CLI_MAX_SUMMARY),
  }
  if (raw.default != null)
    out.default = readText(raw.default, `${at}.default`, CLI_MAX_PARAGRAPH, false)
  if (raw.flag != null) out.flag = readName(raw.flag, `${at}.flag`, FLAG_RE)
  if (raw.hidden != null) out.hidden = readBool(raw.hidden, `${at}.hidden`)
  return out
}

function readExample(raw: unknown, at: string): ExampleSpec {
  if (!isObject(raw)) fail(at, "example must be an object")
  return {
    argv: readText(raw.argv, `${at}.argv`, CLI_MAX_PARAGRAPH),
    summary: readText(raw.summary, `${at}.summary`, CLI_MAX_SUMMARY),
  }
}

function readHelpSection(raw: unknown, at: string): HelpSectionSpec {
  if (!isObject(raw)) fail(at, "help section must be an object")
  const out: HelpSectionSpec = {
    id: readName(raw.id, `${at}.id`, NAME_RE),
    title: readText(raw.title, `${at}.title`, CLI_MAX_TERM),
  }
  if (raw.text != null) out.text = readParagraphs(raw.text, `${at}.text`)
  if (raw.rows != null) out.rows = readList(raw.rows, `${at}.rows`, readRow)
  return out
}

function readRow(raw: unknown, at: string): HelpSectionRowSpec {
  if (!isObject(raw)) fail(at, "row must be an object")
  return {
    term: readText(raw.term, `${at}.term`, CLI_MAX_TERM),
    summary: readText(raw.summary, `${at}.summary`, CLI_MAX_SUMMARY),
  }
}

// ---------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------

function readList<T>(raw: unknown, at: string, item: (v: unknown, at: string) => T): T[] {
  if (!Array.isArray(raw)) fail(at, "must be an array")
  return raw.map((v, i) => item(v, `${at}[${i}]`))
}

function readBool(raw: unknown, at: string): boolean {
  if (typeof raw !== "boolean") fail(at, "must be a boolean")
  return raw
}

/**
 * Plain text check (R-3): a string, not empty unless `nonEmpty` is false,
 * at most `max` UTF-16 units, and no C0, DEL, C1, or bidi control
 * character (see {@link plainTextError}).
 */
function readText(raw: unknown, at: string, max: number, nonEmpty = true): string {
  const err = plainTextError(raw, max, nonEmpty)
  if (err !== undefined) fail(at, err)
  return raw as string
}

function readName(raw: unknown, at: string, re: RegExp): string {
  const s = readText(raw, at, CLI_MAX_TERM)
  if (!re.test(s)) fail(at, `must match ${re} (got: ${JSON.stringify(s)})`)
  return s
}

function readNames(raw: unknown, at: string, re: RegExp): string[] {
  return readList(raw, at, (v, vat) => readName(v, vat, re))
}

function readTerms(raw: unknown, at: string): string[] {
  return readList(raw, at, (v, vat) => readText(v, vat, CLI_MAX_TERM))
}

function readParagraphs(raw: unknown, at: string): string[] {
  return readList(raw, at, (v, vat) => readText(v, vat, CLI_MAX_PARAGRAPH, false))
}

/**
 * Fail on the first duplicate key. `norm` maps a key before the compare.
 * The diagnostic shows the original key.
 */
function uniqueBy<T>(
  items: T[],
  keys: (t: T) => string[],
  at: string,
  what: string,
  norm: (k: string) => string = (k) => k,
): void {
  const seen = new Map<string, string>()
  for (const item of items) {
    for (const k of keys(item)) {
      const n = norm(k)
      const prev = seen.get(n)
      if (prev !== undefined) {
        const like = prev === k ? "" : ` (same as ${JSON.stringify(prev)})`
        fail(at, `duplicate ${what}: ${JSON.stringify(k)}${like}`)
      }
      seen.set(n, k)
    }
  }
}
