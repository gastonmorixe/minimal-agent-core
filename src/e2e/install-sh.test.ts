/**
 * Tests for `scripts/install.sh`.
 *
 * The agent has no runtime npm deps. The installer clones (or reuses) source
 * and links `minimal-agent` onto PATH. It must never run `bun install`.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

const INSTALL = join(import.meta.dirname, "../../scripts/install.sh")
const REPO_ROOT = join(import.meta.dirname, "../..")

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI for assertions.
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

async function runInstall(
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["bash", INSTALL], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: env.HOME,
      PATH: env.PATH ?? process.env.PATH,
      SHELL: env.SHELL ?? "/bin/bash",
      MINIMAL_AGENT_HOME: env.MINIMAL_AGENT_HOME,
      MINIMAL_AGENT_BIN_DIR: env.MINIMAL_AGENT_BIN_DIR,
      MINIMAL_AGENT_SRC: env.MINIMAL_AGENT_SRC,
      MINIMAL_AGENT_REPO: env.MINIMAL_AGENT_REPO,
      MINIMAL_AGENT_INSTALL_NO_PATH: env.MINIMAL_AGENT_INSTALL_NO_PATH,
      MINIMAL_AGENT_FORCE_CLONE: env.MINIMAL_AGENT_FORCE_CLONE,
      MINIMAL_AGENT_GITHUB_TOKEN: env.MINIMAL_AGENT_GITHUB_TOKEN,
      GITHUB_TOKEN: env.GITHUB_TOKEN,
      GH_TOKEN: env.GH_TOKEN,
    },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  const code = (await p.exited) ?? 1
  return { code, stdout, stderr }
}

async function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env })
  const code = (await p.exited) ?? 1
  if (code !== 0) {
    const err = await new Response(p.stderr).text()
    throw new Error(`git ${args.join(" ")} failed: ${err}`)
  }
}

function gitIdentityEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "ma",
    GIT_AUTHOR_EMAIL: "ma@example.com",
    GIT_COMMITTER_NAME: "ma",
    GIT_COMMITTER_EMAIL: "ma@example.com",
  }
}

const WRAPPER_SRC = join(REPO_ROOT, "minimal-agent")

function writeWrapper(destDir: string): void {
  copyFileSync(WRAPPER_SRC, join(destDir, "minimal-agent"))
  chmodSync(join(destDir, "minimal-agent"), 0o755)
}

let scratch: string
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

describe("scripts/install.sh", () => {
  it("links a checkout onto PATH without bun install", async () => {
    scratch = mkdtempSync(join(tmpdir(), "ma-install-"))
    const home = join(scratch, "home")
    const agentHome = join(home, ".minimal-agent")
    const binDir = join(agentHome, "bin")
    mkdirSync(home, { recursive: true })

    const result = await runInstall({
      HOME: home,
      MINIMAL_AGENT_HOME: agentHome,
      MINIMAL_AGENT_BIN_DIR: binDir,
      MINIMAL_AGENT_SRC: REPO_ROOT,
      MINIMAL_AGENT_INSTALL_NO_PATH: "1",
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("no bun install ran")
    expect(existsSync(join(binDir, "minimal-agent"))).toBe(true)
    expect(existsSync(join(binDir, "ma"))).toBe(true)
    expect(readlinkSync(join(binDir, "minimal-agent"))).toBe(join(REPO_ROOT, "minimal-agent"))
    expect(readlinkSync(join(binDir, "ma"))).toBe(join(REPO_ROOT, "minimal-agent"))
    expect(existsSync(join(agentHome, "src"))).toBe(false)
  })

  it("links minimal-agent and ma into ~/.local/bin and writes a PATH line", async () => {
    scratch = mkdtempSync(join(tmpdir(), "ma-install-path-"))
    const home = join(scratch, "home")
    const agentHome = join(home, ".minimal-agent")
    const binDir = join(agentHome, "bin")
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, ".zshrc"), "# existing zshrc\n")

    const result = await runInstall({
      HOME: home,
      PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}`,
      SHELL: "/bin/zsh",
      MINIMAL_AGENT_HOME: agentHome,
      MINIMAL_AGENT_BIN_DIR: binDir,
      MINIMAL_AGENT_SRC: REPO_ROOT,
    })
    expect(result.code).toBe(0)
    expect(readlinkSync(join(home, ".local/bin/minimal-agent"))).toBe(
      join(REPO_ROOT, "minimal-agent"),
    )
    expect(readlinkSync(join(home, ".local/bin/ma"))).toBe(join(REPO_ROOT, "minimal-agent"))
    const zshrc = await Bun.file(join(home, ".zshrc")).text()
    expect(zshrc).toContain("# minimal-agent")
    expect(zshrc).toContain(binDir)
  })

  it("does not overwrite a foreign ~/.local/bin/ma file", async () => {
    scratch = mkdtempSync(join(tmpdir(), "ma-install-skip-"))
    const home = join(scratch, "home")
    const agentHome = join(home, ".minimal-agent")
    const binDir = join(agentHome, "bin")
    mkdirSync(join(home, ".local/bin"), { recursive: true })
    writeFileSync(join(home, ".local/bin/ma"), "#!/bin/sh\necho foreign\n")

    const result = await runInstall({
      HOME: home,
      PATH: `${join(home, ".local/bin")}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
      SHELL: "/bin/zsh",
      MINIMAL_AGENT_HOME: agentHome,
      MINIMAL_AGENT_BIN_DIR: binDir,
      MINIMAL_AGENT_SRC: REPO_ROOT,
    })
    expect(result.code).toBe(0)
    expect(await Bun.file(join(home, ".local/bin/ma")).text()).toContain("foreign")
    expect(result.stdout).toContain("skip")
    expect(readlinkSync(join(home, ".local/bin/minimal-agent"))).toBe(
      join(REPO_ROOT, "minimal-agent"),
    )
  })

  it("the linked wrapper runs with no node_modules in a clean tree", async () => {
    scratch = mkdtempSync(join(tmpdir(), "ma-install-clean-"))
    const home = join(scratch, "home")
    const agentHome = join(home, ".minimal-agent")
    const binDir = join(agentHome, "bin")
    const src = join(scratch, "src")
    mkdirSync(join(src, "src"), { recursive: true })
    writeFileSync(join(src, "src/index.ts"), `console.log("minimal-agent v0.0.0-test")\n`)
    writeWrapper(src)

    const result = await runInstall({
      HOME: home,
      MINIMAL_AGENT_HOME: agentHome,
      MINIMAL_AGENT_BIN_DIR: binDir,
      MINIMAL_AGENT_SRC: src,
      MINIMAL_AGENT_INSTALL_NO_PATH: "1",
    })
    expect(result.code).toBe(0)
    expect(existsSync(join(src, "node_modules"))).toBe(false)

    const help = Bun.spawn([join(binDir, "minimal-agent")], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(help.stdout).text(),
      new Response(help.stderr).text(),
    ])
    const code = (await help.exited) ?? 1
    expect(code).toBe(0)
    expect(stripAnsi(stdout + stderr)).toContain("minimal-agent v0.0.0-test")
  })

  it("clones a local git repo into $MINIMAL_AGENT_HOME/src", async () => {
    scratch = mkdtempSync(join(tmpdir(), "ma-install-clone-"))
    const home = join(scratch, "home")
    const agentHome = join(home, ".minimal-agent")
    const binDir = join(agentHome, "bin")
    const remote = join(scratch, "remote.git")
    mkdirSync(home, { recursive: true })
    mkdirSync(remote, { recursive: true })
    const env = gitIdentityEnv()
    await git(["init", "-b", "main"], remote, env)
    mkdirSync(join(remote, "src"), { recursive: true })
    writeFileSync(join(remote, "src/index.ts"), `console.log("cloned")\n`)
    writeWrapper(remote)
    await git(["add", "."], remote, env)
    await git(["commit", "-m", "init"], remote, env)

    const result = await runInstall({
      HOME: home,
      MINIMAL_AGENT_HOME: agentHome,
      MINIMAL_AGENT_BIN_DIR: binDir,
      MINIMAL_AGENT_REPO: remote,
      MINIMAL_AGENT_FORCE_CLONE: "1",
      MINIMAL_AGENT_INSTALL_NO_PATH: "1",
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("cloning")
    expect(existsSync(join(agentHome, "src", "src", "index.ts"))).toBe(true)
    expect(existsSync(join(agentHome, "src", "node_modules"))).toBe(false)
    expect(readlinkSync(join(binDir, "minimal-agent"))).toBe(
      join(agentHome, "src", "minimal-agent"),
    )
  })

  it("refuses to update a dirty clone", async () => {
    scratch = mkdtempSync(join(tmpdir(), "ma-install-dirty-"))
    const home = join(scratch, "home")
    const agentHome = join(home, ".minimal-agent")
    const binDir = join(agentHome, "bin")
    const remote = join(scratch, "remote.git")
    mkdirSync(home, { recursive: true })
    mkdirSync(remote, { recursive: true })
    const env = gitIdentityEnv()
    await git(["init", "-b", "main"], remote, env)
    mkdirSync(join(remote, "src"), { recursive: true })
    writeFileSync(join(remote, "src/index.ts"), `console.log("v1")\n`)
    writeWrapper(remote)
    await git(["add", "."], remote, env)
    await git(["commit", "-m", "init"], remote, env)

    const first = await runInstall({
      HOME: home,
      MINIMAL_AGENT_HOME: agentHome,
      MINIMAL_AGENT_BIN_DIR: binDir,
      MINIMAL_AGENT_REPO: remote,
      MINIMAL_AGENT_FORCE_CLONE: "1",
      MINIMAL_AGENT_INSTALL_NO_PATH: "1",
    })
    expect(first.code).toBe(0)
    writeFileSync(join(agentHome, "src", "src", "index.ts"), `console.log("dirty")\n`)

    const second = await runInstall({
      HOME: home,
      MINIMAL_AGENT_HOME: agentHome,
      MINIMAL_AGENT_BIN_DIR: binDir,
      MINIMAL_AGENT_REPO: remote,
      MINIMAL_AGENT_FORCE_CLONE: "1",
      MINIMAL_AGENT_INSTALL_NO_PATH: "1",
    })
    expect(second.code).not.toBe(0)
    expect(second.stderr).toContain("local changes")
  })
})
