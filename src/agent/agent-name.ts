/**
 * Per-session agent name: an opt-in, cache-safe display name the agent
 * can be given (e.g. "You are working as Laura.").
 *
 * Two halves live here:
 *
 *   1. {@link AGENT_NAMES} — a dependency-free wordlist of ~200 common
 *      first names baked into the binary. minimal-agent ships no runtime
 *      deps, so the corpus is a plain `const`, not an npm package.
 *   2. {@link resolveAgentName} — the boot-time resolver. Priority:
 *      `MINIMAL_AGENT_AGENT_NAME` env then config `agentName`, defaulting to
 *      `"auto"` when neither is set (an OFF sentinel opts out). The
 *      sentinel `"auto"` derives a STABLE name from the session id via
 *      {@link autoName} (FNV-1a hash, same primitive as
 *      `session-store.ts#shortHash`), so a resumed session keeps its name
 *      and every sub-agent (its own session id) gets a distinct one with
 *      no shared counter.
 *
 * WHY THE NAME IS RESOLVED ONCE AT BOOT AND FROZEN: the name lands in the
 * system prompt, which sits before every message on the wire. Changing it
 * mid-session would invalidate the whole conversation's prompt cache. So
 * this is a pure function of inputs that don't change during a run, called
 * once in `src/index.ts`, and never re-evaluated.
 *
 * The resolved value is published as `process.env.MINIMAL_AGENT_AGENT_NAME`
 * (the loader spreads `process.env` into every prompt-fragment `ctx.env`),
 * which the `agent-identity` plugin reads to emit its one system-prompt
 * line. Placing the line in that plugin's fragment puts it in the
 * per-session `sessionContext` block AFTER the cross-session cache
 * breakpoint, so a name costs zero shared-prefix cache. See the plugin's
 * README for the cache rationale.
 *
 * @module agent-name
 */

/**
 * Baked-in corpus of common first names. ~200 entries, deliberately plain
 * and pronounceable (they show up in logs, intercom chatter, and the Speak
 * tool). Order is irrelevant to correctness: {@link autoName} maps a hash
 * modulo the list length, so adding/removing entries only reshuffles which
 * session id maps to which name (names are cosmetic, so that drift across
 * versions is acceptable).
 *
 * Kept as a frozen array so a caller can't mutate the shared corpus.
 */
export const AGENT_NAMES: readonly string[] = Object.freeze([
  // Common male given names (English).
  "James",
  "John",
  "Robert",
  "Michael",
  "William",
  "David",
  "Richard",
  "Joseph",
  "Thomas",
  "Charles",
  "Christopher",
  "Daniel",
  "Matthew",
  "Anthony",
  "Mark",
  "Donald",
  "Steven",
  "Paul",
  "Andrew",
  "Joshua",
  "Kenneth",
  "Kevin",
  "Brian",
  "George",
  "Edward",
  "Ronald",
  "Timothy",
  "Jason",
  "Jeffrey",
  "Ryan",
  "Jacob",
  "Gary",
  "Nicholas",
  "Eric",
  "Jonathan",
  "Stephen",
  "Larry",
  "Justin",
  "Scott",
  "Brandon",
  "Benjamin",
  "Samuel",
  "Gregory",
  "Frank",
  "Raymond",
  "Patrick",
  "Jack",
  "Dennis",
  "Jerry",
  "Tyler",
  "Aaron",
  "Henry",
  "Adam",
  "Peter",
  "Nathan",
  "Zachary",
  "Walter",
  "Kyle",
  "Carl",
  "Jeremy",
  // Common female given names (English).
  "Mary",
  "Patricia",
  "Jennifer",
  "Linda",
  "Elizabeth",
  "Barbara",
  "Susan",
  "Jessica",
  "Sarah",
  "Karen",
  "Nancy",
  "Lisa",
  "Betty",
  "Margaret",
  "Sandra",
  "Ashley",
  "Kimberly",
  "Emily",
  "Donna",
  "Michelle",
  "Carol",
  "Amanda",
  "Dorothy",
  "Melissa",
  "Deborah",
  "Stephanie",
  "Rebecca",
  "Sharon",
  "Laura",
  "Cynthia",
  "Kathleen",
  "Amy",
  "Angela",
  "Shirley",
  "Anna",
  "Brenda",
  "Pamela",
  "Emma",
  "Nicole",
  "Helen",
  "Samantha",
  "Katherine",
  "Christine",
  "Debra",
  "Rachel",
  "Carolyn",
  "Janet",
  "Maria",
  "Olivia",
  "Heather",
  "Diane",
  "Julie",
  "Joyce",
  "Victoria",
  "Kelly",
  "Christina",
  "Joan",
  "Evelyn",
  "Judith",
  "Andrea",
  "Hannah",
  "Megan",
  "Cheryl",
  "Martha",
  "Madison",
  "Teresa",
  "Gloria",
  "Sara",
  "Janice",
  "Marie",
  "Julia",
  "Grace",
  "Judy",
  "Beverly",
  "Denise",
  "Marilyn",
  "Amber",
  "Danielle",
  "Brittany",
  "Diana",
  // Common Latin / Spanish given names.
  "Luis",
  "Carlos",
  "Juan",
  "Jose",
  "Miguel",
  "Camila",
  "Sofia",
  "Valentina",
  "Mateo",
  "Diego",
  "Santiago",
  "Alejandro",
  "Gabriel",
  "Daniela",
  "Isabella",
  "Lucia",
  "Mariana",
  "Pedro",
  "Fernando",
  "Ricardo",
  "Monica",
  "Veronica",
  "Pablo",
  "Andres",
  "Javier",
  "Sergio",
  "Manuel",
  "Rosa",
  "Elena",
  "Marcos",
  // Common Northern-European given names.
  "Petter",
  "Lars",
  "Erik",
  "Anders",
  "Nils",
  "Ingrid",
  "Astrid",
  "Sven",
  "Bjorn",
  "Karl",
  "Felix",
  "Oscar",
  "Hugo",
  "Emil",
  "Leon",
  "Clara",
  "Lena",
  "Greta",
  "Mia",
  "Noah",
  // A few more common given names to round the corpus to ~200.
  "Theodore",
  "Sebastian",
  "Christian",
  "Dylan",
  "Ethan",
  "Logan",
  "Lucas",
  "Mason",
  "Owen",
  "Adrian",
] as const)

