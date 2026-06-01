# First-run onboarding: `bunx`-able bin, plugin auto-clone, welcome card

> 2026-05-31. Makes minimal-agent runnable on a clean device with no manual
> install: a `bin` field so it works through `bunx`/`bun add -g`, a first-run
> bootstrap that clones the extended plugins into `~/.minimal-agent/plugins`,
> and a welcome card that frames the one-time auto-setup. Verified end-to-end in
> a clean `oven/bun:1.3-debian` container against the real (private) repos.

## What shipped

### 1. `bin` field → `bunx` / `bun add -g`

`package.json` gains `"bin": { "minimal-agent": "src/index.ts" }` plus
`description` / `homepage` / `repository` / `engines.bun`. Bun runs the
TypeScript entry directly (the file already has a `#!/usr/bin/env bun` shebang),
so there is still no build step.

Verified in Docker: `bun pm pack` → `bun add <tgz>` creates the
`node_modules/.bin/minimal-agent` shim, and `bunx minimal-agent …` runs it.
`bun add -g <tgz>` installs a global `minimal-agent`.

**Private-repo reality.** While `gastonmorixe/minimal-agent` is private, the
literal `bunx github:gastonmorixe/minimal-agent` 404s: Bun's `github:` shorthand
hits `api.github.com/.../tarball` anonymously and never sends a token (confirmed
with `GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_API_TOKEN` all set). Bun also rejects
`bunx <git-url>` outright ("unrecognised dependency format" — bunx runs npm
packages only). The working private path is `bun add -g` with a token in the git
URL (`git+https://x-access-token:<TOKEN>@github.com/…`), which authenticated
against the real private repo in a clean container. The `bin` field lights up
`bunx github:` the moment a public branch exists.

### 2. Plugin loader: a fourth root, `user`

`src/plugins/loader.ts` + `src/plugins/types.ts`. Discovery now walks four
roots; precedence on package-id collision is `project > home > user > embedded`.
The new `user` root is `~/.minimal-agent/plugins` (wired in `src/index.ts` as
`userDir`). It sits above the embedded built-ins but below the user's
hand-curated `~/.agents/plugins` and `<cwd>/.agents/plugins`, so a developer who
symlinks a working copy into either always shadows the auto-cloned one.

### 3. First-run plugin bootstrap (`src/auto-plugins.ts`)

Mirrors `auto-formatter.ts`: self-contained (inline ANSI + breathing-dot
spinner), best-effort (never throws into the boot path), injectable git runner +
PATH probe for tests.

Resolution order: `disabled` (env/config) → `present` (target already has
plugins; no auto-pull) → `skipped` (no `git`) → clone into a temp sibling, then
atomic `rename(2)` into place → `cloned` / `failed`.

Private-repo auth: `resolveGithubToken` checks `MINIMAL_AGENT_GITHUB_TOKEN` →
`GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`. `buildCloneArgs` injects the token
through an inline `credential.helper` that reads `$MA_GIT_TOKEN` from the spawn
env, so the token never appears in argv, the clone URL, or the cloned
`.git/config`. A `scrubToken` pass keeps it out of any error surfaced to logs.

Gating in `src/index.ts`: runs only when `SHOW_HEADER` is set (so a scripted
`--prompt`/stdin run never reaches out), opt-out via
`MINIMAL_AGENT_NO_PLUGIN_SYNC=1` / `pluginSync:false`, remote override via
`MINIMAL_AGENT_PLUGINS_REPO` / `pluginsRepo`. A `cloned` result prints a quiet
`plugins  + N plugins (cloned)` row; `failed`/`skipped` log a Notice to the file
log only. The loader then picks the new packages up on the SAME boot.

Config: `pluginSync?: boolean` and `pluginsRepo?: string` in `UserConfig`.

### 4. First-run welcome card (`src/first-run.ts`)

On a genuine cold start (no `~/.minimal-agent` yet) AND an interactive TTY, a
rounded card prints above the startup tree listing the one-time steps (sign in,
fetch mdstream, fetch plugins). Pure builder (`buildFirstRunCard`) + a
side-effect-free detector (`isColdStart`, probes the home dir, captured in
`index.ts` BEFORE the file-log sink creates the dir). Non-interactive runs stay
silent.

## Tests

- `src/auto-plugins.test.ts` (18): status machine, token precedence, credential
  helper shape (token never in argv), `token:null` public path, token scrubbing,
  custom repo URL, temp-dir cleanup on failure.
- `src/first-run.test.ts` (7): card rendering, cold-start detection, interactive
  vs non-interactive gating.
- `src/plugins/loader.test.ts`: updated precedence string to
  `project > home > user > embedded`.

## Docker verification (clean `oven/bun:1.3-debian`, non-root user)

- Baseline: `bun run src/index.ts --prompt` authenticates with a copied
  `auth.jsonc`, auto-downloads mdstream (linux/arm64), returns the prompt.
- `bin`: `pack` → `add` → `bunx minimal-agent` runs.
- Private plugin clone: first run with `MINIMAL_AGENT_GITHUB_TOKEN` clones the
  real private `minimal-agent-plugins` (4 packages), token absent from
  `.git/config`, `Fetch`/`Skill` load on the same boot.
- Welcome card: interactive PTY (`script -qec`) cold start shows card → tree →
  sign-in prompt, in order.

## Notes / follow-ups

- The npm name `minimal-agent` is already taken (an unrelated package). A public
  npm route would need a scoped name like `@gastonmorixe/minimal-agent`.
- Bun's `git+file://` / `git://` resolvers are flaky for local mirrors ("no
  commit matching" even with an explicit ref); irrelevant to the GitHub path but
  worth knowing if you wire a local-mirror test.
