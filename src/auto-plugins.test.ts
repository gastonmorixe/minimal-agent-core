/**
 * Tests for the first-run plugin bootstrap.
 *
 * The git runner and PATH probe are injected so the decision logic is
 * exercised without touching the network. A separate Docker smoke test
 * (docs/changes) covers the real `git clone` path end-to-end.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  bootstrapUserPlugins,
  buildCloneArgs,
  countPluginPackages,
  type GitRunResult,
  type PluginsSyncOptions,
  resolveGithubToken,
} from "./auto-plugins.ts"

let ROOT: string

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "ma-plugins-sync-"))
})
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** Write a fake plugin package (a dir with a manifest.json) under `dir`. */
function writePkg(dir: string, name: string): void {
  const pkg = join(dir, name)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, "manifest.json"), JSON.stringify({ id: name, version: "1.0.0" }))
}

const okGit = (): Promise<GitRunResult> => Promise.resolve({ code: 0, stdout: "", stderr: "" })

describe("countPluginPackages", () => {
  it("counts only dirs with a manifest.json, ignoring dotfiles + loose files", () => {
    const dir = join(ROOT, "plugins")
    mkdirSync(dir, { recursive: true })
    writePkg(dir, "alpha")
    writePkg(dir, "beta")
    mkdirSync(join(dir, "no-manifest"), { recursive: true })
    writeFileSync(join(dir, "README.md"), "hi")
    mkdirSync(join(dir, ".git"), { recursive: true })
    expect(countPluginPackages(dir)).toBe(2)
  })

  it("returns 0 for a missing directory", () => {
    expect(countPluginPackages(join(ROOT, "nope"))).toBe(0)
  })
})

describe("buildCloneArgs", () => {
  const URL = "https://github.com/gastonmorixe/minimal-agent-plugins.git"

  it("returns a plain shallow clone when there is no token", () => {
    expect(buildCloneArgs(URL, "/dest", false)).toEqual([
      "clone",
      "--depth",
      "1",
      "--",
      URL,
      "/dest",
    ])
  })

  it("prepends an inline credential helper for https github + token", () => {
    const args = buildCloneArgs(URL, "/dest", true)
    expect(args[0]).toBe("-c")
    expect(args[1]).toContain("credential.helper=")
    // The token VALUE is never in argv — only the env var reference.
    expect(args[1]).toContain("$MA_GIT_TOKEN")
    expect(args.join(" ")).not.toContain("ghp_")
    expect(args.slice(2)).toEqual(["clone", "--depth", "1", "--", URL, "/dest"])
  })

  it("does NOT inject a helper for non-github or ssh URLs even with a token", () => {
    expect(buildCloneArgs("git@github.com:o/r.git", "/d", true)[0]).toBe("clone")
    expect(buildCloneArgs("https://gitlab.com/o/r.git", "/d", true)[0]).toBe("clone")
    expect(buildCloneArgs("/local/mirror.git", "/d", true)[0]).toBe("clone")
  })

  it("guards against git-clone arg-injection with a `--` separator (B-153)", () => {
    // A repoUrl that looks like a git option must be forced to a positional by
    // the `--` end-of-options marker, never parsed by git as `--upload-pack=…`
    // (a command-execution vector on first-run plugin bootstrap).
    const evil = "--upload-pack=touch /tmp/pwned"
    const args = buildCloneArgs(evil, "/dest", false)
    const sep = args.indexOf("--")
    expect(sep).toBeGreaterThan(-1)
    // The hostile value sits AFTER `--`, so git treats it as the (bogus) URL.
    expect(args.indexOf(evil)).toBeGreaterThan(sep)
    // And `--` precedes both positionals (repoUrl, dest).
    expect(args.slice(sep + 1)).toEqual([evil, "/dest"])
  })
})

describe("resolveGithubToken", () => {
  it("prefers MINIMAL_AGENT_GITHUB_TOKEN, then GITHUB_TOKEN, then GH_TOKEN", async () => {
    expect(
      await resolveGithubToken(
        { MINIMAL_AGENT_GITHUB_TOKEN: "a", GITHUB_TOKEN: "b", GH_TOKEN: "c" },
        false,
      ),
    ).toBe("a")
    expect(await resolveGithubToken({ GITHUB_TOKEN: "b", GH_TOKEN: "c" }, false)).toBe("b")
    expect(await resolveGithubToken({ GH_TOKEN: "c" }, false)).toBe("c")
  })

  it("returns null when no env token and gh fallback is disabled", async () => {
    expect(await resolveGithubToken({}, false)).toBeNull()
  })

  it("ignores empty / whitespace-only env tokens", async () => {
    expect(await resolveGithubToken({ GITHUB_TOKEN: "   " }, false)).toBeNull()
  })
})

