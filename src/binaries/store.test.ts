import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { BinaryStore, classify, defaultBinDir, isArchive } from "./store.ts"
import type { BinarySpec, InstalledBinary, InstallProgress } from "./types.ts"

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** A fetch fake that returns fixed bytes with a streaming body. */
function fakeFetch(bytes: Uint8Array, status = 200): typeof fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    return new Response(status === 200 ? body : null, {
      status,
      headers: { "content-length": String(bytes.byteLength) },
    })
  }) as unknown as typeof fetch
}

describe("defaultBinDir", () => {
  // This is the value the host advertises to plugins as MINIMAL_AGENT_BIN_DIR
  // (see src/index.ts). Plugins resolve `<binDir>/<backend>` from it and must
  // never hard-code a home path of their own. Pinning the shape here guards the
  // host/plugin contract that fixed the ma-fetch "obscura on PATH" regression.
  it("is <home>/.minimal-agent/bin", () => {
    expect(defaultBinDir()).toBe(join(homedir(), ".minimal-agent", "bin"))
  })

  it("is an absolute path (plugins reject a relative bin dir)", () => {
    expect(defaultBinDir().startsWith("/")).toBe(true)
  })
})

describe("classify (pure)", () => {
  const spec: BinarySpec = {
    name: "obscura",
    version: "0.1.6",
    source: { kind: "url", url: "https://x/o.tar.gz" },
    sha256: "a".repeat(64),
  }
  it("missing when nothing installed", () => {
    expect(classify(spec, undefined)).toBe("missing")
  })
  it("satisfied when installed version >= spec", () => {
    const inst = rec("0.1.6")
    expect(classify(spec, inst)).toBe("satisfied")
    expect(classify(spec, rec("0.2.0"))).toBe("satisfied")
  })
  it("outdated when installed version < spec", () => {
    expect(classify(spec, rec("0.1.5"))).toBe("outdated")
  })
  it("unknown-version when no version recorded or unparseable", () => {
    expect(classify(spec, rec(null))).toBe("unknown-version")
    expect(classify(spec, rec("nightly"))).toBe("unknown-version")
  })
  function rec(version: string | null): InstalledBinary {
    return {
      name: "obscura",
      path: "/x/obscura",
      version,
      sha256: null,
      installedAt: "now",
      sourceUrl: null,
    }
  }
})

describe("isArchive", () => {
  it("recognizes archive extensions, ignoring query strings", () => {
    expect(isArchive("https://x/o.tar.gz")).toBe(true)
    expect(isArchive("https://x/o.tgz?token=1")).toBe(true)
    expect(isArchive("https://x/o.zip")).toBe(true)
    expect(isArchive("https://x/obscura")).toBe(false)
  })
})

