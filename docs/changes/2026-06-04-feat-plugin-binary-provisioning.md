# feat: plugin setup lifecycle + managed binary provisioning + global audit log

> 2026-06-04. Plugins can now DECLARE the external binaries they need (hardcoded
> source + sha256 + version). The host installs and updates them into a managed
> `~/.minimal-agent/bin/`, with a startup-row progress spinner and a persistent
> syslog audit trail. First consumer: the `ma-fetch` plugin declares the
> `obscura` render engine, which fixes the "Fetch silently broken on a fresh
> box" gap.

## Why

On a clean machine the Fetch tool advertised itself but failed at first call.
obscura was never installed, never auto-provisioned, and the README told humans
to `curl` it by hand. There was no plugin lifecycle for "ensure a binary
exists", and no managed binary inventory the host owned. mdstream proved the
download pattern, but only for one hardcoded core binary.

## The private-binary problem (and the answer)

obscura's source is private (`gastonmorixe/obscura`, branch `gm/private`). The
compiled binaries must stay private too, yet still install on a fresh box for
someone who does NOT have their own GitHub access (a friend handed a copy of
minimal-agent). Those two goals reconcile exactly one way: ship the credential
WITH the plugin.

Findings, verified against the GitHub docs and community threads:

- No anonymous, hardcodeable URL exists for a private repo's release asset. The
  CDN URL it redirects to is AWS-signed and expires in minutes.
- S3, R2, and GCS presigned URLs are hard-capped at 7 days. There is no
  multi-year option.
- CloudFront can do multi-year signed URLs, but that needs a distribution plus
  an RSA signing key.
- ghcr.io can host private blobs, but fine-grained PATs cannot pull from it
  today. It wants a classic broad token plus an OCI token-exchange dance, which
  is more code and a broader credential.

The chosen model is a binary-source descriptor with an embedded read-only
token. The compiled binaries live in a private release repo
(`gastonmorixe/obscura-dist`). The plugin hardcodes the coordinates (`repo`,
`tag`, `asset`, `sha256`, and `version`, where the version is a build epoch) plus
a fine-grained PAT scoped to only that repo with `Contents: read-only`. The host
fetches the asset through the GitHub REST API in two steps (resolve the tag to an
asset id, then stream the asset with `Accept: application/octet-stream` and a
bearer token), verifies the sha256, and installs.

Because the token travels with the plugin, any copy can install obscura,
including an account-less user's. The credential is the plugin's, not the user's.
A leak of that token grants nothing beyond pulling the already-distributed
binaries (read-only, single repo). The real download URL is the short-lived
signed URL GitHub mints per request, and it is consumed immediately and never
stored. The hardcoded coordinates never expire.

Verified end-to-end against the live private repo: resolve, sha256, extract,
install `obscura` plus `obscura-worker`, status flips to `satisfied`, and the
installed binary runs (`obscura 0.1.0`).

## What shipped

### 1. Binary subsystem (`src/binaries/`)

- `types.ts`. `BinarySpec` carries name, version, `source`, and sha256, plus an
  optional archive member and extra siblings. `BinarySource` is a discriminated
  union: `{ kind: "url" }` for a public download, or
  `{ kind: "github-release", repo, tag, asset, token? }` for a private release
  fetched through the REST API with the embedded token (host-token fallback).
  Also `InstalledBinary`, `BinaryInventory`, `InstallOutcome`,
  `InstallProgress`, `RequirementStatus`.
- `version.ts`. Pure version compare. Accepts a bare epoch integer or a dotted
  numeric. An epoch sorts above any dotted release (migration order). An
  unparseable token yields `NaN`, so the host treats the installed copy as
  `unknown-version` and reinstalls.
- `store.ts`. `BinaryStore` over `~/.minimal-agent/bin/` plus a sidecar manifest
  (`.binaries.json`). `inventory()` and `status()` classify a spec. `install()`
  downloads (streamed, with progress), verifies the sha256 BEFORE writing
  anything, extracts (tar or zip), atomically installs (with sibling extras like
  `obscura-worker`), then records. It never executes a candidate to learn its
  version. Best-effort throughout: failures come back as data, never thrown.
- `provision.ts`. `inventoryAdapter()` projects a store as the plugin-facing
  inventory. `provisionSetups()` consumes plugin setup results, installs or
  updates what needs it (skipping satisfied binaries), and raises a
  `ProvisionHalt` when a mandatory binary cannot be provisioned.
- Tests: `version.test.ts`, `store.test.ts`, `provision.test.ts` cover install,
  sha-mismatch abort, outdated-to-update, archive member plus extras, download
  failure, invalid spec, the github-release token path, and halt logic.

### 2. Plugin `setup()` lifecycle (`src/plugins/`)

- `types.ts`. New `ManifestFile.setup` (a module handler), plus `SetupHandler`,
  `SetupContext` (which carries a read-only `binaries` inventory), `SetupResult`
  (`requireBinaries`, `haltIfMissing`, `haltMessage`), and the `SetupBinary*`
  mirror types so the plugin surface carries no dependency on `binaries/`.
