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
 * ```text
 * models   [list]                  → --list-models
 * flags    [list]                  → --list-flags
 * spinners [list]                  → --list-spinners
 * sessions [list|<query>]          → --sessions [<query>]
 * sessions resume <sid|last>       → --resume <sid|last>
 * usage    [<period>]              → --usage [<period>]
 * resume   <sid|last>              → --resume <sid|last>
 * provider <id> login [method]     → --login --provider <id> [--auth-method <method>]
 * login    [<provider>] [method]   → --login [--provider <provider>] [--auth-method <method>]
 * help                             → --help
 * ```
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
  "--providers": "--list-providers",
  "--list-model": "--list-models",
  "--flags": "--list-flags",
  "--list-flag": "--list-flags",
  "--spinners": "--list-spinners",
  "--list-spinner": "--list-spinners",
  "--session": "--sessions",
  "--list-sessions": "--sessions",
  "--usage-stats": "--usage",
}

interface SubcommandSpec {
  flag: string
  /** If true, consume the next positional as the flag's value (`resume <sid>`). */
  takesValue?: boolean
}

const SUBCOMMANDS: Record<string, SubcommandSpec> = {
  models: { flag: "--list-models" },
  providers: { flag: "--list-providers" },
  flags: { flag: "--list-flags" },
  spinners: { flag: "--list-spinners" },
  sessions: { flag: "--sessions" },
  // `usage [<period>]` — optional period token (today/last-day/last-month/
  // ytd/year/all). takesValue consumes the next positional when present.
  usage: { flag: "--usage", takesValue: true },
  resume: { flag: "--resume", takesValue: true },
  login: { flag: "--login" },
  logout: { flag: "--logout" },
  // Dash-form is recognized as a single token; the more discoverable
  // two-word form `auth status` would need a wider tokenizer extension —
  // skipped for now since `--auth-status` and `auth-status` cover the
  // 90% case.
  "auth-status": { flag: "--auth-status" },
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
    // Nested `sessions <verb>` grammar:
    //   sessions list                → --sessions          (legacy sugar)
    //   sessions resume <sid|last>   → --resume <sid|last> (parallels top-level `resume`)
    //   sessions <query>             → --sessions <query>  (fuzzy filter; cheap, in-memory)
    //   sessions [flag…]             → --sessions [flag…]  (bare list)
    //
    // Handled inline because the spec is genuinely two-level. SUBCOMMANDS
    // is single-token only and forcing this through it would obscure the
    // grammar more than the special case does.
    if (head === "sessions" && raw[1] !== undefined && !raw[1].startsWith("-")) {
      const second = raw[1]
      if (second === "resume") {
        out.push("--resume")
        start = 2
        if (raw[2] !== undefined && !raw[2].startsWith("-")) {
          out.push(raw[2])
          start = 3
        }
      } else if (second === "list") {
        out.push("--sessions")
        start = 2
      } else {
        // `sessions <query>` — pass the query value through.
        out.push("--sessions", second)
        start = 2
      }
    } else if (head === "providers" && raw[1] !== undefined && !raw[1].startsWith("-")) {
      // Nested `providers <verb>` grammar (parallels `sessions`):
      //   providers models [<providerId>] → --list-models [<providerId>]
      //   providers login <providerId>    → --login --provider <providerId>
      //   providers list                  → --list-providers
      //   providers <other>               → --list-providers (bare list)
      // Bare `providers` (no verb, or a flag next) falls through to
      // SUBCOMMANDS → --list-providers.
      const second = raw[1]
      if (second === "models") {
        out.push("--list-models")
        start = 2
        if (raw[2] !== undefined && !raw[2].startsWith("-")) {
          out.push(raw[2])
          start = 3
        }
      } else if (second === "login") {
        out.push("--login")
        start = 2
        if (raw[2] !== undefined && !raw[2].startsWith("-")) {
          out.push("--provider", raw[2])
          start = 3
          if (raw[3] !== undefined && !raw[3].startsWith("-")) {
            out.push("--auth-method", raw[3])
            start = 4
          }
        }
      } else {
        out.push("--list-providers")
        start = 2
      }
    } else if (head === "provider" && raw[1] !== undefined && !raw[1].startsWith("-")) {
      // Singular provider grammar:
      //   provider <providerId> login  → --login --provider <providerId>
      //   provider <providerId> models → --list-models <providerId>
      const providerId = raw[1]
      const action = raw[2]
      if (action === "login") {
        out.push("--login", "--provider", providerId)
        start = 3
        if (raw[3] !== undefined && !raw[3].startsWith("-")) {
          out.push("--auth-method", raw[3])
          start = 4
        }
      } else if (action === "models") {
        out.push("--list-models", providerId)
        start = 3
      } else {
        out.push("--list-providers")
        start = 2
      }
    } else {
      const sub = !head.startsWith("-") ? SUBCOMMANDS[head] : undefined
      if (sub) {
        out.push(sub.flag)
        start = 1
        if (head === "login" && raw[1] !== undefined && !raw[1].startsWith("-")) {
          out.push("--provider", raw[1])
          start = 2
          if (raw[2] !== undefined && !raw[2].startsWith("-")) {
            out.push("--auth-method", raw[2])
            start = 3
          }
        } else if (sub.takesValue) {
          // `resume <sid>`: consume the next positional, if present and not a flag.
          if (raw[1] !== undefined && !raw[1].startsWith("-")) {
            out.push(raw[1])
            start = 2
          }
        } else if (raw[1] === "list") {
          // `models list`, `flags list`, ... — `list` is a sugar verb.
          start = 2
        }
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
