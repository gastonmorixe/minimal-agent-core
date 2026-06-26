/**
 * Pure CRUD on a memory file.
 *
 * One {@link MemoryStore} = one file on disk. The class hides the bullet
 * format and id-generation details (delegated to `lib/parse.ts`); callers
 * use `list` / `read` / `add` / `edit` / `remove` / `clear` and reason in
 * terms of {@link Bullet} objects.
 *
 * Three flavors of store, keyed by {@link MemoryStore.kind}:
 *
 * - `"global"`   → `~/.minimal-agent/memory.md`. Persistent ids.
 * - `"project"`  → `~/.minimal-agent/projects/<absolute-cwd>/memory.md`. Persistent ids.
 * - `"short-term"` → `~/.minimal-agent/sessions/<sid>.scratch.md`. Auto-incrementing
 *   integer ids, FIFO-evicted at {@link SHORT_TERM_CAP}.
 *
 * The store is intentionally synchronous (matches the existing inline-tag
 * handler and the per-turn attachment producer, which both run on the hot
 * path with tiny files). Switch to async if files ever grow past a few
 * tens of KB — they shouldn't.
 *
 * Concurrency: a `MemoryStore` is a thin wrapper around `readFileSync` /
 * `writeFileSync` / `appendFileSync`. Two processes writing to the same
 * file can race; for the persistent files the cost is at worst a torn
 * line on a giant paste, same model as `src/session-store.ts`. For the
 * short-term file there is exactly one writer per session by
 * construction (the session id is unique), so no race.
 *
 * @module memory/lib/store
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/plugin-api/utils/agent-paths"

import {
  type Bullet,
  type BulletInput,
  formatBullet,
  localIsoSeconds,
  newPersistentId,
  nextShortTermId,
  parseFileWithLines,
  serializeFile,
} from "./parse.ts"

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

/** Which kind of store this is. Drives id strategy and eviction. */
export type StoreKind = "global" | "project" | "short-term"

/**
 * Env var that namespaces ALL memory paths. When set to a non-empty,
 * valid namespace name, every store (`global`, `project`, `short-term`)
 * routes under `~/.minimal-agent/namespaces/<ns>/...` instead of the
 * top-level `~/.minimal-agent/`. Useful for:
 *
 *   - **Starting fresh** — `MINIMAL_AGENT_MEMORY_NAMESPACE=scratch <cmd>`
 *     gives the agent an empty memory store for one session without
 *     touching the user's main memory.
 *   - **Testing** — exercise save/load paths against a throwaway
 *     namespace, then `rm -rf ~/.minimal-agent/namespaces/<ns>`.
 *   - **Multi-persona** — keep "work" and "personal" memory separate
 *     by running the agent under different namespace env vars.
 *
 * When unset (the default), paths are unchanged — full backwards
 * compatibility with pre-namespace memory files.
 *
 * Validation: name must match {@link NAMESPACE_RE}. Invalid names throw
 * at path-resolution time so a typo (`/` in the namespace, `..` for
 * traversal, whitespace, empty string) fails loud instead of silently
 * writing to the default location or escaping the namespaces dir.
 *
 * Read at every path resolution (not cached) so test injection via
 * `StoreDeps.namespace` and runtime changes (e.g. setting the env
 * before each spawned subprocess) both work.
 */
export const MEMORY_NAMESPACE_ENV = "MINIMAL_AGENT_MEMORY_NAMESPACE"

/**
 * Namespace identifier shape: letters, digits, `_`, `.`, `-`. No
 * slashes (would let a malicious / typo'd value escape the namespaces
 * dir), no empty string after trim (would collapse to the default
 * path silently). The literal token `..` is also rejected even though
 * the regex allows it as a substring — defensive against `cd ..`-style
 * traversal across symlinks.
 */
const NAMESPACE_RE = /^[A-Za-z0-9_.-]+$/

