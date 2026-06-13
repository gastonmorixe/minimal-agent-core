/**
 * First-run plugin bootstrap.
 *
 * minimal-agent ships a set of embedded built-in plugins inside its own
 * checkout (`<repo>/plugins/`). A second, larger set of "extended first-party"
 * plugins (Fetch, Skill, slash-menu, agent-writing-style, …) lives in a
 * SEPARATE repo, `gastonmorixe/minimal-agent-plugins`, so the core stays tiny
 * and those surfaces can evolve independently.
 *
 * On a freshly-installed box (think `bunx github:gastonmorixe/minimal-agent`)
 * that second repo isn't present. This module clones it ONCE into
 * `~/.minimal-agent/plugins`, which the loader scans as the `user` root (see
 * `PluginLoaderOptions.userDir`). After that first clone the directory is left
 * alone — we never auto-pull, so a user who hand-edits or pins a plugin keeps
 * control. Updating is an explicit `git -C ~/.minimal-agent/plugins pull`.
 *
 * Design mirrors `ui/formatter/auto.ts`:
 *   - self-contained (no agent.ts import),
 *   - best-effort (every failure path degrades to "no extra plugins", never
 *     throws into the boot path),
 *   - injectable git runner + filesystem probes so the decision logic is
 *     unit-testable without touching the network or disk.
 *
 * **Resolution order**:
 *   1. disabled (env / config / `enabled:false`)        → status `disabled`
 *   2. target already has ≥1 plugin package             → status `present`
 *   3. `git` missing on PATH                             → status `skipped`
 *   4. clone the repo into a temp sibling, then rename   → status `cloned`
 *      - any clone/rename failure                        → status `failed`
 *
 * @module auto-plugins
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

import { ansiStyle as A } from "@minimal-agent/plugin-api/utils/ansi"

import { startStartupProgressSpinner } from "./ui/startup/progress-spinner.ts"

/** Default remote for the extended first-party plugins. */
export const DEFAULT_PLUGINS_REPO = "https://github.com/gastonmorixe/minimal-agent-plugins.git"

/**
 * Resolve a GitHub token for cloning a PRIVATE repo, or `null` for the public
 * path. Checked in order; the first non-empty wins:
 *
 *   1. `MINIMAL_AGENT_GITHUB_TOKEN`  (explicit, agent-specific)
 *   2. `GITHUB_TOKEN`                (the de-facto standard, CI + gh)
 *   3. `GH_TOKEN`                    (gh CLI's alternate)
 *   4. `gh auth token`              (best-effort shell-out; only runs on the
 *                                    first boot, when the plugins dir is empty)
 *
 * The `gh` fallback is gated behind `tryGhCli` so callers (and tests) can keep
 * it off. It is intentionally last: env tokens are instant, the subprocess is
 * not. Returns a trimmed token or `null`.
 */
export async function resolveGithubToken(
  env: Record<string, string | undefined> = process.env,
  tryGhCli = true,
): Promise<string | null> {
  const fromEnv =
    env.MINIMAL_AGENT_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
  if (fromEnv) return fromEnv
  if (!tryGhCli) return null
  if (!Bun.which("gh")) return null
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" })
    const out = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    if (proc.exitCode === 0 && out.length > 0) return out
  } catch {
    // best-effort
  }
  return null
}

/**
 * Build the `git` argv that injects a token via an INLINE credential helper
 * rather than embedding it in the clone URL. Two properties matter:
 *
 *   - The token value never appears in argv: the helper script references
 *     `$MA_GIT_TOKEN`, which git's `/bin/sh` expands from the environment at
 *     run time (we pass it via the spawn env). `ps`/argv stays clean.
 *   - The cloned repo's `.git/config` keeps the bare `https://github.com/...`
 *     remote URL (no token), so a later `git -C … pull` doesn't ship a stale
 *     token and nothing secret is persisted to disk.
 *
 * For a non-GitHub or non-https URL (ssh, local path, custom mirror) we return
 * the args unchanged and let git's own auth (ssh-agent, credential store) run.
 */
export function buildCloneArgs(repoUrl: string, dest: string, hasToken: boolean): string[] {
  // The `--` end-of-options separator (B-153) makes git treat repoUrl + dest as
  // positionals even if repoUrl starts with `-`. Without it a pluginsRepo of
  // `--upload-pack=<cmd>` (from MINIMAL_AGENT_PLUGINS_REPO env / config) is
  // parsed by git as an OPTION, not a URL -> command execution on first-run
  // plugin bootstrap (classic git-clone arg-injection). Env/home-dir-trusted so
  // it's defense-in-depth, but the guard is one token.
  const base = ["clone", "--depth", "1", "--", repoUrl, dest]
  const isHttpsGithub = /^https:\/\/[^/]*github\.com\//i.test(repoUrl)
  if (!hasToken || !isHttpsGithub) return base
  const helper =
    'credential.helper=!f() { echo username=x-access-token; echo "password=$MA_GIT_TOKEN"; }; f'
  return ["-c", helper, ...base]
}