describe("BinaryStore install/inventory", () => {
  let dir: string
  let store: BinaryStore
  let progress: InstallProgress[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-store-test-"))
    progress = []
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("installs a raw binary, verifies sha, records, becomes satisfied", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\necho hi\n")
    const spec: BinarySpec = {
      name: "obscura",
      version: "0.1.6",
      source: { kind: "url", url: "https://dist.example/obscura-aarch64-linux" }, // not an archive
      sha256: sha256(bytes),
    }
    store = new BinaryStore(join(dir, "bin"), {
      fetchFn: fakeFetch(bytes),
      onProgress: (p) => progress.push(p),
    })

    expect(store.status(spec)).toBe("missing")
    const out = await store.install(spec)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.action).toBe("installed")

    // File present + executable + correct bytes.
    expect(existsSync(out.installed.path)).toBe(true)
    expect(readFileSync(out.installed.path)).toEqual(Buffer.from(bytes))
    const mode = statSync(out.installed.path).mode & 0o777
    expect(mode & 0o100).toBeTruthy() // owner-exec bit

    // Inventory now satisfied; survives a fresh store instance (manifest read).
    expect(store.status(spec)).toBe("satisfied")
    const fresh = new BinaryStore(join(dir, "bin"))
    expect(fresh.has("obscura")).toBe(true)
    expect(fresh.inventory().get("obscura")?.version).toBe("0.1.6")

    // Progress reached "done".
    expect(progress.at(-1)?.phase).toBe("done")
  })

  it("rejects a sha mismatch and writes nothing", async () => {
    const bytes = new TextEncoder().encode("payload")
    const spec: BinarySpec = {
      name: "obscura",
      version: "0.1.6",
      source: { kind: "url", url: "https://dist.example/obscura" },
      sha256: "b".repeat(64), // wrong
    }
    store = new BinaryStore(join(dir, "bin"), { fetchFn: fakeFetch(bytes) })
    const out = await store.install(spec)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.kind).toBe("sha-mismatch")
    expect(store.has("obscura")).toBe(false)
    expect(existsSync(join(dir, "bin", "obscura"))).toBe(false)
  })

  it("reports outdated then updates to a newer version", async () => {
    const v1 = new TextEncoder().encode("v1")
    const v2 = new TextEncoder().encode("v2-newer")
    const binDir = join(dir, "bin")

    const s1 = new BinaryStore(binDir, { fetchFn: fakeFetch(v1) })
    await s1.install({
      name: "obscura",
      version: "0.1.6",
      source: { kind: "url", url: "https://x/o" },
      sha256: sha256(v1),
    })

    const newer: BinarySpec = {
      name: "obscura",
      version: "0.1.7",
      source: { kind: "url", url: "https://x/o2" },
      sha256: sha256(v2),
    }
    const s2 = new BinaryStore(binDir, { fetchFn: fakeFetch(v2) })
    expect(s2.status(newer)).toBe("outdated")
    const out = await s2.install(newer)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.action).toBe("updated")
    expect(out.installed.version).toBe("0.1.7")
    expect(readFileSync(out.installed.path)).toEqual(Buffer.from(v2))
  })

  it("download failure (non-200) is encoded, not thrown", async () => {
    const spec: BinarySpec = {
      name: "obscura",
      version: "0.1.6",
      source: { kind: "url", url: "https://x/o" },
      sha256: "a".repeat(64),
    }
    store = new BinaryStore(join(dir, "bin"), {
      fetchFn: fakeFetch(new Uint8Array(), 404),
    })
    const out = await store.install(spec)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.kind).toBe("download-failed")
  })

  it("rejects an invalid spec name / sha shape", async () => {
    store = new BinaryStore(join(dir, "bin"), { fetchFn: fakeFetch(new Uint8Array()) })
    const bad1 = await store.install({
      name: "../evil",
      version: "1",
      source: { kind: "url", url: "https://x/o" },
      sha256: "a".repeat(64),
    })
    expect(bad1.ok).toBe(false)
    const bad2 = await store.install({
      name: "obscura",
      version: "1",
      source: { kind: "url", url: "https://x/o" },
      sha256: "nothex",
    })
    expect(bad2.ok).toBe(false)
  })

  it("extracts a member from a tar.gz archive via injected extractor", async () => {
    const archiveBytes = new TextEncoder().encode("fake-archive")
    const spec: BinarySpec = {
      name: "obscura",
      version: "0.1.6",
      source: { kind: "url", url: "https://dist.example/obscura-aarch64-linux.tar.gz" },
      sha256: sha256(archiveBytes),
      archiveMember: "obscura",
    }
    store = new BinaryStore(join(dir, "bin"), {
      fetchFn: fakeFetch(archiveBytes),
      // Fake extractor drops a file named "obscura" into destDir.
      extractFn: async (_archivePath, destDir) => {
        const { writeFileSync, mkdirSync } = await import("node:fs")
        mkdirSync(join(destDir, "nested"), { recursive: true })
        writeFileSync(join(destDir, "nested", "obscura"), "real-binary-bytes")
      },
    })
    const out = await store.install(spec)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(readFileSync(out.installed.path, "utf8")).toBe("real-binary-bytes")
  })

  it("remove deletes the file + manifest record", async () => {
    const bytes = new TextEncoder().encode("x")
    const binDir = join(dir, "bin")
    store = new BinaryStore(binDir, { fetchFn: fakeFetch(bytes) })
    await store.install({
      name: "obscura",
      version: "1",
      source: { kind: "url", url: "https://x/o" },
      sha256: sha256(bytes),
    })
    expect(store.has("obscura")).toBe(true)
    expect(store.remove("obscura")).toBe(true)
    expect(store.has("obscura")).toBe(false)
    expect(existsSync(join(binDir, "obscura"))).toBe(false)
  })
})

