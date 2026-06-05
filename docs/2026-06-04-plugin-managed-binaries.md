# Plugin-managed binaries: how the agent provisions and resolves external tools

Status: written 2026-06-04, after fixing the ma-fetch "Fetch fails on a fresh
session" regression. Audience: anyone touching the `binaries/` subsystem, the
plugin loader, or a plugin that shells out to a native binary (today: ma-fetch's
obscura, ma-chrome-cdp).

## TL;DR

- The **agent** owns `~/.minimal-agent/bin/` and everything in it. It downloads,
  verifies, installs, and records external binaries. Plugins never touch the
  filesystem to install or locate a binary.
- A **plugin** does two things and only two things around binaries:
  1. At setup, it DECLARES what it needs as data (`requireBinaries`), with a
     pinned url/sha256/version. The host installs it.
  2. At call time, it RESOLVES the installed binary by reading the directory the
     host advertises in `MINIMAL_AGENT_BIN_DIR`, joining `<binDir>/<name>`.
- There is **no PATH fallback**. A plugin must never run a binary it found on the
  user's `PATH`. If the managed binary can't be resolved, the tool fails closed
  with a generic "engine unavailable" error.

## The bug this fixed

A fresh session's `Fetch` failed with `exit code 1` on every URL while `curl`
worked fine. Root cause: the obscura backend resolved its binary as

```ts
const bin = process.env.MA_FETCH_BIN?.trim() || "obscura"   // <- bare PATH name
```

`MA_FETCH_BIN` was only ever set from an operator config override
(`plugins["ma-fetch"].obscura.bin`). The host installed obscura to
`~/.minimal-agent/bin/obscura` and recorded it in `.binaries.json`, but never
told the plugin where that directory was. So with no override set, the backend
fell through to a bare `obscura`, which is not on `PATH`, and Bun's spawn threw
`ENOENT` (exit 1). The user's instinct was right on both counts: the binary WAS
installed, and the plugin should never have been reaching for a user's copy.

Two separate defects:

1. **No resolver contract.** The host knew the install location; the plugin had
   no way to learn it short of hard-coding `~/.minimal-agent/bin`, which is wrong
   because the home dir differs per install and per machine. The agent is the
   single party that knows where it put things.
2. **A silent PATH fallback.** Even as a "graceful degrade" this is wrong: an
   `obscura` a user happens to have is not the build this plugin pins, and
   silently executing a user-controlled binary is a supply-chain hazard.

## The two halves of the contract

### 1. Declaration + install (boot, host-driven)

`binaries/store.ts:BinaryStore` owns `~/.minimal-agent/bin/` plus a sidecar
manifest `.binaries.json`. A plugin's `setup.ts` returns a `SetupResult` with
`requireBinaries: [{ name, version, source, sha256, archiveMember, ... }]`. The
source can be a plain url or a `github-release` (private repos supported via an
embedded read-only token, see `setup.ts`). At boot (`src/index.ts`,
`provisionSetups`) the host classifies each spec against the inventory and, if
missing/outdated, downloads → verifies sha256 → extracts → atomically installs →
records. All side effects live in the store. The plugin only ever returned data.

This half already worked. The binary (and its `obscura-worker` sibling) landed
in `~/.minimal-agent/bin/` exactly as designed.

### 2. Resolution (every call, plugin-driven, host-advertised location)

This is the half that was missing. The fix: the host advertises the managed bin
directory to every plugin, every session, through the same env-bridge mechanism
it already uses for `MINIMAL_AGENT_MODEL` / `_SESSION_ID` / `_PID` / `_VERSION`.

In `src/index.ts`, right where those are mirrored into `process.env`:

```ts
process.env.MINIMAL_AGENT_BIN_DIR = defaultBinDir()  // ~/.minimal-agent/bin
```

Set **unconditionally**, not gated behind the header / provisioning phase. A
scripted `--prompt` run skips provisioning, but a previously-installed binary
must still resolve. The loader already spreads `process.env` into every
dispatched handler's `ctx.env` and into any subprocess that handler spawns, so
this one assignment reaches both module handlers and backend subprocesses with no
per-dispatch wiring.

The plugin resolves it with a small pure function,
`lib/backend.ts:resolveBackendBin`, which is the policy in one place:

```
1. Operator override  plugins["ma-fetch"].<backend>.bin  -> used verbatim (wins)
2. Managed dir        <MINIMAL_AGENT_BIN_DIR>/<backend>   -> must exist on disk
3. Neither            -> null  (caller fails closed; NEVER a PATH lookup)
```

