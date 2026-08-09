import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { SessionStore } from "../session/session-store.ts"

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
}

function createHomeWithSession(sid: string): string {
  const home = mkdtempSync(join(tmpdir(), "ma-dump-e2e-"))
  const sessionsDir = join(home, ".minimal-agent", "sessions")
  const store = SessionStore.open({
    sid,
    model: "test-model-1",
    cwd: process.cwd(),
    systemHash: "sys-hash",
    toolsHash: "tools-hash",
    agentVersion: "test",
    dir: sessionsDir,
  })
  store.appendUser("hello")
  store.appendAssistant([{ type: "text", text: "world" }], "end_turn")
  return home
}

describe("dump command architecture", () => {
  it("writes clean dump output without startup/auth stderr noise", async () => {
    const sid = "dump-clean-sid"
    const home = createHomeWithSession(sid)

    try {
      const p = Bun.spawn(["bun", "run", "src/index.ts", "--dump", sid], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
          // Clear any inherited MINIMAL_AGENT_HOME (the running harness sets it),
          // else it wins over HOME in resolveAgentHome and the spawned CLI reads
          // the real ~/.minimal-agent instead of this test's tmp home.
          MINIMAL_AGENT_HOME: join(home, ".minimal-agent"),
        },
      })
      const [code, stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])

      expect(code).toBe(0)
      expect(stdout).toContain(`# Session: ${sid}`)
      expect(stderr.trim()).toBe("")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("--dump-paths prints computed artifact paths before the transcript", async () => {
    const sid = "dump-paths-sid"
    const home = createHomeWithSession(sid)
    try {
      const p = Bun.spawn(["bun", "run", "src/index.ts", "--dump", sid, "--dump-paths"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home, MINIMAL_AGENT_HOME: join(home, ".minimal-agent") },
      })
      const [code, stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])
      expect(code).toBe(0)
      expect(stderr.trim()).toBe("")
      expect(stdout).toContain(`Session artifacts for ${sid}`)
      expect(stdout).toContain(join(home, ".minimal-agent", "sessions", `${sid}.jsonl`))
      expect(stdout).toContain(`# Session: ${sid}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("handles downstream pipe close without broken-pipe noise", async () => {
    const sid = "dump-pipe-sid"
    const home = createHomeWithSession(sid)

    try {
      const p = Bun.spawn(
        [
          "bash",
          "-lc",
          `set -o pipefail; bun run src/index.ts --dump ${sid} | head -n 3 >/dev/null`,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: home,
            // Clear inherited MINIMAL_AGENT_HOME (see note above); else it wins
            // over HOME and the spawned CLI reads the real ~/.minimal-agent.
            MINIMAL_AGENT_HOME: join(home, ".minimal-agent"),
          },
        },
      )
      const [code, stderr] = await Promise.all([p.exited, readStream(p.stderr)])

      expect(code).toBe(0)
      expect(stderr).not.toContain("EPIPE")
      expect(stderr.toLowerCase()).not.toContain("broken pipe")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("--sessions runs without startup/auth stderr noise", async () => {
    const home = mkdtempSync(join(tmpdir(), "ma-sessions-e2e-"))
    try {
      const p = Bun.spawn(["bun", "run", "src/index.ts", "--sessions"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
          // Clear any inherited MINIMAL_AGENT_HOME (the running harness sets it),
          // else it wins over HOME in resolveAgentHome and the spawned CLI reads
          // the real ~/.minimal-agent instead of this test's tmp home.
          MINIMAL_AGENT_HOME: join(home, ".minimal-agent"),
        },
      })
      const [code, stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])

      expect(code).toBe(0)
      expect(stdout).toContain("no saved sessions yet")
      expect(stderr.trim()).toBe("")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("`sessions <query>` fuzzy-filters by sid / cwd, shows a size column", async () => {
    // Set up two sessions in distinct cwds so the filter has a real
    // discrimination to make.
    const home = mkdtempSync(join(tmpdir(), "ma-sessions-filter-e2e-"))
    const sessionsDir = join(home, ".minimal-agent", "sessions")
    const storeA = SessionStore.open({
      sid: "aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      model: "test-model-1",
      cwd: "/tmp/project-alpha",
      systemHash: "sys",
      toolsHash: "tools",
      agentVersion: "test",
      dir: sessionsDir,
    })
    storeA.appendUser("alpha prompt")
    storeA.appendAssistant([{ type: "text", text: "alpha response" }], "end_turn")
    const storeB = SessionStore.open({
      sid: "bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      model: "test-model-1",
      cwd: "/tmp/project-beta",
      systemHash: "sys",
      toolsHash: "tools",
      agentVersion: "test",
      dir: sessionsDir,
    })
    storeB.appendUser("beta prompt")
    storeB.appendAssistant([{ type: "text", text: "beta response" }], "end_turn")

    try {
      // Subcommand form: `sessions alpha` (no leading flag).
      const p = Bun.spawn(["bun", "run", "src/index.ts", "sessions", "alpha"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home, MINIMAL_AGENT_HOME: join(home, ".minimal-agent") },
      })
      const [code, stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])

      expect(code).toBe(0)
      expect(stderr.trim()).toBe("")
      // Header has a `size` column.
      expect(stdout).toContain("size")
      // Alpha matches; Beta doesn't.
      expect(stdout).toContain("aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
      expect(stdout).not.toContain("bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
      // Footer reports the filtered count and the query.
      expect(stdout).toContain("1 of 2 session(s) matching")
      expect(stdout).toContain('"alpha"')
      // Size column rendered (non-empty session file).
      expect(stdout).toMatch(/\d+\s+B/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("--dump with a short unique prefix resolves the sid", async () => {
    // Use a sid with a long, distinctive prefix. The short "ea3" prefix is
    // unique across the sessions in this test's home directory.
    const sid = "ea3f1a2b-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    const home = createHomeWithSession(sid)

    try {
      const p = Bun.spawn(["bun", "run", "src/index.ts", "--dump", "ea3"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
          MINIMAL_AGENT_HOME: join(home, ".minimal-agent"),
        },
      })
      const [code, stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])

      expect(code).toBe(0)
      expect(stdout).toContain(`# Session: ${sid}`)
      expect(stderr.trim()).toBe("")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("--dump with an ambiguous prefix exits with error", async () => {
    const home = mkdtempSync(join(tmpdir(), "ma-dump-ambig-e2e-"))
    const sessionsDir = join(home, ".minimal-agent", "sessions")
    const storeA = SessionStore.open({
      sid: "ambig-a-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      model: "test",
      cwd: process.cwd(),
      systemHash: "sys",
      toolsHash: "tools",
      agentVersion: "test",
      dir: sessionsDir,
    })
    storeA.appendUser("hello a")
    storeA.appendAssistant([{ type: "text", text: "world a" }], "end_turn")
    const storeB = SessionStore.open({
      sid: "ambig-b-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      model: "test",
      cwd: process.cwd(),
      systemHash: "sys",
      toolsHash: "tools",
      agentVersion: "test",
      dir: sessionsDir,
    })
    storeB.appendUser("hello b")
    storeB.appendAssistant([{ type: "text", text: "world b" }], "end_turn")

    try {
      const p = Bun.spawn(["bun", "run", "src/index.ts", "--dump", "ambig"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: home,
          MINIMAL_AGENT_HOME: join(home, ".minimal-agent"),
        },
      })
      const [code, _stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])

      expect(code).toBe(1)
      expect(stderr).toMatch(/no saved sessions found|ambiguous/i)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("`sessions resume <sid>` rewrites to --resume <sid> (parser plumbing)", async () => {
    // The cli-args unit tests pin the exact rewrite. This e2e proves
    // the wiring downstream: when we hand the CLI `sessions resume
    // <sid>`, it routes through the `run` command (which requires
    // auth) rather than the `sessions` listing (which does not).
    //
    // Signal: a credential-less spawn should fail with the auth-not-
    // found fatal, NOT print the sessions table header.
    const home = mkdtempSync(join(tmpdir(), "ma-sessions-resume-e2e-"))
    try {
      const p = Bun.spawn(
        ["bun", "run", "src/index.ts", "sessions", "resume", "no-such-sid", "--prompt", "noop"],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: home, MINIMAL_AGENT_HOME: join(home, ".minimal-agent") },
        },
      )
      const [_code, stdout, stderr] = await Promise.all([
        p.exited,
        readStream(p.stdout),
        readStream(p.stderr),
      ])
      // Routed to `run` (auth-required) → no-auth fatal fires.
      // (If the parser had collapsed to `--sessions`, the listing
      // would have printed cleanly with no auth check.)
      const combined = `${stdout}\n${stderr}`
      expect(combined).toMatch(/credentials|minimal-agent --login|fatal/i)
      // Listing header MUST NOT appear.
      expect(stdout).not.toContain("when")
      expect(stdout).not.toContain("preview")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