/** Outcome category of a bootstrap attempt. */
export type PluginsSyncStatus =
  | "present" // target already populated; nothing to do
  | "cloned" // freshly cloned the repo
  | "disabled" // turned off via env / config
  | "skipped" // can't run (no git) — non-fatal, no extra plugins
  | "failed" // tried to clone and it errored (offline, private repo, …)

/** Result of {@link bootstrapUserPlugins}. */
export interface PluginsSyncResult {
  status: PluginsSyncStatus
  /** Absolute path of the plugins root we targeted. */
  dir: string
  /** Number of plugin packages (dirs with a manifest.json) present after the run. */
  pluginCount: number
  /** Human-readable one-liner for the startup row / logs. */
  label: string
  /** Operator-facing detail when status is `failed` / `skipped`. */
  detail?: string
}

/** Result of running a git subcommand. */
export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

/** Options for {@link bootstrapUserPlugins}. */
export interface PluginsSyncOptions {
  /** The plugins root to populate, e.g. `~/.minimal-agent/plugins`. */
  targetDir: string
  /** Git remote (or local path / file:// URL) to clone. Defaults to {@link DEFAULT_PLUGINS_REPO}. */
  repoUrl?: string
  /**
   * Master switch. `false` short-circuits to `disabled` before any I/O.
   * Wired from `MINIMAL_AGENT_NO_PLUGIN_SYNC` / config `pluginSync`.
   */
  enabled?: boolean
  /** Render the breathing-dot spinner on stderr while cloning. */
  showSpinner?: boolean
  /**
   * Injectable git runner (tests). Defaults to a real `git` subprocess via
   * Bun.spawn. Receives argv (without the leading `git`), an optional cwd, and
   * an optional env overlay (used to pass `MA_GIT_TOKEN` to the inline
   * credential helper without putting the token in argv).
   */
  git?: (args: string[], cwd?: string, env?: Record<string, string>) => Promise<GitRunResult>
  /** Injectable PATH probe (tests). Defaults to `Bun.which("git") != null`. */
  hasGit?: () => boolean
  /**
   * GitHub token for a PRIVATE plugins repo. When omitted, the bootstrap
   * resolves one itself via {@link resolveGithubToken} (env vars, then a
   * best-effort `gh auth token`). Pass `null` explicitly to force the public
   * path (skip token resolution entirely). Tests pass a literal string.
   */
  token?: string | null
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Count immediate child directories that contain a `manifest.json`. This is
 * the same shape the loader's `discoverPackageDirs` keys on, so the count
 * reflects how many plugins the loader will actually pick up.
 */
export function countPluginPackages(dir: string): number {
  let n = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const full = join(dir, entry)
    try {
      if (!statSync(full).isDirectory()) continue
      if (existsSync(join(full, "manifest.json"))) n++
    } catch {
      // racing unlink / permission — skip
    }
  }
  return n
}

// ---------------------------------------------------------------------------
// Default git runner
// ---------------------------------------------------------------------------

