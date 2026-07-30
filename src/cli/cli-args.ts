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
 * models-live [list]               → --list-models-live
 * flags    [list]                  → --list-flags
 * plugins  [list]                  → --list-plugins
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
  "-F": "--fast",
  "-d": "--debug",
  "-v": "--verbose",
  "-h": "--help",
}

const LONG_ALIAS: Record<string, string> = {
  "--models": "--list-models",
  "--models-live": "--list-models-live",
  "--providers": "--list-providers",
  "--list-model": "--list-models",
  "--list-model-live": "--list-models-live",
  "--flags": "--list-flags",
  "--list-flag": "--list-flags",
  "--plugins": "--list-plugins",
  "--list-plugin": "--list-plugins",
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
  "models-live": { flag: "--list-models-live" },
  providers: { flag: "--list-providers" },
  flags: { flag: "--list-flags" },
  plugins: { flag: "--list-plugins" },
  spinners: { flag: "--list-spinners" },
  sessions: { flag: "--sessions" },
  // `usage [<period>]` — optional period token (today/last-day/last-month/
  // ytd/year/all). takesValue consumes the next positional when present.
  // `resume-same <sid|last>` is a subcommand alias for --resume-same-sid
  // but needs the two-word sessions path below for actual dispatch.
  "resume-same": { flag: "--resume-same-sid", takesValue: true },
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
 * Non-ASCII dash-like codepoints that a "smart dashes" / autocorrect
 * feature (macOS text substitution, some editors, copy-paste from rich
 * text) silently swaps in for a plain ASCII hyphen-minus (`-`, U+002D):
 *
 *   U+2010 HYPHEN            U+2011 NON-BREAKING HYPHEN
 *   U+2012 FIGURE DASH       U+2013 EN DASH
 *   U+2014 EM DASH           U+2015 HORIZONTAL BAR
 *   U+2212 MINUS SIGN        U+FE58 SMALL EM DASH
 *   U+FE63 SMALL HYPHEN-MINUS  U+FF0D FULLWIDTH HYPHEN-MINUS
 *
 * These look almost identical to `-` in a terminal but are different
 * bytes, so a flag like `--resume–same-sid` (en-dash in the middle)
 * silently fails to match `args.indexOf("--resume-same-sid")` and the
 * value gets misparsed as a positional prompt.
 */
const UNICODE_DASHES = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D"
const UNICODE_DASH_RE = new RegExp(`[${UNICODE_DASHES}]`)
const UNICODE_DASH_RE_G = new RegExp(`[${UNICODE_DASHES}]`, "g")

export interface DashTypo {
  /** The offending argv token, verbatim. */
  arg: string
  /** Its position in the raw argv array (0-based). */
  index: number
  /** The token with every unicode dash rewritten to an ASCII hyphen. */
  suggestion: string
  /** The first offending codepoint, as `U+XXXX`, for the error message. */
  codepoint: string
}

/**
 * Scan raw argv for flag-position tokens that contain a non-ASCII dash.
 *
 * A token is flagged when it *looks like a flag* (its first character is
 * an ASCII hyphen or one of the unicode dash lookalikes) AND it contains
 * at least one unicode dash. Plain values (a prompt, a path, a sid) don't
 * start with a dash, so they're never flagged — a prompt like
 * `"cost–benefit analysis"` is a separate non-dash token and passes
 * through untouched.
 *
 * Pure function — no env, stdin, or time. Detection runs on the RAW argv
 * (before {@link normalizeArgs}) since a mangled flag survives
 * normalization unchanged and would otherwise be silently misparsed.
 */
export function findDashTypos(raw: string[]): DashTypo[] {
  const out: DashTypo[] = []
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]
    if (a === undefined || a.length < 2) continue
    const first = a[0]
    const startsLikeFlag = first === "-" || UNICODE_DASHES.includes(first)
    if (!startsLikeFlag) continue
    const m = a.match(UNICODE_DASH_RE)
    if (!m) continue
    out.push({
      arg: a,
      index: i,
      suggestion: a.replace(UNICODE_DASH_RE_G, "-"),
      codepoint: `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
    })
  }
  return out
}

/**
 * Render a friendly, actionable CLI error for one or more dash typos.
 * Returns a multi-line string (no trailing newline) suitable for writing
 * to stderr before exiting non-zero.
 */
export function formatDashTypoError(typos: DashTypo[]): string {
  const lines: string[] = [
    typos.length === 1
      ? "error: an argument contains a non-ASCII dash character"
      : `error: ${typos.length} arguments contain non-ASCII dash characters`,
  ]
  for (const t of typos) {
    lines.push(`  ${t.arg}`)
    lines.push(`    has ${t.codepoint} (a dash lookalike), not an ASCII hyphen '-'`)
    lines.push(`    did you mean:  ${t.suggestion}`)
  }
  lines.push("")
  lines.push("This usually comes from \"smart dashes\"/autocorrect turning '-' into '–' or '—'.")
  lines.push("Retype the flag by hand (don't copy-paste the old line) using plain hyphens.")
  return lines.join("\n")
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
      if (second === "dump") {
        out.push("--dump")
        start = 2
        if (raw[2] !== undefined && !raw[2].startsWith("-")) {
          out.push(raw[2])
          start = 3
        }
      } else if (second === "resume") {
        out.push("--resume")
        start = 2
        if (raw[2] !== undefined && !raw[2].startsWith("-")) {
          out.push(raw[2])
          start = 3
        }
      } else if (second === "resume-same") {
        out.push("--resume-same-sid")
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
      //   providers models-live [<providerId>] → --list-models-live [<providerId>]
      //   providers login <providerId>    → --login --provider <providerId>
      //   providers logout <providerId>   → --logout --provider <providerId>
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
      } else if (second === "models-live") {
        out.push("--list-models-live")
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
      } else if (second === "logout") {
        out.push("--logout")
        start = 2
        if (raw[2] !== undefined && !raw[2].startsWith("-")) {
          out.push("--provider", raw[2])
          start = 3
        }
      } else {
        out.push("--list-providers")
        start = 2
      }
    } else if (head === "provider" && raw[1] !== undefined && !raw[1].startsWith("-")) {
      // Singular provider grammar:
      //   provider <providerId> login [--name <name>]  → --login --provider <providerId> [--name <name>]
      //   provider <providerId> logout                  → --logout --provider <providerId>
      //   provider <providerId> models → --list-models <providerId>
      //   provider <providerId> models-live → --list-models-live <providerId>
      const providerId = raw[1]
      const action = raw[2]
      if (action === "login") {
        out.push("--login", "--provider", providerId)
        start = 3
        // Consume positional auth-method (e.g. `provider acme login oauth`)
        if (raw[3] !== undefined && !raw[3].startsWith("-")) {
          out.push("--auth-method", raw[3])
          start = 4
        }
        // Also consume --name <name> and --auth-method <method> flags in any order
        let i = start
        while (i < raw.length && raw[i] !== undefined && raw[i].startsWith("--")) {
          if (raw[i] === "--name" && raw[i + 1] !== undefined && !raw[i + 1].startsWith("-")) {
            out.push("--name", raw[i + 1])
            i += 2
          } else if (
            raw[i] === "--auth-method" &&
            raw[i + 1] !== undefined &&
            !raw[i + 1].startsWith("-")
          ) {
            out.push("--auth-method", raw[i + 1])
            i += 2
          } else {
            break
          }
        }
        start = i
      } else if (action === "logout") {
        out.push("--logout", "--provider", providerId)
        start = 3
      } else if (action === "models") {
        out.push("--list-models", providerId)
        start = 3
      } else if (action === "models-live") {
        out.push("--list-models-live", providerId)
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
        } else if (head === "logout" && raw[1] !== undefined && !raw[1].startsWith("-")) {
          out.push("--provider", raw[1])
          start = 2
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
