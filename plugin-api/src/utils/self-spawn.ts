/**
 * How minimal-agent starts another copy of itself, the same way from source
 * and from a `bun build --compile` binary.
 *
 * Three things differ between the two run modes:
 *
 * | | source run (`bun src/index.ts`) | compiled binary |
 * |---|---|---|
 * | `process.argv` | `[<bun>, <abs entry .ts>, ...]` | `["bun", "/$bunfs/root/<name>", ...]` |
 * | `process.execPath` | the bun binary | the agent binary |
 * | a plugin script | a real `.ts` file on disk | an embedded module, no disk path |
 *
 * {@link selfSpawn} hides that. `agent()` is the argv prefix for a child
 * agent, and `script(id, devPath)` is the argv for a plugin entry script.
 * From source a script runs from its disk path. In a binary it runs through
 * the hidden `<binary> __run <id>` dispatch (the CLI owns it), because
 * `BUN_BE_BUN=1 <binary> /$bunfs/...` cannot load an embedded module.
 *
 * ## Why `childEnv` strips `BUN_BE_BUN`
 *
 * `BUN_BE_BUN=1` makes a compiled binary act as the plain `bun` CLI. Bun
 * reads it from the environment, so it leaks to every grandchild. If a user
 * command (a Bash tool call, a background job, a plugin subprocess) inherits
 * it and then starts `minimal-agent`, that binary runs as `bun` instead of
 * the agent. So any env that reaches a user command goes through
 * {@link childEnv} first.
 *
 * Every function takes its inputs as optional arguments (argv, execPath,
 * standalone flag, env), so a test drives both modes without touching the
 * real `process` globals.
 *
 * @module utils/self-spawn
 */

import { isAbsolute } from "node:path"

/** The env var that turns a compiled Bun binary into the plain `bun` CLI. */
export const BUN_BE_BUN_ENV = "BUN_BE_BUN"

/**
 * The env var that overrides the child-agent argv (whitespace-separated, for
 * example `"bun /path/to/src/index.ts"`). Kept from the sub-agents plugin.
 */
export const AGENT_BIN_ENV = "MINIMAL_AGENT_BIN"

/** The argv word that selects the CLI's embedded-script dispatch. */
export const RUN_SCRIPT_ARG = "__run"

/**
 * The shape of an embedded script id: `<plugin-id>/<script-name>`. Each part
 * uses the plugin-id charset (`[a-z0-9][a-z0-9_-]*`), so there is exactly one
 * slash and no `.` at all (no `..`, no extension, no path).
 */
export const SCRIPT_ID_RE = /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/

/**
 * True when this code runs from a `bun build --compile` binary. Read through
 * a narrow cast: hosts typecheck this file with their own (older) bun-types,
 * which may not declare `Bun.isStandaloneExecutable`.
 */
export function isStandaloneExecutable(): boolean {
  return (Bun as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true
}

/** True when `id` is a valid embedded script id (see {@link SCRIPT_ID_RE}). */
export function isValidScriptId(id: unknown): id is string {
  return typeof id === "string" && SCRIPT_ID_RE.test(id)
}

/**
 * Throw when `id` is not a valid embedded script id.
 *
 * @throws Error naming the bad id and the expected shape.
 */
export function assertScriptId(id: unknown): asserts id is string {
  if (!isValidScriptId(id)) {
    throw new Error(
      `invalid embedded script id ${JSON.stringify(id)}: expected "<plugin-id>/<script-name>" ` +
        `with each part matching [a-z0-9][a-z0-9_-]*`,
    )
  }
}

/**
 * A copy of `env` safe to hand to a child that may run user commands: every
 * `undefined` value dropped and `BUN_BE_BUN` deleted. See the module doc.
 */
export function childEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== BUN_BE_BUN_ENV) out[key] = value
  }
  return out
}

/** Inputs of {@link selfSpawn}. Each one defaults to the running process. */
export interface SelfSpawnOptions {
  /** Default `process.argv`. `argv[1]` is the CLI entry in a source run. */
  readonly argv?: readonly string[]
  /** Default `process.execPath`: bun from source, the binary when compiled. */
  readonly execPath?: string
  /** Default {@link isStandaloneExecutable}(). */
  readonly standalone?: boolean
  /** Env read for the `MINIMAL_AGENT_BIN` override. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** How to start another minimal-agent process. See {@link selfSpawn}. */
export interface SelfSpawn {
  /**
   * The argv prefix that starts another minimal-agent. Append normal CLI
   * flags. `MINIMAL_AGENT_BIN` wins when set (split on whitespace). Else
   * `[execPath, <abs cli entry>]` from source and `[execPath]` compiled.
   */
  agent(): string[]
  /**
   * The argv that runs the plugin entry script `id` (`"<plugin-id>/<name>"`).
   * From source: `[execPath, devPath]`, Bun runs the file. Compiled:
   * `[execPath, "__run", id]`, the CLI dispatch imports the embedded module.
   * Append the script's own arguments.
   *
   * @throws Error when `id` is not a valid script id, or `devPath` is not
   *   absolute.
   */
  script(id: string, devPath: string): string[]
  /** {@link childEnv}: a copy of `env` (default `process.env`) without `BUN_BE_BUN`. */
  childEnv(env?: Readonly<Record<string, string | undefined>>): Record<string, string>
}

/**
 * Build a {@link SelfSpawn} for this process. Inputs are read when a method
 * runs, not when this is called, so a later env change is seen.
 *
 * @example
 * ```ts
 * const self = selfSpawn()
 * Bun.spawn([...self.agent(), "-p", "hi"], { env: self.childEnv() })
 * Bun.spawn(self.script("background/runner", join(import.meta.dir, "bin/runner.ts")))
 * ```
 */
export function selfSpawn(opts: SelfSpawnOptions = {}): SelfSpawn {
  const execPath = (): string => opts.execPath ?? process.execPath
  const argv = (): readonly string[] => opts.argv ?? process.argv
  const standalone = (): boolean => opts.standalone ?? isStandaloneExecutable()
  return {
    agent() {
      const override = (opts.env ?? process.env)[AGENT_BIN_ENV]?.trim()
      if (override) return override.split(/\s+/)
      if (standalone()) return [execPath()]
      const entry = argv()[1]
      return entry ? [execPath(), entry] : [execPath()]
    },
    script(id, devPath) {
      assertScriptId(id)
      if (standalone()) return [execPath(), RUN_SCRIPT_ARG, id]
      if (typeof devPath !== "string" || !isAbsolute(devPath)) {
        throw new Error(
          `selfSpawn().script(${JSON.stringify(id)}): devPath must be absolute, got ${JSON.stringify(devPath)}`,
        )
      }
      return [execPath(), devPath]
    },
    childEnv(env) {
      return childEnv(env)
    },
  }
}