async function defaultGit(
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<GitRunResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Never let git block the boot path waiting for credentials on a private
    // repo. With this set, a clone that needs auth fails fast instead of
    // hanging on a username prompt. The optional `env` overlay carries
    // MA_GIT_TOKEN for the inline credential helper (see buildCloneArgs).
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { code: proc.exitCode ?? 1, stdout, stderr }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensure `~/.minimal-agent/plugins` is populated, cloning the extended
 * first-party plugins repo on first run. Best-effort: never throws; every
 * failure mode resolves to a {@link PluginsSyncResult} the caller can render
 * or ignore.
 */
export async function bootstrapUserPlugins(opts: PluginsSyncOptions): Promise<PluginsSyncResult> {
  const { targetDir } = opts
  const repoUrl = opts.repoUrl?.trim() || DEFAULT_PLUGINS_REPO
  const git = opts.git ?? defaultGit
  const hasGit = opts.hasGit ?? (() => Bun.which("git") != null)

  // 1. Disabled.
  if (opts.enabled === false) {
    return {
      status: "disabled",
      dir: targetDir,
      pluginCount: countPluginPackages(targetDir),
      label: "sync off",
    }
  }

  // 2. Already populated — leave it alone (no auto-pull).
  const existing = countPluginPackages(targetDir)
  if (existing > 0) {
    return {
      status: "present",
      dir: targetDir,
      pluginCount: existing,
      label: `${existing} plugin${existing === 1 ? "" : "s"}`,
    }
  }

  // 3. No git → can't fetch. Non-fatal.
  if (!hasGit()) {
    return {
      status: "skipped",
      dir: targetDir,
      pluginCount: 0,
      label: "git not found",
      detail:
        "git is not on PATH, so the extended plugins repo could not be fetched. " +
        "Install git and restart, or clone it yourself: " +
        `git clone ${repoUrl} ${targetDir}`,
    }
  }

  // 4. Resolve a token for the PRIVATE repo. `opts.token` (incl. explicit
  // `null` to force the public path) wins; otherwise probe env + `gh`.
  const token = opts.token !== undefined ? opts.token : await resolveGithubToken(process.env, true)

  // 5. Clone into a temp sibling, then atomically swap into place.
  const spinner = startStartupProgressSpinner(
    `${A.dim("fetching")}  ${A.bold("minimal-agent-plugins")}${token ? A.dim("  (auth)") : ""}`,
    { enabled: opts.showSpinner ?? false },
  )

  const parent = dirname(targetDir)
  try {
    mkdirSync(parent, { recursive: true })
  } catch {
    // If we can't even make ~/.minimal-agent, bail cleanly.
    spinner.fail(`${A.bold("plugins")} ${A.dim("unavailable")}`)
    return {
      status: "failed",
      dir: targetDir,
      pluginCount: 0,
      label: "unwritable",
      detail: `could not create ${parent}`,
    }
  }

  const tmp = join(parent, `.plugins.sync.${process.pid}.${Date.now()}`)
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    // best-effort
  }

  // Inject the token via an inline credential helper (never in argv/URL) so
  // it stays out of `ps` output and the cloned `.git/config`. The helper
  // reads `MA_GIT_TOKEN` from the spawn env overlay.
  const cloneArgs = buildCloneArgs(repoUrl, tmp, token != null)
  const cloneEnv = token != null ? { MA_GIT_TOKEN: token } : undefined
  const res = await git(cloneArgs, undefined, cloneEnv)
  if (res.code !== 0) {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      // best-effort
    }
    const reason = scrubToken(firstMeaningfulLine(res.stderr), token) || `git exited ${res.code}`
    spinner.fail(`${A.bold("plugins")} ${A.dim("not fetched")}  ${A.dim(`(${reason})`)}`)
    const authHint = token
      ? "The token was rejected or lacks access; check it grants read on the repo."
      : "The repo is private: set MINIMAL_AGENT_GITHUB_TOKEN (or GITHUB_TOKEN), or run `gh auth login`."
    return {
      status: "failed",
      dir: targetDir,
      pluginCount: 0,
      label: "fetch failed",
      detail: `could not clone ${repoUrl} (${reason}). ${authHint}`,
    }
  }

  // Clone succeeded. Move it into place. If targetDir exists but empty (a
  // stray mkdir), remove it first so rename(2) doesn't hit ENOTEMPTY.
  try {
    if (existsSync(targetDir)) {
      // Only safe to clobber if it has no plugin packages (checked above).
      rmSync(targetDir, { recursive: true, force: true })
    }
    renameSync(tmp, targetDir)
  } catch (err) {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      // best-effort
    }
    spinner.fail(`${A.bold("plugins")} ${A.dim("install failed")}`)
    return {
      status: "failed",
      dir: targetDir,
      pluginCount: 0,
      label: "install failed",
      detail: `cloned but could not move into ${targetDir}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const count = countPluginPackages(targetDir)
  spinner.done(
    `${A.bold("minimal-agent-plugins")}  ${A.dim("cloned")}  ${A.faintWhite("→")}  ${A.sky(`${count} plugin${count === 1 ? "" : "s"}`)}`,
  )
  return {
    status: "cloned",
    dir: targetDir,
    pluginCount: count,
    label: `${count} plugin${count === 1 ? "" : "s"} ${A.dim("(cloned)")}`,
  }
}

/**
 * Redact a token from a string before it reaches a log / startup row. Defends
 * against the unlikely case where git echoes a credential-bearing URL in an
 * error. No-op when `token` is null/empty.
 */
function scrubToken(s: string, token: string | null): string {
  if (!token) return s
  return s.split(token).join("<token>")
}

/** First non-empty, non-noise line of git's stderr, for a compact label. */
function firstMeaningfulLine(stderr: string): string {
  for (const raw of stderr.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (/^Cloning into/i.test(line)) continue
    // Trim the leading "fatal: " / "error: " prefix for brevity.
    return line.replace(/^(fatal|error):\s*/i, "")
  }
  return ""
}