- `manifest.ts`. Validates `setup` as a module-only handler entry.
- `loader.ts`. `runSetups(inventory)` imports each plugin's setup module (under
  the per-handler timeout), builds the context, and returns the structured
  results. A throwing setup is logged and skipped, so it never poisons boot.
- Tests: `loader.setup.test.ts`.

### 3. Boot wiring (`src/index.ts`)

After the plugin tools row, on header (interactive) runs only, the host runs
`loader.runSetups()` then `provisionSetups()` behind a `binaries` startup-row
spinner. The settled row reads, for example, `+obscura (1780598942)` on a fresh
install, `↑obscura (…)` on an update, a red `✗name` on failure, or `up to date`.
A `ProvisionHalt` stops boot with the plugin's actionable message, with
`MINIMAL_AGENT_NO_BINARY_SETUP=1` as an escape hatch. The whole phase is skipped
in non-interactive runs.

### 4. Persistent global audit log (`src/log-global.ts`)

`GlobalLogSink` appends to a single durable `~/.minimal-agent/ma.log` in RFC 5424
(the same formatter the per-session sink uses), at Notice and above by default,
with the session id stamped per line and size-based rotation to `ma.log.1`. It
attaches at boot next to the session `FileLogSink`, so every binary install,
update, removal, skip, and halt is audited across runs. Tests:
`log-global.test.ts`.

### 5. ma-fetch plugin (`minimal-agent-plugins/ma-fetch-plugin`)

- `setup.ts` declares obscura for the current platform as a `github-release`
  source on the private `gastonmorixe/obscura-dist` repo (`obscura` plus the
  `obscura-worker` sibling), mandatory via `haltIfMissing`. It skips
  provisioning when `plugins["ma-fetch"].obscura.bin` points at a local build,
  so dev against `~/Projects/obscura` keeps working. `manifest.json` wires
  `setup`.
- `obscura-token.ts` holds the embedded read-only credential, committed on
  purpose so it travels with every plugin copy (the account-less install). An
  empty string falls back to the user's own token.
- Tests: `setup.test.ts`. The full install was verified live against the private
  repo (resolve, sha256, extract, install obscura plus worker, run).
- The mac arm64 and linux arm64 sha256 values are real and pinned. The other
  targets carry empty shas until CI publishes them, and the sha check fails
  closed (it degrades to "configure a bin path" rather than install a wrong
  file).

### 6. obscura CI (`obscura` repo, branch `gm/private`)

- `.github/workflows/dist-release.yml` (new). On push to `gm/private` (plus
  manual dispatch) it builds `--features stealth` for macOS arm64 and x64 and
  Linux arm64 and x64, packages `obscura` plus `obscura-worker` as
  `obscura-<target>-<epoch>.tar.gz` with a sidecar `.sha256` and a
  `manifest-<epoch>.json`, then publishes to the private `obscura-dist` repo
  under a rolling `latest` tag and an immutable `build-<epoch>` tag. It needs a
  `DIST_REPO_TOKEN` secret (contents:write on the dist repo).
- `.github/workflows/release.yml` (fixed). It now builds `--features stealth` in
  one shot. The old workflow did a plain build plus a separate
  `continue-on-error` stealth build, which silently shipped the non-stealth
  binary even though the fetch backend always passes `--stealth`.

## Build and verification status (2026-06-04)

- mac arm64 (`aarch64-macos`). Built natively, published to the private
  `obscura-dist` release `build-1780598942`, sha `e61a821…`, install verified
  end-to-end on this host.
- linux arm64 (`aarch64-linux`). Built natively on the rpi5 (Ubuntu 24.04,
  `cargo --features stealth`, 11m52s), smoke-tested (stealth fetch of
  example.com, exit 0), published to the same release, sha `61f02acc…`. The
  account-less install was proven on the rpi5: in a clean env with `GITHUB_TOKEN`
  and `GH_TOKEN` unset, the real plugin `setup.ts` plus `BinaryStore` resolved
  and downloaded the asset with the embedded token alone, the sha matched, and
  the manifest never recorded the token. Both shas are pinned in
  `ma-fetch/setup.ts`.
- mac x64 and linux x64. Left to obscura CI (`dist-release.yml`), since there is
  no local host of those arches. Their `setup.ts` shas stay empty (fail-closed)
  until CI publishes them.

## Follow-ups

- Fill the remaining per-target sha256 values into `ma-fetch/setup.ts` once
  obscura CI publishes mac x64 and linux x64. CI's `manifest-<epoch>.json` lists
  them.
- Add the `DIST_REPO_TOKEN` secret (contents:write on `obscura-dist`) to the
  obscura repo so `dist-release.yml` can publish.
- The embedded PAT now lives in `ma-fetch/obscura-token.ts` and is in that repo's
  git history. To rotate it, replace the value in GitHub settings and cut a new
  plugin release.
- Optional future: a declarative parallel setup phase that installs independent
  binaries concurrently, once more plugins declare requirements.
