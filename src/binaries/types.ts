/**
 * Binary-provisioning types.
 *
 * The agent owns a managed binary directory (`~/.minimal-agent/bin/`) and a
 * sidecar manifest that records, per logical binary, the version + sha256 +
 * source URL that produced the installed file. Plugins NEVER install binaries
 * themselves and NEVER probe arbitrary paths: they DECLARE a {@link BinarySpec}
 * (a hardcoded url / sha256 / version), the host compares it against the
 * inventory, and the host performs any download.
 *
 * Security stance: the agent decides "is this binary present / current" by
 * READING the manifest + statting the file. It NEVER executes a candidate
 * binary to learn its version (e.g. no `obscura --version`). Version is a
 * property the host recorded at install time, so it is trustworthy without
 * running anything.
 *
 * @module binaries/types
 */

/**
 * Where a binary's bytes come from. A discriminated union so a public URL and a
 * token-gated private GitHub release are both first-class, and the install
 * pipeline (verify sha256 → extract → install) is identical after the fetch.
 */
export type BinarySource =
  | {
      kind: "url"
      /** Public, anonymous download URL (raw binary or archive). */
      url: string
      /** Override archive detection; inferred from the URL path when omitted. */
      archive?: boolean
    }
  | {
      kind: "github-release"
      /** `owner/repo` of the (possibly private) release host. */
      repo: string
      /** Release tag, e.g. `build-1780598942`. */
      tag: string
      /** Asset filename within the release, e.g. `obscura-aarch64-macos-...tar.gz`. */
      asset: string
      /**
       * Embedded read-only credential, baked into the plugin so the bytes are
       * fetchable by ANY copy (incl. an account-less friend's) WITHOUT the user
       * having their own GitHub access. Use a fine-grained PAT scoped to ONLY
       * this repo with `Contents: read-only`. A leak then grants nothing but
       * pulling these (already-distributed) binaries. When omitted, the host
       * falls back to its {@link BinaryStoreDeps.tokenProvider} (the user's own
       * token), which only helps on a machine where the user is logged in.
       *
       * NEVER logged and NEVER written to the manifest (only {@link sourceLabel}
       * — the `repo@tag/asset` string — is recorded).
       */
      token?: string
      /** Override archive detection; inferred from the asset name when omitted. */
      archive?: boolean
    }

/**
 * A plugin's hardcoded declaration of one required external binary.
 *
 * A plugin release pins these fields. On a fresh box the host fetches the
 * `source`, verifies it against `sha256`, and records `version`. On a later
 * plugin release that bumps `version` + `source` + `sha256`, the host sees the
 * installed copy is older and updates it. The plugin never touches the
 * filesystem and never holds a token.
 */
export interface BinarySpec {
  /**
   * Logical id, stable across versions (e.g. `"obscura"`). Determines the
   * installed filename under the managed bin dir and the manifest key. Must
   * match `^[a-z0-9][a-z0-9_-]*$`.
   */
  name: string
  /**
   * Monotonic, comparable version token. Two shapes are supported by
   * {@link compareVersions}: a bare integer (e.g. an epoch second count like
   * `"1733345678"`, the recommended CI naming) or a dotted numeric semver
   * (`"0.1.6"`). Higher = newer.
   */
  version: string
  /**
   * Where to fetch the bytes. Two shapes:
   *
   *   - `{ kind: "url", url }`: a public, anonymous download URL (raw binary
   *     or `.tar.gz` / `.tgz` / `.zip`). No credentials.
   *   - `{ kind: "github-release", repo, tag, asset }`: a release asset in a
   *     (possibly PRIVATE) GitHub repo, fetched via the REST API with a token
   *     the HOST supplies (never hardcoded in the plugin). This is the path
   *     that lets a private source repo ship binaries WITHOUT a public URL: the
   *     plugin pins `repo + tag + asset + sha256`, and the agent adds the
   *     user's token (the same chain used for the private plugin clone:
   *     `MINIMAL_AGENT_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then `GH_TOKEN`,
   *     then `gh auth token`).
   *     Strangers with no token can't download; the user and their team can.
   */
  source: BinarySource
  /**
   * Lowercase hex sha256 of the bytes the source yields (the archive bytes for
   * an archive). Verified BEFORE extraction; a mismatch aborts the install and
   * nothing is written.
   */
  sha256: string
  /**
   * For archive URLs: the member filename to extract as the binary. Defaults
   * to {@link name}. Ignored for a raw-binary URL.
   */
  archiveMember?: string
  /**
   * For archive URLs: additional sibling files to install alongside the main
   * binary (e.g. `obscura-worker` next to `obscura`). Each is found in the
   * extracted tree by basename and copied into the managed bin dir under that
   * same basename, chmod 0755. Recorded in the manifest as `extras`. A missing
   * extra member aborts the install (the binary would be broken without it).
   * Ignored for a raw-binary URL.
   */
  archiveExtraMembers?: string[]
}

