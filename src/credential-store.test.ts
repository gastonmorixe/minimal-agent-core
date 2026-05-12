import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FileBackend,
  KeychainBackend,
  defaultCredentialsFilePath,
  pickCredentialStore,
  resetDefaultCredentialStore,
} from "./credential-store.ts"

describe("FileBackend", () => {
  let tmpDir: string
  let credsPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "minagent-creds-"))
    credsPath = join(tmpDir, ".claude", ".credentials.json")
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  it("returns null when the file does not exist", () => {
    const backend = new FileBackend(credsPath)
    expect(backend.read()).toBeNull()
  })

  it("returns null when the file is empty", () => {
    const backend = new FileBackend(credsPath)
    backend.write({ claudeAiOauth: { accessToken: "AT" } })
    writeFileSync(credsPath, "")
    expect(backend.read()).toBeNull()
  })

  it("returns null when the file contains malformed JSON", () => {
    const backend = new FileBackend(credsPath)
    backend.write({ claudeAiOauth: { accessToken: "AT" } })
    writeFileSync(credsPath, "{not json")
    expect(backend.read()).toBeNull()
  })

  it("round-trips claudeAiOauth fields", () => {
    const backend = new FileBackend(credsPath)
    const data = {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-AT",
        refreshToken: "sk-ant-ort01-RT",
        expiresAt: 1700000000000,
        scopes: ["user:profile", "user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    }
    backend.write(data)
    expect(backend.read()).toEqual(data)
  })

  it("creates the parent directory if it does not exist", () => {
    const backend = new FileBackend(credsPath)
    expect(existsSync(join(tmpDir, ".claude"))).toBe(false)
    backend.write({ claudeAiOauth: { accessToken: "AT" } })
    expect(existsSync(credsPath)).toBe(true)
  })

  it("writes the file with mode 0600 so other users cannot read tokens", () => {
    const backend = new FileBackend(credsPath)
    backend.write({ claudeAiOauth: { accessToken: "AT" } })
    const mode = statSync(credsPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("delete returns false when there is no file to remove (idempotent)", () => {
    const backend = new FileBackend(credsPath)
    expect(backend.delete()).toBe(false)
    expect(backend.delete()).toBe(false)
  })

  it("delete returns true after removing an existing file", () => {
    const backend = new FileBackend(credsPath)
    backend.write({ claudeAiOauth: { accessToken: "AT" } })
    expect(backend.delete()).toBe(true)
    expect(existsSync(credsPath)).toBe(false)
    // Second delete should be a no-op.
    expect(backend.delete()).toBe(false)
  })

  it("defaults to ~/.claude/.credentials.json under $HOME", () => {
    const path = defaultCredentialsFilePath("/home/example")
    expect(path).toBe("/home/example/.claude/.credentials.json")
  })
})

describe("pickCredentialStore", () => {
  const prevPlatform = process.platform
  const prevOverride = process.env.MINIMAL_AGENT_CREDENTIAL_STORE

  afterEach(() => {
    // Restore env and platform after each test so we don't poison siblings.
    Object.defineProperty(process, "platform", { value: prevPlatform })
    if (prevOverride === undefined) {
      delete process.env.MINIMAL_AGENT_CREDENTIAL_STORE
    } else {
      process.env.MINIMAL_AGENT_CREDENTIAL_STORE = prevOverride
    }
    resetDefaultCredentialStore()
  })

  it("returns the keychain backend on darwin by default", () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    delete process.env.MINIMAL_AGENT_CREDENTIAL_STORE
    expect(pickCredentialStore()).toBeInstanceOf(KeychainBackend)
  })

  it("returns the file backend on linux by default", () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    delete process.env.MINIMAL_AGENT_CREDENTIAL_STORE
    expect(pickCredentialStore()).toBeInstanceOf(FileBackend)
  })

  it("returns the file backend on other platforms by default", () => {
    Object.defineProperty(process, "platform", { value: "freebsd" })
    delete process.env.MINIMAL_AGENT_CREDENTIAL_STORE
    expect(pickCredentialStore()).toBeInstanceOf(FileBackend)
  })

  it("env override 'file' forces the file backend on darwin", () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    process.env.MINIMAL_AGENT_CREDENTIAL_STORE = "file"
    expect(pickCredentialStore()).toBeInstanceOf(FileBackend)
  })

  it("env override 'keychain' forces the keychain backend on linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    process.env.MINIMAL_AGENT_CREDENTIAL_STORE = "keychain"
    expect(pickCredentialStore()).toBeInstanceOf(KeychainBackend)
  })

  it("ignores unrecognized env overrides and falls back to platform default", () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    process.env.MINIMAL_AGENT_CREDENTIAL_STORE = "nonsense"
    expect(pickCredentialStore()).toBeInstanceOf(FileBackend)
  })
})
