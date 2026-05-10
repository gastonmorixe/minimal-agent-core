import { describe, it, expect } from "bun:test"

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
}

describe("CLI smoke", () => {
  it("prints help within budget without auth or network", async () => {
    const t0 = performance.now()
    const p = Bun.spawn(["bun", "run", "src/index.ts", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    })
    await p.exited
    expect(performance.now() - t0).toBeLessThan(2000)
  })

  it("starts, sends a one-shot prompt, and exits without external network", async () => {
    const p = Bun.spawn(
      [
        "bun",
        "run",
        "src/index.ts",
        "--model",
        "claude-opus-4-7[1m]",
        "--skip-quota",
        // Force the startup tree on so the assertions below can verify
        // its contents — non-interactive mode hides it by default.
        "--header",
        "--prompt",
        "Reply with exactly: PONG",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
        env: {
          ...process.env,
          NODE_ENV: "test",
          MINIMAL_AGENT_TEST_AUTH: "1",
          MINIMAL_AGENT_TRANSPORT: "test",
          MINIMAL_AGENT_TEST_RESPONSE: "PONG",
        },
      },
    )

    const [exitCode, stdout, stderr] = await Promise.all([
      p.exited,
      readStream(p.stdout),
      readStream(p.stderr),
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("PONG")
    expect(stderr).toContain("minimal-agent")
    expect(stderr).toContain("oauth")
    expect(stderr).toContain("claude-opus-4-7[1m]")
    expect(stderr).not.toContain("cache anomaly")
    // Non-interactive defaults: ASK mode is auto-applied. The mode row
    // is only printed when the header is shown — which it is here via
    // `--header` — so verifying it pins both behaviors at once. ANSI
    // color codes sit between the "mode" label and the "ASK" value, so
    // strip them before matching.
    //
    // Asserts on `ASK` (the manifest's `label`), not `ask` (the lowercase
    // id) — the startup row aligns with the prompt prefix the user sees
    // a moment later (`ASK ❯ `). See `src/index.ts` mode-row site.
    const stderrPlain = stderr.replace(/\u001b\[[0-9;]*m/g, "")
    expect(stderrPlain).toMatch(/mode\s+ASK/)
  })

  it("hides the startup tree by default in non-interactive mode", async () => {
    const p = Bun.spawn(
      [
        "bun",
        "run",
        "src/index.ts",
        "--model",
        "claude-opus-4-7[1m]",
        "--skip-quota",
        "--prompt",
        "Reply with exactly: PONG",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
        env: {
          ...process.env,
          NODE_ENV: "test",
          MINIMAL_AGENT_TEST_AUTH: "1",
          MINIMAL_AGENT_TRANSPORT: "test",
          MINIMAL_AGENT_TEST_RESPONSE: "PONG",
        },
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      p.exited,
      readStream(p.stdout),
      readStream(p.stderr),
    ])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("PONG")
    // Banner / tree rows are suppressed by default in non-interactive.
    expect(stderr).not.toContain("minimal-agent")
    expect(stderr).not.toMatch(/^\s*│/m)
    expect(stderr).not.toMatch(/^\s*╭/m)
  })
})
