/**
 * Auto-formatter resolver for mdstream.
 *
 * When no `--formatter` flag is given and `mdstream` is not already on PATH,
 * this module tries to download the latest release from GitHub and cache it
 * at `~/.minimal-agent/bin/mdstream`.
 *
 * **Resolution order (no `--formatter` flag)**:
 * 1. `mdstream` found on PATH → use it
 * 2. `~/.minimal-agent/bin/mdstream` exists (previously downloaded) → use it
 * 3. Auto-download from `gastonmorixe/mdstream` releases
 *    - Determine the right asset for the current OS + arch
 *    - If no suitable asset exists → return a warning, no formatter
 *    - Download tarball, extract binary, install to `~/.minimal-agent/bin/`
 *
 * @module ui/formatter/auto
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { ansiStyle as A } from "@minimal-agent/plugin-api/utils/ansi"

import { startStartupProgressSpinner } from "../startup/progress-spinner.ts"

const RELEASES_API = "https://api.github.com/repos/gastonmorixe/mdstream/releases/latest"

/** Result of {@link resolveFormatter}. */
export type FormatterResolution =
  | {
      /** argv to pass to `Formatter` / `runRepl`. */
      cmd: string[]
      /** Human-readable label for the startup row. */
      label: string
      warn?: never
    }
  | {
      cmd: undefined
      label?: never
      /** Warning to print to stderr when auto-download wasn't possible. */
      warn: string
    }

/**
 * Map Node's `process.platform` + `process.arch` to the naming scheme used
 * by mdstream release assets: `mdstream-{os}-{arch}.tar.gz`.
 *
 * Returns `null` when the current platform has no known asset.
 */
function assetName(): string | null {
  const osMap: Record<string, string> = {
    darwin: "macos",
    linux: "linux",
  }
  const archMap: Record<string, string> = {
    arm64: "aarch64",
    x64: "x86_64",
  }

  const os = osMap[process.platform]
  const arch = archMap[process.arch]
  if (!os || !arch) return null
  return `mdstream-${os}-${arch}.tar.gz`
}

// ---------------------------------------------------------------------------
// Formatter resolution
// ---------------------------------------------------------------------------

/**
 * Run `<cmd> --version` and extract the version string (e.g. `"v0.2.1"`).
 * Returns `null` on any error so callers can degrade gracefully.
 */
async function queryMdstreamVersion(cmd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([cmd, "--version"], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    if (proc.exitCode !== 0) return null
    const out = (await new Response(proc.stdout).text()).trim()
    // Expected format: "mdstream 0.2.1"
    const match = out.match(/\S+\s+(\S+)/)
    if (!match) return null
    const ver = match[1]!
    return ver.startsWith("v") ? ver : `v${ver}`
  } catch {
    return null
  }
}

/**
 * Resolve the formatter command, auto-downloading mdstream if necessary.
 *
 * @param explicitCmd - Parsed argv when `--formatter <cmd>` was supplied.
 *   When present the function returns immediately with that command (no
 *   download attempted).
 */