/**
 * One installed binary as recorded in the managed manifest. The host writes
 * this at install time; nothing else may.
 */
export interface InstalledBinary {
  /** Logical id (matches {@link BinarySpec.name}). */
  name: string
  /** Absolute path to the installed file under the managed bin dir. */
  path: string
  /** Version recorded at install time. `null` for a foreign file with no record. */
  version: string | null
  /** sha256 the host verified at install time. `null` when unknown. */
  sha256: string | null
  /** ISO 8601 install timestamp. */
  installedAt: string
  /** Human-readable description of where the bytes came from (URL or `owner/repo@tag/asset`). `null` when unknown. */
  sourceUrl: string | null
  /** Basenames of extra sibling files installed alongside the main binary. */
  extras?: string[]
}

/**
 * The host-side inventory handed to a plugin's `setup()` via the shared
 * context. Read-only: a plugin inspects it to decide whether to request an
 * install / update, then returns that request as data.
 */
export interface BinaryInventory {
  /** Absolute path of the managed bin dir (`~/.minimal-agent/bin`). */
  readonly dir: string
  /** Every recorded + on-disk binary, keyed by logical name. */
  readonly entries: ReadonlyMap<string, InstalledBinary>
  /** Convenience: is `name` installed (recorded AND present on disk)? */
  has(name: string): boolean
  /** Convenience: the installed record for `name`, if any. */
  get(name: string): InstalledBinary | undefined
  /** Classify a spec against what's installed. See {@link RequirementStatus}. */
  status(spec: BinarySpec): RequirementStatus
}

/**
 * Result of comparing a {@link BinarySpec} against the inventory.
 *
 * - `"satisfied"`: an installed copy exists and its version is \>= the spec.
 * - `"missing"`: nothing installed (or the recorded file is gone from disk).
 * - `"outdated"`: an installed copy exists but its version is below the spec.
 * - `"unknown-version"`: a file is present but carries no comparable version
 *   record (a foreign install); the host treats it as needing (re)install.
 */
export type RequirementStatus = "satisfied" | "missing" | "outdated" | "unknown-version"

/**
 * What a plugin's `setup()` asks the host to do about ONE binary. Returned as
 * pure data; the host performs the side effects (download, TUI, logging).
 */
export interface BinaryRequest {
  /** The binary this request concerns. */
  spec: BinarySpec
  /**
   * Why the request was raised, derived from {@link RequirementStatus}. The
   * host uses it for the progress label and the log line.
   */
  reason: Extract<RequirementStatus, "missing" | "outdated" | "unknown-version">
}

/**
 * Outcome of a single install/update attempt, returned by the host store.
 * Always resolves (failures are encoded, never thrown into the boot path).
 */
export type InstallOutcome =
  | {
      ok: true
      /** The freshly written record. Carries the resolved path / version / sha. */
      installed: InstalledBinary
      /** `"installed"` for a first install, `"updated"` when replacing an older copy. */
      action: "installed" | "updated"
    }
  | {
      ok: false
      /** Stable failure kind for telemetry + log structured-data. */
      kind: "download-failed" | "sha-mismatch" | "extract-failed" | "write-failed" | "spec-invalid"
      /** Human-readable, secret-free detail. */
      detail: string
    }

/** Phase of an in-flight install, surfaced to the host's TUI progress hook. */
export interface InstallProgress {
  name: string
  version: string
  phase: "fetching" | "verifying" | "extracting" | "installing" | "done" | "failed"
  /** Completion fraction in `[0,1]` when known; `null` for indeterminate. */
  fraction: number | null
  /** Bytes downloaded so far, when the phase is `"fetching"`. */
  bytesDone?: number
  /** Total bytes, when the server reported Content-Length. */
  bytesTotal?: number
}