/**
 * Cap on short-term entries. When `add` would push the count above this,
 * the oldest entry (by file order, which is also insertion order modulo
 * edits — see {@link MemoryStore.edit} for the bump-to-bottom rule) is
 * evicted. Surfaced to the model via the save-echo
 * `<ma::agent::memory-saved … evicted="N">` block (Phase 2).
 *
 * Picked at 20 deliberately: large enough for "active hypotheses + key
 * facts about this debug session" but small enough to force the model
 * to consolidate rather than hoard. See PROGRESS.md picks for the
 * full rationale.
 */
export const SHORT_TERM_CAP = 20

/**
 * Result of a successful `add` — the new bullet plus any bullets that
 * had to be evicted to fit under the cap. `evicted` is empty in the
 * common case (room left) and on persistent stores (no cap).
 */
export interface AddResult {
  bullet: Bullet
  evicted: Bullet[]
}

/**
 * Optional dependency injection for testing — lets tests pin the clock,
 * the random source, and `$HOME`/cwd resolution without touching the
 * real filesystem or process env.
 */
export interface StoreDeps {
  /** Unix-millis clock. Default: `Date.now`. */
  now?: () => number
  /** Random bytes (used for the persistent id tail). Default: 2 bytes from `crypto.randomBytes`. */
  rand?: () => Buffer
  /** Override the resolved `$HOME`. Default: `process.env.HOME ?? os.homedir()`. */
  home?: string
  /**
   * Override the resolved namespace. Default: `process.env[MEMORY_NAMESPACE_ENV]`.
   * Pass `null` to force "no namespace" (default top-level paths) even
   * if the env var is set — useful for the CLI's `--namespace ""`
   * reset and for tests.
   */
  namespace?: string | null
}

// ---------------------------------------------------------------------------
// Path helpers (exported for the inline-tag handler's load fragment and
// the CLI to share a single source of truth on layout).
// ---------------------------------------------------------------------------

/**
 * Resolve the `.minimal-agent` data root, honoring `MINIMAL_AGENT_HOME`.
 *
 * Routes through the shared single-source-of-truth resolver
 * ({@link resolveAgentHome}) instead of open-coding
 * `join(home, ".minimal-agent")`, so a relocated home
 * (`MINIMAL_AGENT_HOME`) is respected in production.
 *
 * Test injection is preserved: when `deps.home` is set we hand the
 * resolver `{ HOME: deps.home }`, which yields exactly
 * `join(deps.home, ".minimal-agent")` — identical to the previous
 * behavior, so existing path expectations keep passing. With no
 * injection we pass `process.env` so the override env var wins.
 */
function agentHome(deps?: StoreDeps): string {
  return deps?.home !== undefined
    ? resolveAgentHome({ HOME: deps.home })
    : resolveAgentHome(process.env)
}

/**
 * Resolve the active namespace, if any. Precedence:
 *
 *   1. Explicit `deps.namespace` (including `null` to force-disable).
 *   2. `process.env[MEMORY_NAMESPACE_ENV]`.
 *   3. None (returns `null`).
 *
 * Throws if the resolved value is a non-empty string that fails
 * {@link NAMESPACE_RE} validation or equals `..`. Empty / whitespace
 * is treated as "no namespace" (returns `null`) so an exported-but-
 * empty env var doesn't crash the plugin.
 *
 * Exported for tests. Production code goes through the path helpers,
 * which call this internally.
 */
export function resolveNamespace(deps?: StoreDeps): string | null {
  let raw: string | null | undefined
  // Defensive: callers historically passed a bare string in the `deps`
  // slot (relying on optional-chaining to silently no-op). The `in`
  // operator throws on non-objects, so guard before reaching for the
  // `namespace` key.
  if (deps && typeof deps === "object" && "namespace" in deps) {
    raw = deps.namespace
  } else {
    raw = process.env[MEMORY_NAMESPACE_ENV]
  }
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed === "..") {
    throw new Error(
      `${MEMORY_NAMESPACE_ENV}: invalid namespace "${trimmed}" (refused traversal token)`,
    )
  }
  if (!NAMESPACE_RE.test(trimmed)) {
    throw new Error(
      `${MEMORY_NAMESPACE_ENV}: invalid namespace "${trimmed}" ` +
        `(must match ${NAMESPACE_RE.source} — letters, digits, _, ., -)`,
    )
  }
  return trimmed
}

