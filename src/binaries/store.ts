/**
 * Managed binary store.
 *
 * Owns `~/.minimal-agent/bin/` plus a sidecar JSON manifest
 * (`~/.minimal-agent/bin/.binaries.json`) recording, per logical binary, the
 * version + sha256 + source URL the host installed. This is the single source
 * of truth for "what binaries do we manage and at what version".
 *
 * Responsibilities:
 *   - Build a read-only {@link BinaryInventory} (manifest ∩ on-disk reality).
 *   - Classify a {@link BinarySpec} against the inventory ({@link RequirementStatus}).
 *   - Install / update a binary from a {@link BinarySpec}: download → verify
 *     sha256 → (extract) → atomic install → record. All side effects live
 *     HERE, never in a plugin.
 *
 * Every public method is best-effort and never throws into the boot path;
 * failures are returned as data ({@link InstallOutcome}) or swallowed (manifest
 * read of a corrupt file → empty inventory + a logged notice).
 *
 * Security: the store NEVER executes a candidate binary. Versions come from the
 * recorded manifest, written by the host at install time. Presence is `stat`,
 * not spawn. A foreign file with no manifest record is reported as
 * `"unknown-version"` so the host reinstalls a known-good copy.
 *
 * @module binaries/store
 */

// import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/plugin-api/utils/agent-paths"

import { acquireLock, type LockHandle } from "../file-lock.ts"
import { getSessionId } from "../session-id.ts"
import { parseJsonc } from "../utils/jsonc.ts"

import type {
  BinaryInventory,
  BinarySource,
  BinarySpec,
  InstalledBinary,
  InstallOutcome,
  InstallProgress,
  RequirementStatus,
} from "./types.ts"
import { compareVersions } from "./version.ts"

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i
const SHA_RE = /^[0-9a-f]{64}$/i
const MANIFEST_FILE = ".binaries.json"
const MANIFEST_VERSION = 1

/**
 * Hard ceiling on a single download's body, enforced DURING the read loop (not
 * just trusted from `content-length`, which a hostile server can omit or lie
 * about). A managed CLI binary / archive is tens of MiB at most; 512 MiB is a
 * generous headroom that still stops a multi-GB or unbounded body from OOMing
 * the boot/provision path before the sha256 check (which only runs after the
 * whole body is in RAM). Exceeding it aborts the fetch with `download-failed`
 * and writes nothing.
 */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

/** Default managed bin dir: `<agent-home>/bin` (honors `MINIMAL_AGENT_HOME`). */
export function defaultBinDir(): string {
  return join(resolveAgentHome(), "bin")
}

/** Shape of the on-disk manifest. */
interface ManifestFileShape {
  version: number
  entries: InstalledBinary[]
}

/** Injected dependencies (all defaulted; overridden in tests). */
export interface BinaryStoreDeps {
  /** Fetch implementation. Defaults to global `fetch`. */
  fetchFn?: typeof fetch
  /** Progress sink. No-op by default. */
  onProgress?: (p: InstallProgress) => void
  /** Diagnostic logger. No-op by default; production passes the syslog emitter. */
  log?: (
    severity: "info" | "notice" | "warn" | "error",
    source: string,
    message: string,
    sd?: Record<string, string | number | boolean>,
  ) => void
  /** Extractor for archive bytes. Default spawns `tar` / `unzip`. */
  extractFn?: (archivePath: string, destDir: string) => Promise<void>
  /**
   * Resolve a GitHub token for `github-release` sources. Returns `null` when no
   * token is available (the install then fails with a clear `download-failed`
   * rather than leaking that the repo is private). The host wires this to
   * `resolveGithubToken` (the same chain used for the private plugin clone); the
   * plugin NEVER supplies a token. Omitted ⇒ `github-release` sources can't be
   * fetched (treated as no token).
   */
  tokenProvider?: () => Promise<string | null>
}

/**
 * Content-addressed store for plugin-declared external binaries under a
 * single directory (default `~/.minimal-agent/bin`). Downloads archives,
 * verifies checksums, extracts, and tracks installs in a JSON manifest so
 * repeat requests are no-ops. All failure modes surface as structured
 * `InstallProgress` events rather than thrown strings.
 */
export class BinaryStore {
  readonly dir: string
  private readonly manifestPath: string
  private readonly deps: {
    fetchFn: typeof fetch
    onProgress: (p: InstallProgress) => void
    log: NonNullable<BinaryStoreDeps["log"]>
    extractFn: (archivePath: string, destDir: string) => Promise<void>
    tokenProvider: () => Promise<string | null>
  }

