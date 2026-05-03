/**
 * CLI argument normalization.
 *
 * Lifts raw `process.argv` into a canonical long-form flag list so the
 * rest of the CLI can keep its simple `args.indexOf("--foo")` parsing
 * style. Kept as its own module so it's importable from tests without
 * pulling the entire `index.ts` startup side effects.
 *
 * Supported transformations:
 *   • `--flag=value`           → `--flag value`
 *   • Short flags              → long forms (`-m` → `--model`, etc.)
 *   • Long aliases             → canonical (`--models` → `--list-models`)
 *   • Subcommand syntax (only when the very FIRST positional matches a
 *     known verb — to mirror `git status`, `npm run`, etc.):
 *
 *       models   [list]     → --list-models
 *       flags    [list]     → --list-flags
 *       spinners [list]     → --list-spinners
 *       sessions [list]     → --sessions
 *       resume   <sid|last> → --resume <sid|last>
 *       help                → --help
 *
 * The bare `-` (read prompt from stdin) is preserved verbatim.
 *
 * Users who genuinely want to send the literal prompt "models" should
 * use `--prompt models` to avoid the subcommand interpretation.
 *
 * @module cli-args
 */

const SHORT_TO_LONG: Record<string, string> = {
  "-m": "--model",
  "-p": "--prompt",
  "-f": "--formatter",
  "-e": "--effort",
  "-s": "--spinner",
  "-r": "--resume",
  "-d": "--debug",
  "-v": "--verbose",
  "-h": "--help",
}

const LONG_ALIAS: Record<string, string> = {
  "--models": "--list-models",
  "--list-model": "--list-models",
  "--flags": "--list-flags",
  "--list-flag": "--list-flags",
  "--spinners": "--list-spinners",
  "--list-spinner": "--list-spinners",
  "--session": "--sessions",
  "--list-sessions": "--sessions",
}

interface SubcommandSpec {
  flag: string
  /** If true, consume the next positional as the flag's value (`resume <sid>`). */
  takesValue?: boolean
}

const SUBCOMMANDS: Record<string, SubcommandSpec> = {
  models: { flag: "--list-models" },
  flags: { flag: "--list-flags" },
  spinners: { flag: "--list-spinners" },
  sessions: { flag: "--sessions" },
  resume: { flag: "--resume", takesValue: true },
  help: { flag: "--help" },
}

/**
 * Normalize a raw `process.argv.slice(2)` array into canonical long-form
 * flags. Pure function — does not read environment, stdin, or time.
 */
export function normalizeArgs(raw: string[]): string[] {
  const out: string[] = []

  // Subcommand recognition only at position 0.
  let start = 0
  if (raw.length > 0) {
    const head = raw[0]
    const sub = !head.startsWith("-") ? SUBCOMMANDS[head] : undefined
    if (sub) {
      out.push(sub.flag)
      start = 1
      if (sub.takesValue) {
        // `resume <sid>`: consume the next positional, if present and not a flag.
        if (raw[1] !== undefined && !raw[1].startsWith("-")) {
          out.push(raw[1])
          start = 2
        }
      } else if (raw[1] === "list") {
        // `models list`, `sessions list`, ... — `list` is a sugar verb.
        start = 2
      }
    }
  }

  for (let i = start; i < raw.length; i++) {
    const a = raw[i]

    // --flag=value → --flag value (with alias resolution on the key)
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=")
      const k = a.slice(0, eq)
      const v = a.slice(eq + 1)
      out.push(LONG_ALIAS[k] ?? k, v)
      continue
    }

    // Short flag (don't touch the bare `-` stdin sentinel)
    if (a !== "-" && a.startsWith("-") && !a.startsWith("--")) {
      const mapped = SHORT_TO_LONG[a]
      if (mapped) {
        out.push(mapped)
        continue
      }
    }

    // Long alias
    if (a.startsWith("--") && LONG_ALIAS[a]) {
      out.push(LONG_ALIAS[a])
      continue
    }

    out.push(a)
  }

  return out
}