/**
 * Root of the `.minimal-agent` data dir, possibly namespaced. When a
 * namespace is active, this is `<home>/.minimal-agent/namespaces/<ns>`;
 * otherwise `<home>/.minimal-agent`. Every other path helper composes
 * from this root.
 */
function rootDir(deps?: StoreDeps): string {
  const home = agentHome(deps)
  const ns = resolveNamespace(deps)
  if (ns === null) return home
  return join(home, "namespaces", ns)
}

/** Absolute path of the cross-project (global) memory file. */
export function globalMemoryPath(deps?: StoreDeps): string {
  return join(rootDir(deps), "memory.md")
}

/** Absolute path of the per-project memory file for `cwd`. */
export function projectMemoryPath(cwd: string, deps?: StoreDeps): string {
  // Strip leading slashes so the cwd becomes a relative tree under
  // `<root>/projects/`. Mirrors the existing layout in
  // `plugins/memory/handlers/load.ts`.
  const rel = cwd.replace(/^\/+/, "")
  return join(rootDir(deps), "projects", rel, "memory.md")
}

/** Absolute path of the per-session short-term scratchpad file. */
export function shortTermMemoryPath(sid: string, deps?: StoreDeps): string {
  return join(rootDir(deps), "sessions", `${sid}.scratch.md`)
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

/**
 * One memory file's worth of bullets, with full CRUD.
 *
 * Construct via the static factories ({@link MemoryStore.global},
 * {@link MemoryStore.project}, {@link MemoryStore.shortTerm}) — the
 * direct constructor is exposed only for tests that want to point a
 * store at an arbitrary path.
 */
export class MemoryStore {
  constructor(
    public readonly path: string,
    public readonly kind: StoreKind,
    /** Session UUID stamped into new bullets (persistent stores only). May be `null`. */
    public readonly sid: string | null,
    private readonly deps: StoreDeps = {},
  ) {}

  static global(deps?: StoreDeps & { sid?: string | null }): MemoryStore {
    return new MemoryStore(globalMemoryPath(deps), "global", deps?.sid ?? null, deps)
  }

  static project(cwd: string, deps?: StoreDeps & { sid?: string | null }): MemoryStore {
    return new MemoryStore(projectMemoryPath(cwd, deps), "project", deps?.sid ?? null, deps)
  }

  static shortTerm(sid: string, deps?: StoreDeps): MemoryStore {
    if (!sid || sid.trim().length === 0) {
      throw new Error("MemoryStore.shortTerm requires a non-empty session id")
    }
    // Short-term bullets don't carry a [session:<sid>] field — the
    // entire FILE is per-session, so the field would be redundant on
    // every line. Pass `null` for sid here.
    return new MemoryStore(shortTermMemoryPath(sid, deps), "short-term", null, deps)
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Read the file (returns "" if missing) and parse into bullets, in source order. */
  list(): Bullet[] {
    const content = this.readContent()
    return parseFileWithLines(content)
      .filter((l): l is { kind: "bullet"; bullet: Bullet; raw: string } => l.kind === "bullet")
      .map((l) => l.bullet)
  }

  /**
   * Look up a single bullet by id. Returns `null` if not found.
   *
   * Both stamped ids (`lwq8tg-a8f3`, `3`) and synthetic legacy ids
   * (`legacy:<sha12>`) resolve, since `parseBullet` synthesizes the
   * latter on read.
   */
  read(id: string): Bullet | null {
    for (const b of this.list()) {
      if (b.id === id) return b
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Mutate
  // -------------------------------------------------------------------------

  /**
   * Append a new bullet. Generates the id according to {@link kind}:
   *
   * - `"global"` / `"project"` → fresh persistent id (`<base36>-<hex>`).
   * - `"short-term"` → next integer id (`max-seen + 1`), and on overflow
   *   evicts oldest-first to bring the file back to {@link SHORT_TERM_CAP}.
   *
   * The body is collapsed to a single line and trimmed (via
   * {@link formatBullet}). Empty bodies (after trim) throw.
   */
  add(body: string): AddResult {
    const trimmed = body.replace(/\s+/g, " ").trim()
    if (trimmed.length === 0) {
      throw new Error("memory.add: body is empty after trim")
    }

    const lines = parseFileWithLines(this.readContent())
    const bullets = lines.flatMap((l) => (l.kind === "bullet" ? [l.bullet] : []))

    // Generate id.
    const id =
      this.kind === "short-term"
        ? String(nextShortTermId(bullets))
        : newPersistentId(this.deps.now, this.deps.rand)

    const ts = localIsoSeconds(new Date(this.deps.now ? this.deps.now() : Date.now()))
    const input: BulletInput = {
      id,
      ts,
      sid: this.sid,
      body: trimmed,
    }
    const newRaw = formatBullet(input)
    const newBullet: Bullet = {
      id,
      ts,
      sid: this.sid,
      body: trimmed,
      isLegacy: false,
      raw: newRaw,
    }

    // Append the new line to the round-trippable line list, then
    // serialize back. We rebuild the line list rather than using
    // `appendFileSync` because eviction can require deleting older
    // lines, and consolidating both paths through `serializeFile`
    // keeps the on-disk shape consistent (trailing-newline handling,
    // etc.).
    const next: typeof lines = [...lines]

    // If the file ended without a trailing newline (i.e. the last
    // entry's `raw` is non-empty and there's no empty trailing
    // "other" entry), append one before the new bullet so the
    // serialized output ends with `…\n<new>\n`.
    const last = next[next.length - 1]
    if (last !== undefined && !(last.kind === "other" && last.raw === "")) {
      next.push({ kind: "other", raw: "" })
    }
    // Insert the new bullet IN PLACE of the trailing empty "other"
    // entry, then add a fresh trailing empty entry so the file ends
    // with `\n`.
    if (
      next.length > 0 &&
      next[next.length - 1]?.kind === "other" &&
      next[next.length - 1]?.raw === ""
    ) {
      next[next.length - 1] = { kind: "bullet", bullet: newBullet, raw: newRaw }
      next.push({ kind: "other", raw: "" })
    } else {
      next.push({ kind: "bullet", bullet: newBullet, raw: newRaw })
      next.push({ kind: "other", raw: "" })
    }

    // Eviction (short-term only). Drop the oldest bullets in source
    // order until count ≤ cap. Removed lines also drop the
    // immediately-following empty `"other"` entry if any, to avoid
    // accumulating blank rows.
    const evicted: Bullet[] = []
    if (this.kind === "short-term") {
      let bulletCount = next.filter((l) => l.kind === "bullet").length
      while (bulletCount > SHORT_TERM_CAP) {
        const idx = next.findIndex((l) => l.kind === "bullet")
        if (idx < 0) break
        const ev = next[idx] as { kind: "bullet"; bullet: Bullet; raw: string }
        evicted.push(ev.bullet)
        next.splice(idx, 1)
        bulletCount--
      }
    }

    this.writeContent(serializeFile(next))
    return { bullet: newBullet, evicted }
  }

  /**
   * Replace the body of an existing bullet (matched by id). Returns the
   * updated bullet, or `null` if no bullet with that id exists.
   *
   * Editing bumps the timestamp (so short-term FIFO-eviction order
   * effectively becomes LRU under repeated edits). The session id is
   * NOT bumped — it always reflects who originally created the bullet.
   */
  edit(id: string, newBody: string): Bullet | null {
    const trimmed = newBody.replace(/\s+/g, " ").trim()
    if (trimmed.length === 0) {
      throw new Error("memory.edit: body is empty after trim")
    }

    const lines = parseFileWithLines(this.readContent())
    let updated: Bullet | null = null
    const ts = localIsoSeconds(new Date(this.deps.now ? this.deps.now() : Date.now()))

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (l?.kind !== "bullet" || l.bullet.id !== id) continue
      const next: BulletInput = {
        // Preserve the legacy synthetic id if we're editing a legacy
        // bullet — but stamp it as the canonical id going forward by
        // re-running it through formatBullet (which doesn't know about
        // legacy synthesis) so the file gets a real `[#legacy:…]` prefix
        // on disk. The next read will see it as non-legacy with the
        // stamped id; this is the gentle migration path for legacy
        // entries that get touched.
        //
        // Wait — that would change the synthesis going forward. Better
        // to keep legacy ids opaque on edit too. The user's `rewrite-ids`
        // CLI subcommand is the explicit migration path. So we keep the
        // existing id verbatim.
        id: l.bullet.id,
        ts,
        sid: l.bullet.sid,
        body: trimmed,
      }
      const newRaw = formatBullet(next)
      const newBullet: Bullet = {
        id: next.id,
        ts: next.ts,
        sid: next.sid,
        body: trimmed,
        // After an edit the bullet has an `[#id]` prefix on disk,
        // so re-parsing it would no longer be flagged legacy. But we
        // still serialize it with the legacy synthetic id, which
        // means parseBullet will treat it as a STAMPED bullet (the
        // hash form is just text from its perspective). That's fine —
        // the id remains stable across reads, which is the contract.
        isLegacy: false,
        raw: newRaw,
      }
      lines[i] = { kind: "bullet", bullet: newBullet, raw: newRaw }
      updated = newBullet
      break
    }

    if (updated === null) return null
    this.writeContent(serializeFile(lines))
    return updated
  }

  /**
   * Remove a bullet by id. Returns the removed bullet, or `null` if no
   * bullet with that id exists.
   *
   * The line is dropped from the file along with one immediately-
   * following empty line (if any) so the file doesn't accumulate blank
   * rows on repeated removes.
   */
  remove(id: string): Bullet | null {
    const lines = parseFileWithLines(this.readContent())
    let removed: Bullet | null = null

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (l?.kind !== "bullet" || l.bullet.id !== id) continue
      removed = l.bullet
      // Drop this line and (if present and empty) the immediately-following
      // "other" line, to keep the file tidy.
      const next = lines[i + 1]
      if (next?.kind === "other" && next.raw === "") {
        lines.splice(i, 2)
      } else {
        lines.splice(i, 1)
      }
      break
    }

    if (removed === null) return null
    this.writeContent(serializeFile(lines))
    return removed
  }

  /**
   * Wipe ALL bullets. Refuses for `global` and `project` (those are
   * persistent and clearing them is a footgun — use repeated `remove`
   * by id instead, or `rm` the file by hand). Allowed only for
   * `short-term`.
   *
   * Returns the number of bullets removed.
   */
  clear(): number {
    if (this.kind !== "short-term") {
      throw new Error(
        `memory.clear: refused — only short-term scope allows clear (got ${this.kind})`,
      )
    }
    const before = this.list().length
    if (existsSync(this.path)) {
      // Truncate to empty rather than `unlink`, so a watcher (if any)
      // sees a write event and re-reads. Cheap.
      writeFileSync(this.path, "", "utf-8")
    }
    return before
  }

  // -------------------------------------------------------------------------
  // Internal IO
  // -------------------------------------------------------------------------

  private readContent(): string {
    if (!existsSync(this.path)) return ""
    try {
      return readFileSync(this.path, "utf-8")
    } catch {
      return ""
    }
  }

  private writeContent(content: string): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, content, "utf-8")
  }
}
