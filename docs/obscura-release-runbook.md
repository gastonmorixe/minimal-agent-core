# Releasing a new obscura build into the Fetch plugin

This is the checklist for cutting a new obscura version and wiring it into the
`ma-fetch` plugin so the agent provisions it. Read the background in
[`docs/changes/2026-06-04-feat-plugin-binary-provisioning.md`](changes/2026-06-04-feat-plugin-binary-provisioning.md)
first if you have not seen the design.

## The shape of a release

- obscura source is private (`gastonmorixe/obscura`, branch `gm/private`).
- Compiled, stealth-built binaries live in the private `gastonmorixe/obscura-dist`
  repo as GitHub Releases.
- Each release tag is `build-<epoch>` (immutable) plus a rolling `latest`.
- Each asset is `obscura-<target>-<epoch>.tar.gz` and holds `obscura` plus
  `obscura-worker`. A sidecar `<asset>.sha256` and a `manifest-<epoch>.json`
  ship with it.
- The `ma-fetch` plugin pins, per platform, the `tag`, `asset`, `sha256`, and a
  `version` token (the epoch). The agent fetches the asset with the embedded
  read-only token, verifies the sha256, and installs into `~/.minimal-agent/bin/`.

The epoch in the filename is the version. A newer epoch sorts above an older one,
so an installed older copy is classified `outdated` and the agent updates it. The
host never runs the binary to learn its version.

## Path A: let CI build and publish (recommended)

1. Land your changes on `gm/private` in the obscura repo and push.
2. The `dist-release.yml` workflow builds `--features stealth` for macOS arm64
   and x64 and Linux arm64 and x64, packages each target, and publishes to
   `obscura-dist` under `build-<epoch>` and `latest`.
   - One-time prerequisite: add the `DIST_REPO_TOKEN` secret (a fine-grained PAT
     with `contents: write` on `obscura-dist`) to the obscura repo. Without it
     the build runs but the publish step fails.
3. Wire the new build into the plugin with the companion script (run from the
   plugins repo):

   ```bash
   bun ma-fetch-plugin/scripts/sync-obscura-release.ts latest
   # or pin an exact build:
   bun ma-fetch-plugin/scripts/sync-obscura-release.ts build-1780598942
   ```

   The script reads the release assets through the GitHub API (using your `gh`
   token), records each target's real sha256, and rewrites the
   `OBSCURA_VERSION`, `OBSCURA_TAG`, and `OBSCURA_BUILDS` block in
   `ma-fetch-plugin/setup.ts`. It never touches the embedded token file.

4. Sanity-check and commit the plugin:

   ```bash
   cd ma-fetch-plugin && bun test setup.test.ts
   git add setup.ts && git commit -m "chore(ma-fetch): bump obscura to build-<epoch>" && git push
   ```

## Path B: build a target by hand (no CI host for that arch)

This is what we did for linux arm64 on the rpi5. Use it when CI cannot build a
target and you have a machine of that arch.

1. On the target machine, clone obscura and build:

   ```bash
   gh repo clone gastonmorixe/obscura -- --branch gm/private --depth 1
   cd obscura && cargo build --release --features stealth
   ```

2. Smoke-test the binary before publishing:

   ```bash
   ./target/release/obscura --version
   ./target/release/obscura fetch --dump markdown --wait-until domcontentloaded \
     --timeout 30 --stealth --quiet https://example.com | head
   ```

3. Package and upload to the existing `build-<epoch>` release (reuse the epoch
   that CI or another target already used, so one release holds every arch):

   ```bash
   EPOCH=1780598942
   ASSET=obscura-aarch64-linux-${EPOCH}.tar.gz   # name for this target
   cd target/release && tar czf "/tmp/${ASSET}" obscura obscura-worker && cd -
   sha256sum "/tmp/${ASSET}"
   gh release upload "build-${EPOCH}" "/tmp/${ASSET}" --repo gastonmorixe/obscura-dist --clobber
   ```

4. Wire it into the plugin with the companion script (Path A, step 3), then test
   and commit.

## Rotating the embedded token

The plugin ships a fine-grained PAT in `ma-fetch-plugin/obscura-token.ts`
(`Contents: read-only`, scoped to `obscura-dist` only). To rotate it:

1. Create a new PAT at <https://github.com/settings/personal-access-tokens/new>
   (resource owner `gastonmorixe`, only the `obscura-dist` repo, Contents
   read-only).
2. Replace the value in `ma-fetch-plugin/obscura-token.ts`.
3. Revoke the old PAT in GitHub settings and cut a new plugin release.

A leak of this token grants nothing beyond pulling the already-distributed
binaries, but rotate it anyway if it ends up somewhere it should not.

## Verifying an account-less install

The whole point is that a machine with no GitHub login can still install obscura,
because the credential rides in the plugin. To prove it on a fresh box:

```bash
env -i PATH="$PATH" HOME="$HOME" bun -e '
  import setup from "./ma-fetch-plugin/setup.ts"
  import { BinaryStore, inventoryAdapter, provisionSetups } from "<minimal-agent>/src/binaries/index.ts"
  const store = new BinaryStore("/tmp/probe-bin", { tokenProvider: async () => null })
  const result = setup({ packageDir: "./ma-fetch-plugin", cwd: ".", env: {}, binaries: inventoryAdapter(store), log: { info(){}, notice(){} } })
  console.log(await provisionSetups(store, [{ pluginId: "ma-fetch", result }]))
'
```

`GITHUB_TOKEN` and `GH_TOKEN` are unset by `env -i`, so a successful install
proves the embedded token did the work.