describe("BinaryStore github-release source", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-store-gh-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Fake fetch that emulates the 2-step GitHub flow:
   *   1. GET /releases/tags/<tag>  → JSON with assets[]
   *   2. GET /releases/assets/<id> → the bytes (only when bearer present)
   */
  function ghFetch(opts: { bytes: Uint8Array; asset: string; expectToken: string }): {
    fn: typeof fetch
    seen: { tokens: string[] }
  } {
    const seen = { tokens: [] as string[] }
    const fn = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ""
      if (auth) seen.tokens.push(auth)
      if (url.includes("/releases/tags/")) {
        return new Response(JSON.stringify({ assets: [{ id: 4242, name: opts.asset }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/releases/assets/4242")) {
        if (auth !== `Bearer ${opts.expectToken}`) {
          return new Response(null, { status: 404 })
        }
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(opts.bytes)
            c.close()
          },
        })
        return new Response(body, {
          status: 200,
          headers: { "content-length": String(opts.bytes.byteLength) },
        })
      }
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    return { fn, seen }
  }

  it("installs from a private release using the EMBEDDED token (no host token)", async () => {
    const bytes = new TextEncoder().encode("private-binary")
    const asset = "obscura-aarch64-macos-1780598942.tar.gz"
    const { fn } = ghFetch({ bytes, asset, expectToken: "embedded_pat" })
    // Capture every diagnostic the store emits so we can assert the token
    // never reaches a log line.
    const logged: string[] = []
    // extractFn fakes the archive → drops the member.
    const store = new BinaryStore(join(dir, "bin"), {
      fetchFn: fn,
      // Host provider returns null → proves the embedded token is what works.
      tokenProvider: async () => null,
      log: (sev, src, msg, sd) => logged.push(`${sev} ${src} ${msg} ${JSON.stringify(sd ?? {})}`),
      extractFn: async (_a, destDir) => {
        const { writeFileSync } = await import("node:fs")
        writeFileSync(join(destDir, "obscura"), "real")
      },
    })
    const spec: BinarySpec = {
      name: "obscura",
      version: "1780598942",
      source: {
        kind: "github-release",
        repo: "gastonmorixe/obscura-dist",
        tag: "build-1780598942",
        asset,
        token: "embedded_pat",
      },
      sha256: sha256(bytes),
      archiveMember: "obscura",
    }
    const out = await store.install(spec)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(readFileSync(out.installed.path, "utf8")).toBe("real")
    // Manifest records the human label, never the token.
    expect(out.installed.sourceUrl).toBe("gastonmorixe/obscura-dist@build-1780598942/" + asset)
    const raw = readFileSync(join(dir, "bin", ".binaries.json"), "utf8")
    expect(raw).not.toContain("embedded_pat")
    // Token must never reach any diagnostic line either.
    expect(logged.join("\n")).not.toContain("embedded_pat")
    expect(logged.length).toBeGreaterThan(0) // it DID log (the install line)
  })

  it("falls back to the host tokenProvider when no embedded token", async () => {
    const bytes = new TextEncoder().encode("x")
    const asset = "obscura-x.tar.gz"
    const { fn } = ghFetch({ bytes, asset, expectToken: "host_token" })
    const store = new BinaryStore(join(dir, "bin"), {
      fetchFn: fn,
      tokenProvider: async () => "host_token",
      extractFn: async (_a, d) => {
        const { writeFileSync } = await import("node:fs")
        writeFileSync(join(d, "obscura"), "ok")
      },
    })
    const out = await store.install({
      name: "obscura",
      version: "1",
      source: { kind: "github-release", repo: "o/d", tag: "t", asset },
      sha256: sha256(bytes),
      archiveMember: "obscura",
    })
    expect(out.ok).toBe(true)
  })

  it("fails clean when neither embedded nor host token is available", async () => {
    const { fn } = ghFetch({ bytes: new Uint8Array(), asset: "a", expectToken: "nope" })
    const store = new BinaryStore(join(dir, "bin"), {
      fetchFn: fn,
      tokenProvider: async () => null,
    })
    const out = await store.install({
      name: "obscura",
      version: "1",
      source: { kind: "github-release", repo: "o/d", tag: "t", asset: "a" },
      sha256: "a".repeat(64),
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.kind).toBe("download-failed")
    expect(out.detail).toContain("no GitHub token")
  })
})