/** Longest name a user-supplied literal is allowed to be (defensive cap). */
const MAX_NAME_LEN = 48

/**
 * FNV-1a 32-bit hash of `seed`, returned modulo `mod`. Same primitive as
 * `session-store.ts#shortHash`, inlined here to keep this module
 * standalone (and importable by the boot path without dragging in the
 * session store). Deterministic and dependency-free.
 */
export function hashToIndex(seed: string, mod: number): number {
  if (mod <= 0) return 0
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % mod
}

/**
 * Deterministically pick a name from {@link AGENT_NAMES} for a session id.
 * Stable across resumes (same id → same name) and well-distributed across
 * a fleet (each sub-agent has its own id), with no shared counter or lock.
 */
export function autoName(sessionId: string): string {
  return AGENT_NAMES[hashToIndex(sessionId, AGENT_NAMES.length)]
}

/**
 * Normalize a user-supplied literal name: strip control characters, collapse
 * internal whitespace, trim, and cap length. Returns `undefined` if nothing
 * usable remains (so a whitespace-only value reads as "no name").
 */
function sanitizeLiteral(raw: string): string | undefined {
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned) return undefined
  return cleaned.length > MAX_NAME_LEN ? cleaned.slice(0, MAX_NAME_LEN).trim() : cleaned
}

/** Case-insensitive sentinels that explicitly mean "no name". */
const OFF_SENTINELS = new Set(["off", "none", "false", "no", "disabled", "disable"])

/** Inputs for {@link resolveAgentName}. */
export interface ResolveAgentNameOptions {
  /** The session id, used as the seed for `"auto"`. */
  sessionId: string
  /** `config.agentName` from `~/.minimal-agent/config.jsonc`, if any. */
  configName?: string
  /** `MINIMAL_AGENT_AGENT_NAME` env value, if any. Highest priority. */
  envName?: string
}

/**
 * Resolve the session's agent name, or `undefined` only when naming is
 * explicitly turned off. Naming is now ON by default: when no source
 * supplies a value the resolver behaves as if `"auto"` were requested and
 * derives a deterministic name from `sessionId`.
 *
 * Priority, highest first: `envName` (`MINIMAL_AGENT_AGENT_NAME`), then
 * `configName` (`agentName`). The first source that carries a non-empty
 * value decides, and:
 *
 *   - an OFF sentinel (`"off"`, `"none"`, `"false"`, …) → `undefined`,
 *     so a higher-priority source can veto a lower one and opt out of the
 *     default (`MINIMAL_AGENT_AGENT_NAME=off` disables even if config names one);
 *   - `"auto"` → {@link autoName} (deterministic from `sessionId`);
 *   - anything else → that literal, sanitized.
 *
 * An empty / whitespace-only source is treated as absent and falls through
 * to the next source (rather than disabling), so `MINIMAL_AGENT_AGENT_NAME=""`
 * doesn't override a configured name.
 *
 * If neither source supplies a value, the default is `"auto"` — every
 * session gets a stable name unless the user explicitly opts out with an
 * OFF sentinel.
 */
export function resolveAgentName(opts: ResolveAgentNameOptions): string | undefined {
  for (const candidate of [opts.envName, opts.configName]) {
    if (candidate == null) continue
    const v = candidate.trim()
    if (!v) continue
    const lower = v.toLowerCase()
    if (OFF_SENTINELS.has(lower)) return undefined
    if (lower === "auto") return autoName(opts.sessionId)
    return sanitizeLiteral(v)
  }
  // No source supplied a value: default to "auto" (naming is on by default).
  return autoName(opts.sessionId)
}