`buildBackendEnv` sets `MA_FETCH_BIN` only when this returns non-null; otherwise
it leaves the var UNSET so the backend's own guard fires. And `callBackend`
pre-checks the same resolver before spawning at all, returning
`binUnavailable: true` so the dispatcher never launches a binary-less backend.
The backend subprocess (`backends/obscura.ts`) keeps a belt-and-braces guard:
`MA_FETCH_BIN` is now required, and if it's missing the backend exits 2 with a
clear message instead of running `obscura` off `PATH`.

## Why an env var (and not, say, a host API the plugin imports)

Plugins live in a separate repo and are loaded as isolated modules / subprocesses.
They cannot `import` host code (`binaries/store.ts`) without coupling the plugin
to the agent's source tree, which the plugin contract deliberately forbids
(`lib/types.ts` is a hand-mirrored stub for exactly this reason). The env var is
the host/plugin boundary's lingua franca:

- It works for both module handlers (via `ctx.env`) and subprocess backends (via
  inherited `process.env`), with no extra plumbing.
- It is home-dir-agnostic. The host computes `defaultBinDir()` from the real
  `homedir()` at boot; the plugin never assumes a path shape.
- It is the same mechanism (`agentContextToEnv`) already proven for model id /
  session id, so there is one pattern to understand, not two.

Design-pattern framing (per the SOLID/DIP lens): the plugin depends on an
abstraction (the env var contract), not a concretion (a hard-coded home path or
a direct import of the store). The host is the single source of truth for "where
binaries live" and hands the plugin a resolved fact. `resolveBackendBin` is a
small Strategy/Resolver with three branches, fully pure and unit-tested, so the
"never PATH" invariant is enforced by tests, not by reviewer vigilance.

## Failure modes, made explicit

| Situation | What happens now |
|---|---|
| Binary installed, env advertised (normal) | `resolveBackendBin` -> `<binDir>/obscura`; spawns; works. |
| Operator override set | Override wins verbatim, even with no env / nonexistent managed copy. Local dev against `~/Projects/obscura` keeps working. |
| Env unset (e.g. old host, odd boot) | `resolveBackendBin` -> null; `callBackend` returns `binUnavailable`; handler shows generic "engine unavailable". No spawn. |
| Managed dir advertised but file missing | Same fail-closed path (existence is checked). |
| `MA_FETCH_BIN` somehow unset at the subprocess | Backend exits 2 with "MA_FETCH_BIN is required ... refusing to run a PATH fallback". |
| A user has `obscura` on `PATH` | Irrelevant. It is never consulted. |

The two engine-unavailable causes (backend SCRIPT missing vs. managed BINARY
unresolved) collapse to one model-facing message on purpose: the model must not
learn which render engine is or isn't installed (backend-agnostic contract, see
`lib/errors.ts`). Operators get the detail from logs + the plugin README.

## Files touched

Host (`minimal-agent`):
- `src/index.ts`: advertise `MINIMAL_AGENT_BIN_DIR = defaultBinDir()` next to
  the other `MINIMAL_AGENT_*` mirrors. Import `defaultBinDir` from
  `binaries/store.ts`.
- `src/binaries/store.test.ts`: pin `defaultBinDir()` shape (the advertised
  value) as the host/plugin contract.

Plugin (`minimal-agent-plugins/ma-fetch-plugin`):
- `lib/backend.ts`: new `resolveBackendBin` (the resolver), `binUnavailable`
  result field + pre-spawn check in `callBackend`, `buildBackendEnv` now sets
  `MA_FETCH_BIN` from the resolver.
- `backends/obscura.ts`: `MA_FETCH_BIN` required; refuse (exit 2) instead of a
  bare `obscura` fallback. Env-contract docstring updated.
- `handlers/fetch.ts`: map `binUnavailable` to the same generic
  `engine-unavailable` error as `scriptMissing`.
- `setup.ts`, `README.md`: document the resolution order and the no-PATH rule.
- `lib/backend.test.ts`, `backends/obscura.test.ts`, `handlers/fetch.test.ts`:
  tests for the resolver, the fail-closed dispatcher path, and the subprocess
  guard (spawns the backend with no `MA_FETCH_BIN` and asserts exit 2).

## Lessons for the next binary-backed plugin

1. **Declare at setup, resolve from `MINIMAL_AGENT_BIN_DIR` at call time.** Never
   hard-code a home path; never scan the filesystem; never fall back to `PATH`.
2. **Resolve `<MINIMAL_AGENT_BIN_DIR>/<name>` and require existence.** Treat a
   missing file as fail-closed, not "try something else".
3. **Keep an operator override** (absolute path) that wins, for local dev against
   a working copy.
4. **Put the resolution policy in one pure function** and unit-test the "never
   PATH" invariant directly. The dispatcher should pre-check it and refuse to
   spawn, so a binary-less call is a clean typed result, not a deep ENOENT.