export async function resolveFormatter(explicitCmd?: string[]): Promise<FormatterResolution> {
  // Explicit --formatter flag: trust the user and use as-is.
  if (explicitCmd && explicitCmd.length > 0) {
    return { cmd: explicitCmd, label: explicitCmd.join(" ") }
  }

  // 1. mdstream on PATH
  if (Bun.which("mdstream")) {
    const ver = await queryMdstreamVersion("mdstream")
    const verLabel = ver ? ` ${A.sky(ver)}` : ""
    return { cmd: ["mdstream"], label: `mdstream${verLabel}` }
  }

  // 2. Previously downloaded binary
  const binDir = join(process.env.HOME ?? "~", ".minimal-agent", "bin")
  const cachedBin = join(binDir, "mdstream")
  if (existsSync(cachedBin)) {
    const ver = await queryMdstreamVersion(cachedBin)
    const verLabel = ver ? ` ${A.sky(ver)}` : ""
    return { cmd: [cachedBin], label: `mdstream${verLabel} ${A.dim("(cached)")}` }
  }

  // 3. Auto-download
  const target = assetName()
  if (!target) {
    return {
      cmd: undefined,
      warn:
        `no mdstream release for ${process.platform}/${process.arch}. ` +
        `Install it manually or use ${A.bold("--formatter <cmd>")} to specify a formatter.`,
    }
  }

  // ── Phase 1: fetch release metadata ──────────────────────────────────────
  const platformLabel = A.dim(`${process.platform} · ${process.arch}`)
  const spinner = startStartupProgressSpinner(
    `${A.dim("fetching")}  ${A.bold("mdstream")} release info  ${platformLabel}`,
  )

  let downloadUrl: string
  let version: string
  try {
    const res = await fetch(RELEASES_API, {
      headers: { "User-Agent": "minimal-agent/auto-formatter" },
    })
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`)
    const data = (await res.json()) as {
      tag_name: string
      assets: Array<{ name: string; browser_download_url: string }>
    }
    version = data.tag_name ?? "unknown"
    const asset = data.assets?.find((a) => a.name === target)
    if (!asset) {
      spinner.fail(
        `no release asset for ${process.platform}/${process.arch} ` +
          `(looked for ${A.dim(`"${target}"`)} in ${A.dim(version)})`,
      )
      return {
        cmd: undefined,
        warn:
          `no mdstream release asset found for ${process.platform}/${process.arch} ` +
          `(looked for "${target}" in ${version}). ` +
          `Use ${A.bold("--formatter <cmd>")} to specify a formatter.`,
      }
    }
    downloadUrl = asset.browser_download_url
  } catch (err) {
    spinner.fail(
      `could not fetch release info: ${A.dim(err instanceof Error ? err.message : String(err))}`,
    )
    return {
      cmd: undefined,
      warn:
        `could not fetch mdstream release info: ${err instanceof Error ? err.message : String(err)}. ` +
        `Use ${A.bold("--formatter <cmd>")} to specify a formatter.`,
    }
  }

  // ── Phase 2: download tarball ─────────────────────────────────────────────
  const versionLabel = A.sky(version)
  spinner.setPhase(
    `${A.dim("downloading")}  ${A.bold("mdstream")} ${versionLabel}  ${platformLabel}`,
  )

  let tarball: ArrayBuffer
  try {
    const res = await fetch(downloadUrl)
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    tarball = await res.arrayBuffer()
  } catch (err) {
    spinner.fail(`download failed: ${A.dim(err instanceof Error ? err.message : String(err))}`)
    return {
      cmd: undefined,
      warn:
        `could not download mdstream: ${err instanceof Error ? err.message : String(err)}. ` +
        `Use ${A.bold("--formatter <cmd>")} to specify a formatter.`,
    }
  }

  // ── Phase 3: extract & install ────────────────────────────────────────────
  spinner.setPhase(
    `${A.dim("installing")}  ${A.bold("mdstream")} ${versionLabel}  ${platformLabel}`,
  )

  try {
    mkdirSync(binDir, { recursive: true })

    const tmpTar = join(binDir, `_mdstream-download.tar.gz`)
    const tmpExtract = join(binDir, `_mdstream-extract`)
    await Bun.write(tmpTar, tarball)

    // Extract into a temp dir
    mkdirSync(tmpExtract, { recursive: true })
    const tar = Bun.spawn(["tar", "-xzf", tmpTar, "-C", tmpExtract], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await tar.exited
    if (tar.exitCode !== 0) {
      throw new Error(`tar exited with code ${tar.exitCode}`)
    }

    // Find the mdstream binary in the extracted tree
    const find = Bun.spawn(["find", tmpExtract, "-type", "f", "-name", "mdstream"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await find.exited
    const found = (await new Response(find.stdout).text()).trim().split("\n").filter(Boolean)
    if (found.length === 0) {
      throw new Error("mdstream binary not found in the downloaded archive")
    }
    const extractedBin = found[0]

    // Copy to the cache location
    const cp = Bun.spawn(["cp", extractedBin, cachedBin], { stdout: "pipe", stderr: "pipe" })
    await cp.exited
    if (cp.exitCode !== 0) throw new Error(`cp exited with code ${cp.exitCode}`)
    chmodSync(cachedBin, 0o755)

    // Cleanup temp files (best-effort)
    try {
      Bun.spawn(["rm", "-rf", tmpTar, tmpExtract])
    } catch {
      // ignore
    }
  } catch (err) {
    spinner.fail(`install failed: ${A.dim(err instanceof Error ? err.message : String(err))}`)
    return {
      cmd: undefined,
      warn:
        `could not install mdstream: ${err instanceof Error ? err.message : String(err)}. ` +
        `Use ${A.bold("--formatter <cmd>")} to specify a formatter.`,
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  spinner.done(
    `${A.bold("mdstream")} ${A.sky(version)}  ${A.dim("installed")}  ${A.faintWhite("→")}  ${A.dim(cachedBin)}`,
  )

  return {
    cmd: [cachedBin],
    label: `mdstream ${version} ${A.dim("(auto-downloaded)")}`,
  }
}