  constructor(dir: string = defaultBinDir(), deps: BinaryStoreDeps = {}) {
    this.dir = dir
    this.manifestPath = join(dir, MANIFEST_FILE)
    this.deps = {
      fetchFn: deps.fetchFn ?? fetch,
      onProgress: deps.onProgress ?? (() => {}),
      log: deps.log ?? (() => {}),
      extractFn: deps.extractFn ?? defaultExtract,
      tokenProvider: deps.tokenProvider ?? (async () => null),
    }
  }

  // -------------------------------------------------------------------------
  // Manifest I/O
  // -------------------------------------------------------------------------

  /**
   * Read the recorded manifest entries. A missing file → empty. A corrupt
   * file → empty + a logged notice (we never crash boot over a bad manifest,
   * and never silently delete it. The next successful install rewrites it).
   */
  private readManifest(): InstalledBinary[] {
    if (!existsSync(this.manifestPath)) return []
    try {
      const raw = readFileSync(this.manifestPath, "utf8")
      const parsed = parseJsonc(raw) as Partial<ManifestFileShape> | null
      if (!parsed || !Array.isArray(parsed.entries)) return []
      return parsed.entries.filter(
        (e): e is InstalledBinary =>
          !!e && typeof e === "object" && typeof (e as InstalledBinary).name === "string",
      )
    } catch (err) {
      this.deps.log("notice", "binaries.manifest-read", "could not parse binary manifest", {
        path: this.manifestPath,
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  /** Atomically write the manifest (temp + rename), mode 0600. Best-effort. */
  private writeManifest(entries: InstalledBinary[]): void {
    const body: ManifestFileShape = { version: MANIFEST_VERSION, entries }
    const json = `${JSON.stringify(body, null, 2)}\n`
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = join(this.dir, `${MANIFEST_FILE}.${process.pid}.tmp`)
      writeFileSync(tmp, json, { mode: 0o600 })
      renameSync(tmp, this.manifestPath)
    } catch (err) {
      this.deps.log("warn", "binaries.manifest-write", "could not write binary manifest", {
        path: this.manifestPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  /**
   * Build the read-only inventory: the intersection of the recorded manifest
   * and on-disk reality. A recorded entry whose file vanished is dropped from
   * `has()`/`get()` (so the host reinstalls), but the record is left in the
   * manifest until the next write so we don't churn the file on every boot.
   */
  inventory(): BinaryInventory {
    const recorded = this.readManifest()
    const entries = new Map<string, InstalledBinary>()
    for (const e of recorded) {
      if (existsSync(e.path)) entries.set(e.name, e)
    }
    const status = (spec: BinarySpec): RequirementStatus => classify(spec, entries.get(spec.name))
    return {
      dir: this.dir,
      entries,
      has: (name) => entries.has(name),
      get: (name) => entries.get(name),
      status,
    }
  }

  /** Classify a single spec against the current inventory. */
  status(spec: BinarySpec): RequirementStatus {
    return this.inventory().status(spec)
  }

  /** Convenience: is `name` installed (recorded AND present on disk)? */
  has(name: string): boolean {
    return this.inventory().has(name)
  }

  /** Convenience: the installed record for `name`, if any. */
  get(name: string): InstalledBinary | undefined {
    return this.inventory().get(name)
  }

  // -------------------------------------------------------------------------
  // Install / update
  // -------------------------------------------------------------------------

  /**
   * Install or update one binary from its spec. Pipeline:
   *   1. validate spec (name / sha shape)
   *   2. download `url` to a temp file (streamed, with progress)
   *   3. verify sha256 BEFORE touching anything permanent
   *   4. if archive: extract the member; else use the raw file
   *   5. atomically move into `dir/<name>`, chmod 0755
   *   6. record in the manifest
   *
   * Always resolves; failures are returned as `{ ok: false, kind, detail }`.
   */
  async install(spec: BinarySpec): Promise<InstallOutcome> {
    if (!NAME_RE.test(spec.name)) {
      return fail("spec-invalid", `invalid binary name: ${spec.name}`)
    }
    if (!SHA_RE.test(spec.sha256)) {
      return fail("spec-invalid", `invalid sha256 for ${spec.name}`)
    }

    const prior = this.inventory().get(spec.name)
    const action: "installed" | "updated" = prior ? "updated" : "installed"

    let work: string | null = null
    try {
      mkdirSync(this.dir, { recursive: true })
      work = mkdtempSync(join(tmpdir(), `ma-bin-${spec.name}-`))

      // (1) Download.
      this.progress(spec, "fetching", null)
      const dl = await this.download(spec, work)
      if (!dl.ok) return dl.outcome

      // (2) Verify sha256.
      this.progress(spec, "verifying", 1)
      const actual = sha256File(dl.path)
      if (actual.toLowerCase() !== spec.sha256.toLowerCase()) {
        this.deps.log("error", "binaries.sha-mismatch", `sha256 mismatch for ${spec.name}`, {
          name: spec.name,
          expected: spec.sha256,
          actual,
          source: sourceLabel(spec.source),
        })
        return fail("sha-mismatch", `sha256 mismatch for ${spec.name} (expected ${spec.sha256})`)
      }

      // (3) Resolve the binary file (extract if archive).
      let binSrc = dl.path
      const extraSrcs: Array<{ basename: string; path: string }> = []
      if (sourceIsArchive(spec.source)) {
        this.progress(spec, "extracting", null)
        const extractDir = join(work, "x")
        mkdirSync(extractDir, { recursive: true })
        try {
          await this.deps.extractFn(dl.path, extractDir)
        } catch (err) {
          return fail(
            "extract-failed",
            `extract failed for ${spec.name}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const member = spec.archiveMember ?? spec.name
        const found = findMember(extractDir, member)
        if (!found) {
          return fail("extract-failed", `member "${member}" not found in archive for ${spec.name}`)
        }
        binSrc = found
        // Sibling files the binary needs (e.g. obscura-worker next to obscura).
        for (const extra of spec.archiveExtraMembers ?? []) {
          const ep = findMember(extractDir, extra)
          if (!ep) {
            return fail(
              "extract-failed",
              `extra member "${extra}" not found in archive for ${spec.name}`,
            )
          }
          extraSrcs.push({ basename: extra, path: ep })
        }
      }

      // (4) Atomic install into the managed dir.
      this.progress(spec, "installing", null)
      const dest = join(this.dir, spec.name)
      const staged = join(this.dir, `.${spec.name}.${process.pid}.staged`)
      try {
        // Copy into the managed dir first (cross-device rename safety), then
        // chmod, then rename into place (atomic on the same filesystem).
        writeFileSync(staged, readFileSync(binSrc))
        chmodSync(staged, 0o755)
        renameSync(staged, dest)
      } catch (err) {
        try {
          if (existsSync(staged)) rmSync(staged, { force: true })
        } catch {
          /* ignore cleanup error */
        }
        return fail(
          "write-failed",
          `install write failed for ${spec.name}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      // (4b) Install sibling extras alongside the main binary.
      const installedExtras: string[] = []
      for (const extra of extraSrcs) {
        const edest = join(this.dir, extra.basename)
        const estaged = join(this.dir, `.${extra.basename}.${process.pid}.staged`)
        try {
          writeFileSync(estaged, readFileSync(extra.path))
          chmodSync(estaged, 0o755)
          renameSync(estaged, edest)
          installedExtras.push(extra.basename)
        } catch (err) {
          try {
            if (existsSync(estaged)) rmSync(estaged, { force: true })
          } catch {
            /* ignore cleanup error */
          }
          return fail(
            "write-failed",
            `install of extra "${extra.basename}" failed for ${spec.name}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      // (5) Record. Serialize the manifest read-modify-write with the shared
      // cooperative file lock (B-046): two sessions installing DIFFERENT
      // binaries can otherwise interleave readManifest → filter → push →
      // writeManifest and clobber each other's entry, leaving a lost record
      // (which then triggers a spurious haltIfMissing or a needless reinstall).
      // The lock is keyed on the manifest file path; the read happens UNDER the
      // lock so we never trust a pre-lock snapshot. Install is async, so the
      // await fits without changing any sync call site.
      const installed: InstalledBinary = {
        name: spec.name,
        path: dest,
        version: spec.version,
        sha256: spec.sha256.toLowerCase(),
        installedAt: new Date().toISOString(),
        sourceUrl: sourceLabel(spec.source),
        ...(installedExtras.length > 0 ? { extras: installedExtras } : {}),
      }
      let manifestLock: LockHandle | null = null
      try {
        manifestLock = await acquireLock(
          this.manifestPath,
          { sessionId: getSessionId(), tool: "binary-provision" },
          { timeoutMs: 10_000 },
        )
      } catch (err) {
        // Couldn't get the lock (timeout / abort / IO). Degrade to an unlocked
        // write rather than dropping the record of an install whose bytes are
        // ALREADY on disk; this is no worse than the pre-lock behavior.
        this.deps.log("notice", "binaries.manifest-lock", "proceeding without manifest lock", {
          path: this.manifestPath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      try {
        const next = this.readManifest().filter((e) => e.name !== spec.name)
        next.push(installed)
        this.writeManifest(next)
      } finally {
        manifestLock?.release()
      }

      this.progress(spec, "done", 1)
      this.deps.log("info", `binaries.${action}`, `${action} ${spec.name} ${spec.version}`, {
        name: spec.name,
        version: spec.version,
        sha256: installed.sha256 ?? "",
        path: dest,
        source: sourceLabel(spec.source),
        ...(prior?.version ? { "from-version": prior.version } : {}),
      })
      return { ok: true, installed, action }
    } finally {
      if (work) {
        try {
          rmSync(work, { recursive: true, force: true })
        } catch {
          /* best-effort temp cleanup */
        }
      }
    }
  }

  /**
   * Remove a managed binary + its manifest record. Best-effort; returns true
   * when the record was present (regardless of file-unlink success).
   */
  remove(name: string): boolean {
    const entries = this.readManifest()
    const had = entries.some((e) => e.name === name)
    const dest = join(this.dir, name)
    try {
      if (existsSync(dest)) rmSync(dest, { force: true })
    } catch {
      /* ignore */
    }
    if (had) {
      this.writeManifest(entries.filter((e) => e.name !== name))
      this.deps.log("notice", "binaries.removed", `removed ${name}`, { name, path: dest })
    }
    return had
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async download(
    spec: BinarySpec,
    workDir: string,
  ): Promise<{ ok: true; path: string } | { ok: false; outcome: InstallOutcome }> {
    // Resolve the source into a concrete URL + headers. For a private GitHub
    // release this is a two-step API dance: GET the release by tag to find the
    // asset id, then GET the asset with `Accept: application/octet-stream` +
    // bearer token (GitHub streams the bytes, no public URL involved).
    let url: string
    const headers: Record<string, string> = { "User-Agent": "minimal-agent/binaries" }
    if (spec.source.kind === "url") {
      url = spec.source.url
    } else {
      // Embedded plugin credential wins (travels with every copy, so an
      // account-less machine can still pull); fall back to the host's
      // token provider (the user's own token) only when none is embedded.
      const token = spec.source.token ?? (await this.deps.tokenProvider())
      if (!token) {
        return {
          ok: false,
          outcome: fail(
            "download-failed",
            `no GitHub token available to fetch ${spec.name} from ${spec.source.repo} ` +
              `(set MINIMAL_AGENT_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN, or run \`gh auth login\`)`,
          ),
        }
      }
      const resolved = await this.resolveGithubAsset(spec.source, token)
      if (!resolved.ok) return { ok: false, outcome: resolved.outcome }
      url = resolved.url
      headers.Authorization = `Bearer ${token}`
      headers.Accept = "application/octet-stream"
    }

    const out = join(workDir, "download")
    // SSRF / scheme guard (B-047): a plugin-supplied `kind:"url"` source could
    // otherwise aim the fetch at file://, plaintext http://, or an internal /
    // cloud-metadata host. Validate the URL we're about to hit. The resolved
    // GitHub asset URL is always https://api.github.com/... so it passes; the
    // 302 it returns to a signed CDN host is followed by `redirect: "follow"`
    // (per-hop revalidation is a deferred follow-up, see rejectUnsafeDownloadUrl).
    const unsafe = rejectUnsafeDownloadUrl(url)
    if (unsafe) {
      return {
        ok: false,
        outcome: fail("download-failed", `${unsafe} (for ${spec.name})`),
      }
    }
    try {
      const res = await this.deps.fetchFn(url, { headers, redirect: "follow" })
      if (!res.ok || !res.body) {
        return {
          ok: false,
          outcome: fail("download-failed", `HTTP ${res.status} fetching ${spec.name}`),
        }
      }
      const total = Number(res.headers.get("content-length") ?? "") || undefined
      // Trust nothing: reject a too-large body up front if the server even
      // admits its size, AND enforce the ceiling byte-by-byte below (a hostile
      // server can omit or under-report content-length).
      if (total !== undefined && total > MAX_DOWNLOAD_BYTES) {
        return {
          ok: false,
          outcome: fail(
            "download-failed",
            `${spec.name} exceeds max size: content-length ${total} > ${MAX_DOWNLOAD_BYTES} bytes`,
          ),
        }
      }
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let done = 0
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        if (value) {
          done += value.byteLength
          // Abort BEFORE buffering more: cancel the stream and bail rather than
          // Buffer.concat a partial multi-GB body that would OOM the host.
          if (done > MAX_DOWNLOAD_BYTES) {
            await reader.cancel().catch(() => {})
            return {
              ok: false,
              outcome: fail(
                "download-failed",
                `${spec.name} exceeds max size: read ${done} bytes > ${MAX_DOWNLOAD_BYTES} bytes`,
              ),
            }
          }
          chunks.push(value)
          this.progress(spec, "fetching", total ? done / total : null, done, total)
        }
      }
      const buf = Buffer.concat(chunks)
      writeFileSync(out, buf)
      return { ok: true, path: out }
    } catch (err) {
      return {
        ok: false,
        outcome: fail(
          "download-failed",
          `download error for ${spec.name}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      }
    }
  }

  /**
   * Resolve a `github-release` source to the API asset URL via the tagged
   * release. Returns the `assets/<id>` URL; the caller fetches it with the
   * octet-stream Accept header + bearer token to stream the bytes. Works for
   * private repos (token has `repo` scope) and public ones alike.
   */
  private async resolveGithubAsset(
    source: Extract<BinarySource, { kind: "github-release" }>,
    token: string,
  ): Promise<{ ok: true; url: string } | { ok: false; outcome: InstallOutcome }> {
    // `repo` is "owner/name", so encode each path segment (NOT the slash)
    // rather than the whole string. Plugin-supplied (B-047): encode it the same
    // way `tag` already is, so a crafted value can't inject extra path segments
    // / query / a different host into the API URL.
    const repoPath = source.repo
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/")
    const api = `https://api.github.com/repos/${repoPath}/releases/tags/${encodeURIComponent(source.tag)}`
    try {
      const res = await this.deps.fetchFn(api, {
        headers: {
          "User-Agent": "minimal-agent/binaries",
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
        redirect: "follow",
      })
      if (!res.ok) {
        return {
          ok: false,
          outcome: fail(
            "download-failed",
            `GitHub release lookup failed (HTTP ${res.status}) for ${source.repo}@${source.tag}`,
          ),
        }
      }
      const body = (await res.json()) as { assets?: Array<{ id: number; name: string }> }
      const asset = body.assets?.find((a) => a.name === source.asset)
      if (!asset) {
        return {
          ok: false,
          outcome: fail(
            "download-failed",
            `asset "${source.asset}" not found in ${source.repo}@${source.tag}`,
          ),
        }
      }
      return {
        ok: true,
        url: `https://api.github.com/repos/${repoPath}/releases/assets/${asset.id}`,
      }
    } catch (err) {
      return {
        ok: false,
        outcome: fail(
          "download-failed",
          `GitHub release lookup error for ${source.repo}@${source.tag}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      }
    }
  }

  private progress(
    spec: BinarySpec,
    phase: InstallProgress["phase"],
    fraction: number | null,
    bytesDone?: number,
    bytesTotal?: number,
  ): void {
    this.deps.onProgress({
      name: spec.name,
      version: spec.version,
      phase,
      fraction,
      bytesDone,
      bytesTotal,
    })
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Classify a spec against an installed record. Pure. */
export function classify(
  spec: BinarySpec,
  installed: InstalledBinary | undefined,
): RequirementStatus {
  if (!installed) return "missing"
  if (!installed.version) return "unknown-version"
  const cmp = compareVersions(installed.version, spec.version)
  if (Number.isNaN(cmp)) return "unknown-version"
  return cmp >= 0 ? "satisfied" : "outdated"
}

/**
 * Reject a download URL that isn't a plain `https:` request to a non-internal
 * host (B-047). A `kind:"url"` source is plugin-supplied, so without this a
 * hostile/compromised spec could point the fetch at `file://`, plaintext
 * `http://`, `data:`, or an internal/metadata target (`169.254.169.254`,
 * `localhost`, RFC-1918 ranges) and turn the provisioner into an SSRF/exfil
 * primitive. Returns a human-readable reason when the URL MUST be rejected,
 * else `null`.
 *
 * Scope: this validates the URL we are about to fetch. `redirect: "follow"`
 * can still bounce a 3xx to an internal host, so full protection needs per-hop
 * revalidation (`redirect: "manual"` + re-checking each `Location`). That is a
 * deliberate FOLLOW-UP, not done here: the GitHub asset path legitimately 302s
 * to a signed `objects.githubusercontent.com` / S3 host, and manual redirect
 * following would complicate that happy path. DNS-rebind (a hostname that
 * *resolves* to a private IP at connect time) is likewise out of scope; this
 * is a literal-hostname guard against the direct cases a hostile spec uses.
 */
export function rejectUnsafeDownloadUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return `invalid download URL: ${raw}`
  }
  if (u.protocol !== "https:") {
    return `refusing non-https download URL (scheme "${u.protocol}"): ${raw}`
  }
  if (isInternalHost(u.hostname)) {
    return `refusing download from internal/metadata host "${u.hostname}"`
  }
  return null
}

/**
 * Literal-hostname check for obvious internal / loopback / link-local /
 * metadata targets (the SSRF blocklist for {@link rejectUnsafeDownloadUrl}).
 * Best-effort string match against the URL's hostname, NOT full DNS-rebind
 * protection (a hostname that resolves to a private IP is out of scope). IPv6
 * prefix checks only fire on an actual IPv6 literal (contains `:`) so a normal
 * domain like `fcservice.com` is never misclassified.
 */
export function isInternalHost(hostname: string): boolean {
  // URL.hostname is already lowercased and has IPv6 brackets stripped.
  const h = hostname.toLowerCase()
  if (h === "localhost" || h.endsWith(".localhost")) return true

  // IPv6 literal: only reachable when the hostname actually contains a colon,
  // so these prefix tests can't collide with a hex-leading domain name.
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true // loopback / unspecified
    if (h.startsWith("fc") || h.startsWith("fd")) return true // unique-local fc00::/7
    if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb"))
      return true // link-local fe80::/10
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) → re-check the embedded v4.
    const mapped = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (mapped) return isInternalHost(mapped[1]!)
    return false
  }

  // IPv4 dotted-quad literal.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 127 || a === 10 || a === 0) return true // loopback / private / "this host"
    if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a >= 224) return true // multicast / reserved
    return false
  }

  return false
}

/** True when a path/URL ends in an archive extension we know how to extract. */
export function isArchive(url: string): boolean {
  const u = url.split("?")[0]!.toLowerCase()
  return u.endsWith(".tar.gz") || u.endsWith(".tgz") || u.endsWith(".zip")
}

/**
 * Whether a source yields an archive (vs a raw binary). Honors an explicit
 * `archive` override; otherwise infers from the URL / asset filename.
 */
export function sourceIsArchive(source: BinarySource): boolean {
  if (typeof source.archive === "boolean") return source.archive
  return isArchive(source.kind === "url" ? source.url : source.asset)
}

/** Human-readable description of a source, for logs + the manifest record. */
export function sourceLabel(source: BinarySource): string {
  return source.kind === "url" ? source.url : `${source.repo}@${source.tag}/${source.asset}`
}

/** sha256 hex of a file's bytes. */
export function sha256File(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")
}

/** Recursively find a file named `member` under `root`. Returns abs path or null. */
export function findMember(root: string, member: string): string | null {
  let result: string | null = null
  const walk = (dir: string): void => {
    if (result) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      if (result) return
      const p = join(dir, n)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else if (n === member) result = p
    }
  }
  walk(root)
  return result
}

/** Default archive extractor: spawn `tar` for tar.gz/tgz, `unzip` for zip. */
async function defaultExtract(archivePath: string, destDir: string): Promise<void> {
  const lower = archivePath.toLowerCase()
  const argv = lower.endsWith(".zip")
    ? ["unzip", "-o", "-q", archivePath, "-d", destDir]
    : ["tar", "-xzf", archivePath, "-C", destDir]
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`${argv[0]} exited ${code}: ${stderr.trim().slice(0, 200)}`)
  }
}

function fail(
  kind: Extract<InstallOutcome, { ok: false }>["kind"],
  detail: string,
): InstallOutcome {
  return { ok: false, kind, detail }
}