describe("bootstrapUserPlugins", () => {
  // Default `token: null` keeps the argv shape deterministic across hosts
  // (a real GITHUB_TOKEN / `gh` in the environment would otherwise inject the
  // credential helper and shift positional indices). Token-specific tests
  // override it explicitly.
  const base = (over: Partial<PluginsSyncOptions> = {}): PluginsSyncOptions => ({
    targetDir: join(ROOT, "plugins"),
    hasGit: () => true,
    git: okGit,
    token: null,
    ...over,
  })

  it("short-circuits to `disabled` when enabled:false, before any git", async () => {
    let called = false
    const res = await bootstrapUserPlugins(
      base({
        enabled: false,
        git: () => {
          called = true
          return okGit()
        },
      }),
    )
    expect(res.status).toBe("disabled")
    expect(called).toBe(false)
  })

  it("returns `present` and does NOT clone when the target already has plugins", async () => {
    const target = join(ROOT, "plugins")
    writePkg(target, "already-here")
    let called = false
    const res = await bootstrapUserPlugins(
      base({
        targetDir: target,
        git: () => {
          called = true
          return okGit()
        },
      }),
    )
    expect(res.status).toBe("present")
    expect(res.pluginCount).toBe(1)
    expect(called).toBe(false)
  })

  it("returns `skipped` when git is not on PATH", async () => {
    const res = await bootstrapUserPlugins(base({ hasGit: () => false }))
    expect(res.status).toBe("skipped")
    expect(res.detail).toContain("git")
  })

  it("clones into the target when empty + git available", async () => {
    const target = join(ROOT, "plugins")
    // Fake git: materialize two plugin packages at the clone destination.
    // `token: null` forces the public path so the host's real GITHUB_TOKEN /
    // `gh` doesn't bleed into the argv shape under test.
    const git = (args: string[]): Promise<GitRunResult> => {
      expect(args[0]).toBe("clone")
      const dest = args[args.length - 1]!
      writePkg(dest, "ma-fetch-plugin")
      writePkg(dest, "ma-skills-plugin")
      return Promise.resolve({ code: 0, stdout: "", stderr: "" })
    }
    const res = await bootstrapUserPlugins(base({ targetDir: target, git }))
    expect(res.status).toBe("cloned")
    expect(res.pluginCount).toBe(2)
    expect(existsSync(join(target, "ma-fetch-plugin", "manifest.json"))).toBe(true)
  })

  it("returns `failed` with a compact reason when the clone errors", async () => {
    const git = (): Promise<GitRunResult> =>
      Promise.resolve({
        code: 128,
        stdout: "",
        stderr:
          "Cloning into '/x'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
      })
    const res = await bootstrapUserPlugins(base({ git }))
    expect(res.status).toBe("failed")
    // The "Cloning into" noise line is stripped; the fatal: prefix removed.
    expect(res.detail).toContain("could not read Username")
    // Nothing left behind at the target.
    expect(countPluginPackages(join(ROOT, "plugins"))).toBe(0)
  })

  it("does not leave the temp clone dir behind on failure", async () => {
    const git = (): Promise<GitRunResult> =>
      Promise.resolve({ code: 1, stdout: "", stderr: "fatal: boom\n" })
    await bootstrapUserPlugins(base({ git }))
    const { readdirSync } = await import("node:fs")
    const leftovers = readdirSync(ROOT).filter((e) => e.includes(".plugins.sync."))
    expect(leftovers).toEqual([])
  })

  it("threads a token via env + credential helper, never in argv", async () => {
    let seenArgs: string[] = []
    let seenEnv: Record<string, string> | undefined
    const git = (
      args: string[],
      _cwd?: string,
      env?: Record<string, string>,
    ): Promise<GitRunResult> => {
      seenArgs = args
      seenEnv = env
      writePkg(args[args.length - 1]!, "ma-fetch-plugin")
      return Promise.resolve({ code: 0, stdout: "", stderr: "" })
    }
    const res = await bootstrapUserPlugins(base({ git, token: "ghp_SECRET123" }))
    expect(res.status).toBe("cloned")
    // Helper present, token only in env, not in argv.
    expect(seenArgs[0]).toBe("-c")
    expect(seenArgs.join(" ")).not.toContain("ghp_SECRET123")
    expect(seenEnv?.MA_GIT_TOKEN).toBe("ghp_SECRET123")
  })

  it("token:null forces the public path (no credential helper)", async () => {
    let seenArgs: string[] = []
    let seenEnv: Record<string, string> | undefined
    const git = (
      args: string[],
      _cwd?: string,
      env?: Record<string, string>,
    ): Promise<GitRunResult> => {
      seenArgs = args
      seenEnv = env
      writePkg(args[args.length - 1]!, "ma-fetch-plugin")
      return Promise.resolve({ code: 0, stdout: "", stderr: "" })
    }
    await bootstrapUserPlugins(base({ git, token: null }))
    expect(seenArgs[0]).toBe("clone")
    expect(seenEnv).toBeUndefined()
  })

  it("scrubs the token out of a failure detail", async () => {
    const git = (): Promise<GitRunResult> =>
      Promise.resolve({
        code: 128,
        stdout: "",
        stderr:
          "fatal: Authentication failed for 'https://x-access-token:ghp_SECRET@github.com/o/r'\n",
      })
    const res = await bootstrapUserPlugins(base({ git, token: "ghp_SECRET" }))
    expect(res.status).toBe("failed")
    expect(res.detail).not.toContain("ghp_SECRET")
    expect(res.detail).toContain("<token>")
  })

  it("honors a custom repoUrl by passing it to git clone", async () => {
    let seenUrl = ""
    const git = (args: string[]): Promise<GitRunResult> => {
      // args: ["clone", "--depth", "1", "--", <url>, <dest>]. Read the URL
      // relative to the `--` separator so this stays correct as flags evolve.
      const sep = args.indexOf("--")
      seenUrl = args[sep + 1]!
      writePkg(args[args.length - 1]!, "ma-fetch-plugin")
      return Promise.resolve({ code: 0, stdout: "", stderr: "" })
    }
    await bootstrapUserPlugins(base({ git, repoUrl: "file:///tmp/local-mirror.git" }))
    expect(seenUrl).toBe("file:///tmp/local-mirror.git")
  })
})
